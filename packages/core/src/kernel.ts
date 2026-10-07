import type {
  CommandContext,
  ConfigStore,
  HookContext,
  HookName,
  HookOutcome,
  Logger,
  PluginDefinition,
} from '@fxdevkit/sdk'
import {
  type FxDevkitConfig,
  isPluginEnabled,
  loadConfig,
  pluginConfig,
  writeUserConfig,
} from './config.js'
import {
  consumeAmendState,
  detectGitContext,
  findRepoRoot,
  isAmendInvocation,
  markAmendState,
} from './git.js'
import { type Emitter, type EmitterScope, EventBus, createEmitter, createSilentEmitter } from './events.js'
import { CORE, EV_HANDLED, EV_SKIPPED, SKIP_REASONS } from './trace.js'
import {
  discoverPlugins,
  hasPermission,
  loadPlugin,
  permissionSet,
  selectPlugins,
} from './plugins.js'
import { isDirExcluded } from './exclude.js'
import { runRepoOwnHook } from './hooks.js'
import { createDeniedServer, createServerClient } from './server.js'
import { pluginScope } from './scope.js'
import { createCoreLogger, createPluginLogger } from './logger.js'

const TIMEOUT_MARK = '__timeout__' as const

async function withTimeout<T>(
  work: Promise<T> | T,
  ms: number,
): Promise<T | typeof TIMEOUT_MARK> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<typeof TIMEOUT_MARK>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_MARK), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([Promise.resolve(work), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 内核自己的事件发射器。
 *
 * 记的是「调度事实」：这次 hook 有没有真的增强、没增强是因为什么。
 * 与插件事件区分开：插件事件 plugin 是插件 id，内核事件一律是 CORE('core')，
 * 所以回溯时能一眼分开「插件干了什么」和「内核为什么没让它干」。
 *
 * telemetry 关闭时静默——落盘开关归用户，不因为要回溯就越权写文件。
 */
function coreEmitter(enabled: boolean, scope: EmitterScope): Emitter {
  return enabled ? createEmitter(CORE, scope) : createSilentEmitter()
}

/**
 * 派发一个 git hook 给所有声明了它的插件。
 *
 * 分层执行（参照配置分层的「项目级优先、用户级兜底」）：
 *   ① 仓库自有 hook（<repo>/.git/hooks/<name>）先跑 —— 全局 hooksPath 接管后
 *      git 不再执行它们，这里补执行，保证「不取缔、只追加」。失败即阻断。
 *   ② 本仓库是否启用了增强（总开关）—— 未启用则到此为止。
 *   ③ 插件派发 —— 再按作用目录（projects）过滤。
 *
 * 熔断原则：异常路径一律返回 0（放行）。只有以下两种情况返回 1：
 *   仓库自有 hook 执行失败，或插件显式返回 'reject'。
 */
export async function dispatchHook(hookName: HookName, args: string[]): Promise<number> {
  const logger = createCoreLogger()
  try {
    const cwd = process.cwd()
    const repoRoot = findRepoRoot(cwd)
    logger.info(`派发 ${hookName} · 仓库 ${repoRoot ?? '（非 git 仓库）'}`)

    // ① 项目级优先：仓库自有 hook。不存在则跳过（返回 null）
    if (repoRoot) {
      const ownCode = runRepoOwnHook(repoRoot, hookName, args)
      if (ownCode != null && ownCode !== 0) {
        logger.warn(`仓库自有 ${hookName} 返回非零，按 git 语义阻断`)
        return 1
      }
    }

    // ② 范围判定：命中 exclude（黑名单）的目录不被增强
    //    仓库自有 hook 已经执行过，不受影响
    if (!repoRoot) return 0

    const { config } = loadConfig()
    if (isDirExcluded(config, repoRoot)) {
      logger.info(`${repoRoot} 命中 exclude，放行`)
      // 目录被停用也要留痕：这是「某仓库一直没增强」最常见的原因，
      // 不记的话用户只能看到「最近一次增强停在很久以前」，却查不出是谁停的
      coreEmitter(config.telemetry.enabled, { repoRoot })(
        EV_SKIPPED,
        { hook: hookName, reason: SKIP_REASONS.excluded },
      )
      return 0
    }

    // amend 只能在 prepare-commit-msg 判定，这里落状态供 commit-msg 消费
    if (hookName === 'prepare-commit-msg') {
      if (repoRoot) markAmendState(repoRoot, isAmendInvocation(args))
      return 0
    }

    const isAmend = hookName === 'commit-msg' && repoRoot ? consumeAmendState(repoRoot) : false
    const git = detectGitContext(repoRoot ?? cwd, isAmend)

    const candidates = selectPlugins(discoverPlugins(repoRoot), hookName)
    logger.info(`声明 ${hookName} 的候选插件 ${candidates.length} 个`)
    let rejected = false

    // 派发级 emitter：带分支信息，跳过与生效都记它
    const emitCore = coreEmitter(config.telemetry.enabled, { repoRoot, branch: git.branch })
    const skip = (pluginId: string, reason: string): void => {
      emitCore(EV_SKIPPED, { hook: hookName, pluginId, reason })
    }

    for (const discovered of candidates) {
      if (discovered.skipped) {
        logger.warn(`[${discovered.id}] 已跳过：${discovered.skipped}`)
        skip(discovered.id, SKIP_REASONS.invalid)
        continue
      }
      if (!isPluginEnabled(config, discovered.id)) {
        skip(discovered.id, SKIP_REASONS.disabled)
        continue
      }

      // 作用目录判定：插件未配 projects 时全局生效，配了则只在该目录（含子目录）下加载
      const scope = pluginScope(config, discovered.id, repoRoot)
      if (!scope.inScope) {
        logger.debug(`[${discovered.id}] ${scope.reason}，已跳过`)
        skip(discovered.id, SKIP_REASONS.outOfScope)
        continue
      }

      const definition: PluginDefinition<any> | null = await loadPlugin(discovered)
      if (!definition) {
        logger.warn(`[${discovered.id}] 加载失败，已跳过`)
        skip(discovered.id, SKIP_REASONS.loadFailed)
        continue
      }

      const handler = definition.hooks?.[hookName]
      if (!handler) continue
      logger.info(`[${discovered.id}] 执行 ${hookName}`)

      let pluginConfigValue: unknown
      try {
        const raw = { ...((definition.defaultConfig ?? {}) as object), ...pluginConfig(config, discovered.id) }
        pluginConfigValue = definition.validateConfig ? definition.validateConfig(raw) : raw
      } catch (error) {
        logger.warn(`[${discovered.id}] 配置非法，已跳过：${errorMessage(error)}`)
        skip(discovered.id, SKIP_REASONS.configInvalid)
        continue
      }

      const permissions = permissionSet(discovered.manifest)
      const pluginLogger = createPluginLogger(discovered.id)
      // telemetry 关闭时事件不落盘（createSilentEmitter），与 events:write 权限无关：
      // 前者是用户对数据落盘的开关，后者是插件的能力声明
      const emit =
        !config.telemetry.enabled || !hasPermission(permissions, 'events:write')
          ? createSilentEmitter()
          : createEmitter(discovered.id, { repoRoot, branch: git.branch })
      const server = hasPermission(permissions, 'net:server')
        ? createServerClient(config.server)
        : createDeniedServer(discovered.id, logger)

      const context: HookContext<any> = {
        pluginId: discovered.id,
        config: pluginConfigValue,
        logger: pluginLogger,
        git,
        args,
        messageFile: hookName === 'commit-msg' ? args[0] : undefined,
        emit,
        server,
        permissions,
      }

      let outcome: HookOutcome | typeof TIMEOUT_MARK
      try {
        outcome = await withTimeout(handler(context), config.hooks.timeoutMs)
      } catch (error) {
        logger.warn(`[${discovered.id}] 执行异常，已放行：${errorMessage(error)}`)
        skip(discovered.id, SKIP_REASONS.error)
        continue
      }

      if (outcome === TIMEOUT_MARK) {
        logger.warn(`[${discovered.id}] 执行超时（${config.hooks.timeoutMs}ms），已放行`)
        skip(discovered.id, SKIP_REASONS.timeout)
        continue
      }
      if (outcome === 'reject') rejected = true
      // 只有真正跑完才算「增强生效过」。被调用但被上面任何一关挡下都不算，
      // 否则回溯会给出「昨天还在生效」的假象
      emitCore(EV_HANDLED, { hook: hookName, pluginId: discovered.id, outcome: outcome ?? 'accept' })
      logger.info(`[${discovered.id}] 完成：${outcome ?? 'accept'}`)
    }

    return rejected ? 1 : 0
  } catch (error) {
    logger.warn(`派发 ${hookName} 时发生内部错误，已放行：${errorMessage(error)}`)
    return 0
  }
}

/**
 * 收集所有插件的订阅者并注册到事件总线。
 * 只在命令执行路径调用 —— hook 路径不做订阅分发，避免拖慢提交。
 */
async function registerSubscriptions(
  bus: EventBus,
  repoRoot: string | null,
  config: FxDevkitConfig,
  logger: Logger,
): Promise<void> {
  for (const discovered of discoverPlugins(repoRoot)) {
    if (discovered.skipped || !isPluginEnabled(config, discovered.id)) continue

    const definition = await loadPlugin(discovered)
    if (!definition?.subscriptions?.length) continue

    let configValue: unknown
    try {
      const raw = {
        ...((definition.defaultConfig ?? {}) as object),
        ...pluginConfig(config, discovered.id),
      }
      configValue = definition.validateConfig ? definition.validateConfig(raw) : raw
    } catch {
      continue
    }

    for (const subscription of definition.subscriptions) {
      const boundConfig = configValue
      bus.register([
        {
          pluginId: discovered.id,
          pattern: subscription.pattern,
          handler: (event) =>
            subscription.handler(event, {
              pluginId: discovered.id,
              config: boundConfig,
              logger,
            }),
        },
      ])
    }
  }
}

/** 执行某个插件注册的自定义命令 */
export async function runPluginCommand(
  pluginId: string,
  commandName: string,
  argv: string[],
): Promise<number> {
  const logger = createCoreLogger(true)
  const cwd = process.cwd()
  const repoRoot = findRepoRoot(cwd)
  const { config } = loadConfig()

  const discovered = discoverPlugins(repoRoot).find((p) => p.id === pluginId)
  if (!discovered) {
    logger.error(`未找到插件 ${pluginId}`)
    return 1
  }
  const definition = await loadPlugin(discovered)
  const command = definition?.commands?.[commandName]
  if (!definition || !command) {
    logger.error(`插件 ${pluginId} 未提供命令 ${commandName}`)
    return 1
  }

  let pluginConfigValue: unknown
  try {
    const raw = { ...((definition.defaultConfig ?? {}) as object), ...pluginConfig(config, pluginId) }
    pluginConfigValue = definition.validateConfig ? definition.validateConfig(raw) : raw
  } catch (error) {
    logger.error(`配置非法：${errorMessage(error)}`)
    return 1
  }

  const git = detectGitContext(repoRoot ?? cwd)
  const permissions = permissionSet(discovered.manifest)
  // 命令路径：人正等着看输出，info 也要打出来（hook 路径仍然是静默的）
  const pluginLogger = createPluginLogger(pluginId, true)

  // 配置写回限定在 plugins.<自身 id> 下，插件碰不到全局配置，也碰不到别人的配置。
  // 未声明 fs:global 时降到空实现 + warn——这是「未声明给空实现而非报错」的能力识别约定。
  const configStore: ConfigStore = hasPermission(permissions, 'fs:global')
    ? {
        set: (patch) => {
          writeUserConfig({ plugins: { [pluginId]: patch } })
        },
      }
    : {
        set: () => {
          logger.warn(`插件 ${pluginId} 未声明 fs:global 权限，配置未被保存`)
        },
      }

  const context: CommandContext<any> = {
    pluginId,
    config: pluginConfigValue,
    logger: pluginLogger,
    git,
    emit:
      !config.telemetry.enabled || !hasPermission(permissions, 'events:write')
        ? createSilentEmitter()
        : createEmitter(pluginId, { repoRoot, branch: git.branch }),
    server: hasPermission(permissions, 'net:server')
      ? createServerClient(config.server)
      : createDeniedServer(pluginId, logger),
    permissions,
    configStore,
  }

  try {
    const code = await command.handler(argv, context)
    return typeof code === 'number' ? code : 0
  } catch (error) {
    logger.error(`命令执行失败：${errorMessage(error)}`)
    return 1
  }
}
