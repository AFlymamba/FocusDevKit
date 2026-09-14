#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import {
  addExclude,
  checkHooksHealth,
  dispatchHook,
  discoverPlugins,
  excludeList,
  findRepoRoot,
  getGlobalHooksPath,
  installGlobalHooks,
  isDirExcluded,
  isGlobalInstalled,
  listEventMonths,
  listLogDays,
  loadConfig,
  loadPlugin,
  needsReinstall,
  paths,
  pluginConfig,
  pluginScope,
  readEvents,
  readLogs,
  removeExclude,
  runPluginCommand,
  uninstallGlobalHooks,
  unsafeExcludeReason,
} from '@fxdevkit/core'
import type { DiscoveredWithReason, LogLevel } from '@fxdevkit/core'
import type { HookName } from '@fxdevkit/sdk'

const cliEntry = fileURLToPath(import.meta.url)

/** 会随应用升级被替换掉的 node 目录：IDE 托管、临时目录 */
const VOLATILE_NODE = /[\\/](\.workbuddy|binaries|Temp|temp|scoop[\\/]apps)[\\/]/i

/**
 * 写进 hook 脚本的 node 路径。
 *
 * 直接记 process.execPath 有个坑：在 IDE 终端里执行 install 时，
 * 记下的就是 IDE 托管的 node（如 ...\.workbuddy\binaries\node\versions\22.22.2-2\node.exe）。
 * 这类路径会随应用升级整个被替换，hook 随即静默失效——这次故障就是这么来的。
 * 所以安装时优先挑一个稳定路径，实在挑不到才退回 execPath
 * （脚本本身还有 PATH 兜底，见 core/hooks.ts 的 dispatcherScript）。
 */
function pickRecordedNode(): string {
  if (!VOLATILE_NODE.test(process.execPath)) return process.execPath
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(cmd, ['node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const candidates = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const stable = candidates.find((p) => !VOLATILE_NODE.test(p)) ?? candidates[0]
    if (stable && fs.existsSync(stable)) return stable
  } catch {
    /* 解析不到就用原值 */
  }
  return process.execPath
}

const nodePath = pickRecordedNode()

interface SelfPackage {
  name: string
  version: string
}

/** fxdevkit 自身的包名与版本，用于 -v / update */
function readSelfPackage(): SelfPackage {
  const fallback: SelfPackage = { name: '@fxdevkit/cli', version: '0.0.0' }
  try {
    const pkgPath = path.resolve(path.dirname(cliEntry), '..', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Partial<SelfPackage>
    return { name: pkg.name ?? fallback.name, version: pkg.version ?? fallback.version }
  } catch {
    return fallback
  }
}

const SELF = readSelfPackage()

const HOOK_NAMES: HookName[] = [
  'commit-msg',
  'prepare-commit-msg',
  'post-checkout',
  'post-merge',
  'pre-commit',
  'pre-push',
]

function isHookName(value: string | undefined): value is HookName {
  return value != null && (HOOK_NAMES as string[]).includes(value)
}

function resolveNpmCli(): string | null {
  const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(bundled)) return bundled

  const execpath = process.env.npm_execpath
  if (execpath && fs.existsSync(execpath)) return execpath

  return null
}

function runNpm(args: string[], cwd: string): void {
  const npmCli = resolveNpmCli()
  if (npmCli) {
    execFileSync(nodePath, [npmCli, ...args], { cwd, stdio: 'inherit' })
    return
  }
  execFileSync('npm', args, { cwd, stdio: 'inherit' })
}

/**
 * 挂载全局 hooks（机器级，一次）。
 *
 * 安装只有一种：写到 git 全局 core.hooksPath，所有仓库（含以后新建 / 克隆的）都会走 dispatcher。
 * 想排除某个目录 → 在该目录下 `fxdevkit disable`（写进用户配置的 exclude，跟人走）。
 */
function cmdInstall(): number {
  const result = installGlobalHooks(nodePath, cliEntry)
  process.stdout.write(`[fxdevkit] 全局 hooks 已挂载：${result.hooksDir}\n`)
  process.stdout.write(`[fxdevkit] 已托管：${result.installed.join(', ')}\n`)
  process.stdout.write('[fxdevkit] 所有仓库（含以后新建的）现在都会被插件增强\n')
  process.stdout.write('[fxdevkit] 想排除某个目录 → 在该目录下执行 fxdevkit disable\n')
  return 0
}

/** 卸载全局 hooks（机器级）。不动用户配置里的 exclude */
function cmdUninstall(): number {
  uninstallGlobalHooks()
  process.stdout.write('[fxdevkit] 已卸载全局 hooks，所有仓库均不再被增强\n')
  process.stdout.write('[fxdevkit] 用户配置未改动，exclude 列表保留\n')
  return 0
}

/** 范围操作的目标：优先仓库根，不在仓库里就用当前目录 */
function scopeTarget(): string {
  return findRepoRoot(process.cwd()) ?? process.cwd()
}

/**
 * 停用当前目录的增强：把目录写进 ~/.fxdevkit/config.yaml 的 exclude。
 *
 * 存在用户配置而不是仓库的 .git/config，是因为前者跟人走——换机器、
 * 重新 clone 都不会丢。命中范围是该目录及其所有子目录。
 */
function cmdDisable(): number {
  const target = scopeTarget()
  const unsafe = unsafeExcludeReason(target)
  if (unsafe) {
    process.stderr.write(`[fxdevkit] ${unsafe}：${target}\n`)
    return 1
  }
  const { changed, list } = addExclude(target)
  process.stdout.write(
    changed
      ? `[fxdevkit] 已停用增强：${target}（含其所有子目录）\n`
      : `[fxdevkit] ${target} 已在 exclude 中，无需重复添加\n`,
  )
  process.stdout.write(`[fxdevkit] exclude 共 ${list.length} 条 · ${paths.userConfig}\n`)
  return 0
}

/** 恢复当前目录的增强：把它从 exclude 中移除 */
function cmdEnable(): number {
  const target = scopeTarget()
  const { changed, list } = removeExclude(target)
  process.stdout.write(
    changed
      ? `[fxdevkit] 已恢复增强：${target}\n`
      : `[fxdevkit] ${target} 不在 exclude 中，无需恢复\n`,
  )
  // 覆盖它的可能是上级目录条目，明确提示，避免「我明明 enable 了却不生效」
  const { config } = loadConfig()
  if (isDirExcluded(config, target)) {
    process.stdout.write('[fxdevkit] 注意：该目录仍被 exclude 里的上级目录覆盖，增强不会生效\n')
  }
  process.stdout.write(`[fxdevkit] exclude 共 ${list.length} 条 · ${paths.userConfig}\n`)
  return 0
}

function cmdPluginList(): number {
  const repoRoot = findRepoRoot(process.cwd())
  const plugins = discoverPlugins(repoRoot)
  if (plugins.length === 0) {
    process.stdout.write('[fxdevkit] 未发现任何插件\n')
    return 0
  }
  for (const plugin of plugins) {
    const hooks = plugin.manifest.hooks?.join(', ') ?? '-'
    const perms = plugin.manifest.permissions?.join(', ') ?? '-'
    const status = plugin.skipped ? `SKIPPED (${plugin.skipped})` : 'ok'
    process.stdout.write(
      `${plugin.id}@${plugin.version}  [${status}]\n  hooks: ${hooks}\n  permissions: ${perms}\n  dir: ${plugin.dir}\n`,
    )
  }
  return 0
}

function ensurePluginHome(): void {
  fs.mkdirSync(paths.home, { recursive: true })
  const pkgFile = path.join(paths.home, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(
      pkgFile,
      `${JSON.stringify({ name: 'fxdevkit-plugins', private: true, dependencies: {} }, null, 2)}\n`,
      'utf8',
    )
  }
}

function setPluginEnabled(pluginId: string, enabled: boolean): void {
  const { config } = loadConfig()
  const plugins = {
    ...config.plugins,
    [pluginId]: { ...(config.plugins[pluginId] ?? {}), enabled },
  }
  const next = {
    ...config,
    plugins,
  }
  fs.mkdirSync(path.dirname(paths.userConfig), { recursive: true })
  fs.writeFileSync(paths.userConfig, `${YAML.stringify(next)}\n`, 'utf8')
}

function cmdPlugin(rest: string[]): number {
  const [action, ...args] = rest
  switch (action) {
    case 'list':
    case undefined:
      return cmdPluginList()
    case 'add': {
      const pkg = args[0]
      if (!pkg) {
        process.stderr.write('[fxdevkit] 用法：fxdevkit plugin add <pkg>\n')
        return 1
      }
      ensurePluginHome()
      runNpm(['install', pkg], paths.home)
      return cmdPluginList()
    }
    case 'remove': {
      const pkg = args[0]
      if (!pkg) {
        process.stderr.write('[fxdevkit] 用法：fxdevkit plugin remove <pkg>\n')
        return 1
      }
      ensurePluginHome()
      runNpm(['uninstall', pkg], paths.home)
      return cmdPluginList()
    }
    case 'enable': {
      const id = args[0]
      if (!id) {
        process.stderr.write('[fxdevkit] 用法：fxdevkit plugin enable <id>\n')
        return 1
      }
      setPluginEnabled(id, true)
      return cmdPluginList()
    }
    case 'disable': {
      const id = args[0]
      if (!id) {
        process.stderr.write('[fxdevkit] 用法：fxdevkit plugin disable <id>\n')
        return 1
      }
      setPluginEnabled(id, false)
      return cmdPluginList()
    }
    default:
      process.stderr.write(`[fxdevkit] 未知的 plugin 动作：${action}\n`)
      return 1
  }
}

async function cmdConfig(rest: string[]): Promise<number> {
  const [action] = rest
  const repoRoot = findRepoRoot(process.cwd())
  const { config, layers } = loadConfig()

  if (action === 'validate') {
    let failed = false
    for (const discovered of discoverPlugins(repoRoot)) {
      if (discovered.skipped) {
        process.stderr.write(`[fxdevkit] ${discovered.id}: ${discovered.skipped}\n`)
        failed = true
        continue
      }
      const definition = await loadPlugin(discovered)
      if (!definition) {
        process.stderr.write(`[fxdevkit] ${discovered.id}: 加载失败\n`)
        failed = true
        continue
      }
      try {
        const raw = {
          ...((definition.defaultConfig ?? {}) as object),
          ...pluginConfig(config, discovered.id),
        }
        if (definition.validateConfig) definition.validateConfig(raw)
        process.stdout.write(`[fxdevkit] ${discovered.id}: ok\n`)
      } catch (error) {
        process.stderr.write(
          `[fxdevkit] ${discovered.id}: ${error instanceof Error ? error.message : String(error)}\n`,
        )
        failed = true
      }
    }
    return failed ? 1 : 0
  }

  process.stdout.write(`${JSON.stringify({ layers, config }, null, 2)}\n`)
  return 0
}

async function cmdReport(): Promise<number> {
  const months = listEventMonths()
  if (months.length === 0) {
    process.stdout.write('[fxdevkit] 暂无事件记录\n')
    return 0
  }

  const counters = new Map<string, number>()
  for (const month of months) {
    for (const event of readEvents(month)) {
      const key = `${event.plugin} · ${event.type}`
      counters.set(key, (counters.get(key) ?? 0) + 1)
    }
  }

  process.stdout.write(`[fxdevkit] 事件文件：${months.join(', ')}\n`)
  for (const [key, count] of [...counters.entries()].sort()) {
    process.stdout.write(`  ${count}\t${key}\n`)
  }
  return 0
}

function formatTs(ts: string): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function isLogLevelValue(value: string): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}

function renderLogsHelp(): string {
  return [
    '用法:',
    '  fxdevkit logs                    查看今天的全部日志（core + plugin）',
    '  fxdevkit logs --core             只看内核调度日志',
    '  fxdevkit logs --plugin <id>      只看某个插件的执行日志',
    '  fxdevkit logs --level <level>    debug | info | warn | error 及以上',
    '  fxdevkit logs --day <YYYY-MM-DD> 查看指定日期',
    '  fxdevkit logs --days             列出有哪些日期的日志文件',
    '  fxdevkit logs --last <n>         只看最后 n 条',
    '',
    '日志文件位置：~/.fxdevkit/logs/YYYY-MM-DD.log（结构化 JSON）',
  ].join('\n')
}

function cmdLogs(rest: string[]): number {
  let channel: 'core' | 'plugin' | undefined
  let pluginId: string | undefined
  let level: LogLevel | undefined
  let day: string | undefined
  let last: number | undefined

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--core') {
      channel = 'core'
    } else if (arg === '--plugin') {
      channel = 'plugin'
      pluginId = rest[++i]
      if (!pluginId) {
        process.stderr.write('[fxdevkit] --plugin 需要一个插件 id，如 --plugin commit-rules\n')
        return 1
      }
    } else if (arg === '--level') {
      const value = rest[++i]
      if (!isLogLevelValue(value)) {
        process.stderr.write('[fxdevkit] --level 需为 debug | info | warn | error\n')
        return 1
      }
      level = value
    } else if (arg === '--day') {
      day = rest[++i]
      if (!day) {
        process.stderr.write('[fxdevkit] --day 需要一个日期，如 --day 2026-09-07\n')
        return 1
      }
    } else if (arg === '--days') {
      const days = listLogDays()
      if (days.length === 0) {
        process.stdout.write('[fxdevkit] 暂无日志\n')
        return 0
      }
      process.stdout.write('[fxdevkit] 日志文件（按天）：\n')
      for (const d of days) process.stdout.write(`  ${d}\n`)
      return 0
    } else if (arg === '--last' || arg === '-n') {
      const value = rest[++i]
      const n = Number(value)
      if (!Number.isInteger(n) || n <= 0) {
        process.stderr.write('[fxdevkit] --last 需要一个正整数\n')
        return 1
      }
      last = n
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(renderLogsHelp())
      return 0
    } else {
      process.stderr.write(`[fxdevkit] 未知参数：${arg}\n`)
      return 1
    }
  }

  const records = readLogs({ day, channel, plugin: pluginId, level })
  if (records.length === 0) {
    process.stdout.write(`[fxdevkit] ${day ?? '今天'}无匹配日志\n`)
    return 0
  }

  const shown = last ? records.slice(-last) : records
  for (const record of shown) {
    const label = record.channel === 'core' ? 'core' : `plugin:${record.plugin ?? '?'}`
    process.stdout.write(`${formatTs(record.ts)}  ${label}  ${record.level.padEnd(5)} ${record.msg}\n`)
  }
  if (last && records.length > last) {
    process.stdout.write(`  … 共 ${records.length} 条，仅显示最后 ${last} 条\n`)
  }
  return 0
}

function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += /[一-龥＀-￯]/.test(ch) ? 2 : 1
  return width
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)))
}

function doctorLine(label: string, value: string, ok: boolean, hint?: string): boolean {
  process.stdout.write(`[fxdevkit] ${pad(label, 20)}${pad(value, 50)}${ok ? 'ok' : '失败'}\n`)
  if (hint) process.stdout.write(`         → ${hint}\n`)
  return ok
}

function checkDispatcher(): { ok: boolean; detail: string; hint?: string } {
  const health = checkHooksHealth()
  return { ok: health.ok, detail: health.detail, ...(health.hint ? { hint: health.hint } : {}) }
}

async function cmdDoctor(): Promise<number> {
  let healthy = true

  healthy = doctorLine('Node', process.version, true) && healthy

  let gitVersion = '不可用'
  let gitOk = false
  try {
    gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()
    gitOk = true
  } catch {
    /* git 不可用，保留默认值 */
  }
  healthy =
    doctorLine('Git', gitVersion, gitOk, gitOk ? undefined : '未找到 git，请确认已安装并加入 PATH') && healthy

  const repoRoot = findRepoRoot(process.cwd())
  healthy =
    doctorLine(
      '仓库',
      repoRoot ?? '当前目录不在 git 仓库中',
      repoRoot != null,
      repoRoot ? undefined : '请在目标仓库内执行本命令',
    ) && healthy

  if (repoRoot) {
    // ① 全局 hooks：决定「所有仓库都会不会走 dispatcher」
    const globalHooks = getGlobalHooksPath()
    const globalOk = isGlobalInstalled()
    healthy =
      doctorLine(
        '全局 hooks',
        globalHooks ?? '未安装',
        globalOk,
        globalOk ? undefined : '执行 fxdevkit install 挂载全局 hooks',
      ) && healthy

    // ② 范围：命中 exclude 的目录不被增强，这是用户主动配置，不算故障
    const { config } = loadConfig()
    const excluded = isDirExcluded(config, repoRoot)
    doctorLine(
      '增强范围',
      excluded ? '已排除（用户主动）' : '已覆盖',
      true,
      excluded ? `fxdevkit enable 可恢复本目录（exclude 见 ${paths.userConfig}）` : undefined,
    )

    const dispatcher = checkDispatcher()
    healthy = doctorLine('入口有效', dispatcher.detail, dispatcher.ok, dispatcher.hint) && healthy

    // ③ 插件：再按作用目录过滤
    const plugins = discoverPlugins(repoRoot)
    if (plugins.length === 0) {
      process.stdout.write('[fxdevkit] 未发现任何插件\n')
    }
    for (const discovered of plugins) {
      if (discovered.skipped) {
        healthy = doctorLine(`插件 ${discovered.id}`, '已跳过', false, discovered.skipped) && healthy
        continue
      }

      const scope = pluginScope(config, discovered.id, repoRoot)
      if (!scope.inScope) {
        // 用户显式配了作用目录，不在范围内是预期结果，不算故障
        doctorLine(`插件 ${discovered.id}`, '未生效（不在作用目录）', true, scope.reason)
        continue
      }

      let loaded = false
      let detail = '加载成功'
      try {
        loaded = (await loadPlugin(discovered)) != null
        if (!loaded) detail = '加载失败'
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error)
      }
      healthy = doctorLine(`插件 ${discovered.id}`, detail, loaded) && healthy
    }
  }

  if (healthy) {
    process.stdout.write('[fxdevkit] 全部检查通过，增强链路正常\n')
    return 0
  }
  process.stdout.write('[fxdevkit] 存在未通过项，相关增强不会发生\n')
  return 1
}

function pluginTable(): DiscoveredWithReason[] {
  return discoverPlugins(findRepoRoot(process.cwd()))
}

function renderHelp(): string {
  const lines = [
    `${SELF.name} ${SELF.version} — 研发动作背后的插件化增强层`,
    '',
    '用法:',
    '  fxdevkit status                   查看当前状态：全局 hooks / 增强范围 / 插件',
    '  fxdevkit doctor                   检查增强链路是否正常',
    '  fxdevkit install                  挂载全局 hooks（一次，所有仓库都会走 dispatcher）',
    '  fxdevkit uninstall                卸载全局 hooks，所有仓库均不再增强',
    '  fxdevkit disable                  停用当前目录的增强（写进用户配置的 exclude）',
    '  fxdevkit enable                   恢复当前目录的增强',
    '  fxdevkit update [version]          更新 fxdevkit（不带版本=最新，带版本=回退）',
    '  fxdevkit config show              打印合并后的生效配置',
    '  fxdevkit config validate          校验各插件配置',
    '  fxdevkit report                   统计本地事件',
    '  fxdevkit logs                     查看日志（--core / --plugin <id> / --level / --day）',
    '  fxdevkit help                     显示本帮助',
  ]

  const plugins = pluginTable().filter((plugin) => !plugin.skipped)
  if (plugins.length > 0) {
    lines.push('', '插件命令:')
    for (const plugin of plugins) {
      const commands = plugin.manifest.commands ?? []
      lines.push(`  fxdevkit ${pad(plugin.name, 14)}${commands.length > 0 ? commands.join(' | ') : '（未提供命令）'}`)
    }
    lines.push('', '  fxdevkit <name> -v 查看插件版本，fxdevkit <name> --help 查看其命令')
  }

  lines.push(
    '',
    '环境变量:',
    '  FXDEVKIT_HOME            覆盖全局目录（默认 ~/.fxdevkit）',
    '  FXDEVKIT_SERVER_URL      指向真实 Server，设置后自动关闭 mock',
    '  FXDEVKIT_SERVER_MOCK=1   强制使用本地 mock Server',
    '  FXDEVKIT_TELEMETRY=0     关闭事件落盘',
    '  FXDEVKIT_HOOK_TIMEOUT_MS 单个插件在 hook 中的硬超时（默认 1000）',
    '  FXDEVKIT_DEBUG=1         输出调试日志',
    '',
  )
  return lines.join('\n')
}

async function cmdStatus(): Promise<number> {
  process.stdout.write(`[fxdevkit] ${SELF.name} ${SELF.version} · Node ${process.version}\n`)

  // 全局层：决定所有仓库是否走 dispatcher
  const globalOk = isGlobalInstalled()
  process.stdout.write(
    `[fxdevkit] 全局 hooks ${globalOk ? `已安装 · ${paths.hooks}` : '未安装（fxdevkit install）'}\n`,
  )

  // 范围层：命中 exclude 的目录不被增强
  const { config } = loadConfig()
  const repoRoot = findRepoRoot(process.cwd())
  if (repoRoot) {
    const excluded = isDirExcluded(config, repoRoot)
    process.stdout.write(`[fxdevkit] 仓库 ${repoRoot}\n`)
    process.stdout.write(
      `[fxdevkit] 增强 ${excluded ? '已排除（fxdevkit enable 可恢复）' : '已覆盖'}\n`,
    )
  } else {
    process.stdout.write('[fxdevkit] 当前目录不在 git 仓库中\n')
  }

  const plugins = pluginTable()
  if (plugins.length === 0) {
    process.stdout.write('[fxdevkit] 未发现任何插件\n')
    return 0
  }

  process.stdout.write('[fxdevkit] 插件:\n')
  for (const plugin of plugins) {
    const scope = pluginScope(config, plugin.id, repoRoot)
    const state = plugin.skipped ? 'SKIPPED' : scope.inScope ? 'ok' : '未生效'
    process.stdout.write(
      `  ${pad(plugin.name, 14)}${pad(`${plugin.id}@${plugin.version}`, 30)}${state}\n`,
    )
    if (plugin.skipped) process.stdout.write(`      → ${plugin.skipped}\n`)
    else if (!scope.inScope) process.stdout.write(`      → ${scope.reason}\n`)
    for (const ignored of plugin.ignoredVersions ?? []) {
      process.stdout.write(`      已忽略较低版本 ${ignored.version}（${ignored.dir}）\n`)
    }
  }
  return 0
}

function installCli(spec: string): number {
  try {
    runNpm(['install', '-g', spec], path.dirname(paths.home))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[fxdevkit] 安装失败：${message}\n`)
    process.stderr.write(`[fxdevkit] 可手动执行：npm install -g ${spec}\n`)
    return 1
  }
  // 自身路径可能已变，重建全局 hooks，避免 dispatcher 指向失效入口
  installGlobalHooks(nodePath, cliEntry)
  process.stdout.write(`[fxdevkit] 已安装 ${spec}\n`)
  return 0
}

/**
 * 更新 / 回退 fxdevkit 自身。
 *
 * 卸载自身不提供命令：卸载就是 `npm uninstall -g fxdevkit`。残留的全局 hooks
 * 会在入口失效时静默放行（见 hooks.ts 的 dispatcherScript），无需讲究顺序。
 */
function cmdUpdate(rest: string[]): number {
  if (rest.length > 1) {
    process.stderr.write('[fxdevkit] 用法：fxdevkit update [version]\n')
    return 1
  }
  const version = rest[0]
  const spec = version ? `${SELF.name}@${version}` : `${SELF.name}@latest`
  process.stdout.write(
    version
      ? `[fxdevkit] 当前 ${SELF.version}，正在回退到 ${version}...\n`
      : `[fxdevkit] 当前 ${SELF.version}，正在更新...\n`,
  )
  return installCli(spec)
}

function findPluginCommand(name: string | undefined): DiscoveredWithReason | null {
  if (!name) return null
  for (const plugin of pluginTable()) {
    if (plugin.skipped) continue
    if (plugin.name === name) return plugin
  }
  return null
}

async function runPluginCli(discovered: DiscoveredWithReason, argv: string[]): Promise<number> {
  const commands = discovered.manifest.commands ?? []

  if (argv[0] === '-v' || argv[0] === '--version') {
    process.stdout.write(`${discovered.id}@${discovered.version}\n`)
    process.stdout.write(`  name:    ${discovered.name}\n`)
    process.stdout.write(`  dir:     ${discovered.dir}\n`)
    if (commands.length > 0) process.stdout.write(`  命令:    ${commands.join(', ')}\n`)
    return 0
  }

  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(`fxdevkit ${discovered.name} — ${discovered.id}@${discovered.version}\n\n`)
    if (commands.length === 0) {
      process.stdout.write('  该插件未提供命令\n')
      return 0
    }
    process.stdout.write('用法:\n')
    for (const command of commands) {
      process.stdout.write(`  fxdevkit ${discovered.name} ${command}\n`)
    }
    return 0
  }

  const [command, ...rest] = argv
  if (!commands.includes(command)) {
    process.stderr.write(`[fxdevkit] 插件 ${discovered.name} 未提供命令 ${command}\n`)
    return 1
  }
  return runPluginCommand(discovered.id, command, rest)
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv

  switch (command) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(renderHelp())
      return 0

    case '-v':
    case '--version':
      process.stdout.write(`${SELF.name} ${SELF.version}\n`)
      return 0

    case 'status':
      return await cmdStatus()

    case 'install':
      return cmdInstall()

    case 'uninstall':
      return cmdUninstall()

    case 'disable':
      return cmdDisable()

    case 'enable':
      return cmdEnable()

    case 'update':
      return cmdUpdate(rest)

    case 'plugin':
      return cmdPlugin(rest)

    case 'config':
      return await cmdConfig(rest)

    case 'doctor':
      return await cmdDoctor()

    case 'report':
      return cmdReport()

    case 'logs':
      return cmdLogs(rest)

    case 'hook': {
      const [name, ...args] = rest
      if (!isHookName(name)) return 0
      // 自愈：clone 后全局 hooks 若丢失，直接重装（默认所有仓库都该被增强）
      if (name === 'post-checkout' && needsReinstall()) {
        installGlobalHooks(nodePath, cliEntry)
      }
      return dispatchHook(name, args)
    }

    default: {
      // 内置命令未命中时，按插件 name 路由。CLI 源码不出现任何插件 id
      const plugin = findPluginCommand(command)
      if (plugin) return await runPluginCli(plugin, rest)
      process.stderr.write(`[fxdevkit] 未知命令：${command}\n`)
      process.stdout.write(renderHelp())
      return 1
    }
  }
}

const invokedAsHook = process.argv[2] === 'hook'

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[fxdevkit] ${message}\n`)
    // hook 路径下任何异常都不得阻断 git
    process.exit(invokedAsHook ? 0 : 1)
  })
