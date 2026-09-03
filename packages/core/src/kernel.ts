import type {
  CommandContext,
  HookContext,
  HookName,
  HookOutcome,
  Logger,
  PluginDefinition,
} from '@devkit/sdk'
import { type DevkitConfig, isPluginEnabled, loadConfig, pluginConfig } from './config.js'
import {
  consumeAmendState,
  detectGitContext,
  findRepoRoot,
  isAmendInvocation,
  markAmendState,
} from './git.js'
import { EventBus, createEmitter, createSilentEmitter } from './events.js'
import {
  discoverPlugins,
  hasPermission,
  loadPlugin,
  permissionSet,
  selectPlugins,
} from './plugins.js'
import { createDeniedServer, createServerClient } from './server.js'

export function createLogger(verbose = false): Logger {
  // 一律走 stderr：git hook 的 stdout 有时会被 git 消费
  const write = (level: string, message: string): void => {
    process.stderr.write(`[devkit] ${level} ${message}\n`)
  }
  return {
    debug: (m) => {
      if (verbose || process.env.DEVKIT_DEBUG === '1') write('debug', m)
    },
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  }
}

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
 * 派发一个 git hook 给所有声明了它的插件。
 *
 * 熔断原则：本函数在任何异常路径下都返回 0（放行）。
 * 只有插件显式返回 'reject' 才会返回 1。
 */
export async function dispatchHook(hookName: HookName, args: string[]): Promise<number> {
  const logger = createLogger()
  try {
    const cwd = process.cwd()
    const repoRoot = findRepoRoot(cwd)
    const { config } = loadConfig(repoRoot)

    // amend 只能在 prepare-commit-msg 判定，这里落状态供 commit-msg 消费
    if (hookName === 'prepare-commit-msg') {
      if (repoRoot) markAmendState(repoRoot, isAmendInvocation(args))
      return 0
    }

    const isAmend = hookName === 'commit-msg' && repoRoot ? consumeAmendState(repoRoot) : false
    const git = detectGitContext(repoRoot ?? cwd, isAmend)

    const candidates = selectPlugins(discoverPlugins(repoRoot), hookName)
    let rejected = false

    for (const discovered of candidates) {
      if (discovered.skipped) {
        logger.warn(`[${discovered.id}] 已跳过：${discovered.skipped}`)
        continue
      }
      if (!isPluginEnabled(config, discovered.id)) continue

      const definition: PluginDefinition<any> | null = await loadPlugin(discovered)
      if (!definition) {
        logger.warn(`[${discovered.id}] 加载失败，已跳过`)
        continue
      }

      const handler = definition.hooks?.[hookName]
      if (!handler) continue

      let pluginConfigValue: unknown
      try {
        const raw = { ...((definition.defaultConfig ?? {}) as object), ...pluginConfig(config, discovered.id) }
        pluginConfigValue = definition.validateConfig ? definition.validateConfig(raw) : raw
      } catch (error) {
        logger.warn(`[${discovered.id}] 配置非法，已跳过：${errorMessage(error)}`)
        continue
      }

      const permissions = permissionSet(discovered.manifest)
      const emit = hasPermission(permissions, 'events:write')
        ? createEmitter(discovered.id, { repoRoot, branch: git.branch })
        : createSilentEmitter()
      const server = hasPermission(permissions, 'net:server')
        ? createServerClient(config.server)
        : createDeniedServer(discovered.id, logger)

      const context: HookContext<any> = {
        pluginId: discovered.id,
        config: pluginConfigValue,
        logger,
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
        continue
      }

      if (outcome === TIMEOUT_MARK) {
        logger.warn(`[${discovered.id}] 执行超时（${config.hooks.timeoutMs}ms），已放行`)
        continue
      }
      if (outcome === 'reject') rejected = true
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
  config: DevkitConfig,
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
  const logger = createLogger(true)
  const cwd = process.cwd()
  const repoRoot = findRepoRoot(cwd)
  const { config } = loadConfig(repoRoot)

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

  const context: CommandContext<any> = {
    pluginId,
    config: pluginConfigValue,
    logger,
    git,
    emit: hasPermission(permissions, 'events:write')
      ? createEmitter(pluginId, { repoRoot, branch: git.branch })
      : createSilentEmitter(),
    server: hasPermission(permissions, 'net:server')
      ? createServerClient(config.server)
      : createDeniedServer(pluginId, logger),
    permissions,
  }

  try {
    const code = await command.handler(argv, context)
    return typeof code === 'number' ? code : 0
  } catch (error) {
    logger.error(`命令执行失败：${errorMessage(error)}`)
    return 1
  }
}
