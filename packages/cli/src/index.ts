#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import {
  disableRepo,
  dispatchHook,
  discoverPlugins,
  enableRepo,
  findRepoRoot,
  getGlobalHooksPath,
  installGlobalHooks,
  isGlobalInstalled,
  isRepoEnabled,
  listEventMonths,
  loadConfig,
  loadPlugin,
  needsReinstall,
  paths,
  pluginConfig,
  pluginScope,
  readEvents,
  runPluginCommand,
  uninstallGlobalHooks,
} from '@fxdevkit/core'
import type { DiscoveredWithReason } from '@fxdevkit/core'
import type { HookName } from '@fxdevkit/sdk'

const cliEntry = fileURLToPath(import.meta.url)
const nodePath = process.execPath

interface SelfPackage {
  name: string
  version: string
}

/** fxdevkit 自身的包名与版本，用于 self 系列命令 */
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

function wantsGlobal(rest: string[]): boolean {
  return rest.includes('--global') || rest.includes('-g')
}

/**
 * 安装分两层：
 *   --global  装全局 hooks（一次）：所有仓库都会走 dispatcher
 *   不带参数  在当前仓库启用增强：只有启用的仓库才真正被插件增强
 */
function cmdInstall(rest: string[]): number {
  if (wantsGlobal(rest)) {
    const result = installGlobalHooks(nodePath, cliEntry)
    process.stdout.write(`[fxdevkit] 全局 hooks 已安装：${result.hooksDir}\n`)
    process.stdout.write(`[fxdevkit] 已托管：${result.installed.join(', ')}\n`)
    process.stdout.write('[fxdevkit] 所有仓库（含以后新建的）现在都会走 dispatcher\n')
    process.stdout.write('[fxdevkit] 但只有显式启用的仓库会被增强 → 在仓库内执行 fxdevkit install\n')
    return 0
  }

  const repoRoot = findRepoRoot(process.cwd())
  if (!repoRoot) {
    process.stderr.write('[fxdevkit] 当前目录不在 git 仓库中\n')
    return 1
  }
  const result = enableRepo(repoRoot, nodePath, cliEntry)
  process.stdout.write(`[fxdevkit] 本仓库已启用增强：${repoRoot}\n`)
  process.stdout.write(`[fxdevkit] hooks 目录：${result.hooksDir}\n`)
  if (result.migratedFromRepoHooksPath) {
    process.stdout.write(
      `[fxdevkit] 已迁移：清除本仓库旧的 core.hooksPath=${result.migratedFromRepoHooksPath}\n`,
    )
  }
  return 0
}

function cmdUninstall(rest: string[]): number {
  if (wantsGlobal(rest)) {
    uninstallGlobalHooks()
    process.stdout.write('[fxdevkit] 已卸载全局 hooks，所有仓库均不再被增强\n')
    return 0
  }

  const repoRoot = findRepoRoot(process.cwd())
  if (!repoRoot) return 1
  disableRepo(repoRoot)
  process.stdout.write(`[fxdevkit] 本仓库已停用增强：${repoRoot}\n`)
  process.stdout.write('[fxdevkit] 全局 hooks 保留，其他已启用的仓库不受影响\n')
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
  const repoRoot = findRepoRoot(process.cwd())
  const { config } = loadConfig(repoRoot)
  const plugins = {
    ...config.plugins,
    [pluginId]: { ...(config.plugins[pluginId] ?? {}), enabled },
  }
  const next = {
    ...config,
    plugins,
  }
  fs.mkdirSync(path.dirname(paths.globalConfig), { recursive: true })
  fs.writeFileSync(paths.globalConfig, `${YAML.stringify(next)}\n`, 'utf8')
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
  const { config, layers } = loadConfig(repoRoot)

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
  const script = path.join(paths.hooks, 'commit-msg')
  if (!fs.existsSync(script)) {
    return { ok: false, detail: '未生成', hint: '执行 fxdevkit install' }
  }
  const text = fs.readFileSync(script, 'utf8')
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  if (quoted.length < 2) {
    return { ok: false, detail: '脚本格式异常', hint: '执行 fxdevkit install 重建' }
  }
  const [nodeBin, entry] = quoted
  if (!fs.existsSync(nodeBin)) {
    return { ok: false, detail: 'Node 路径失效', hint: `${nodeBin} 不存在，执行 fxdevkit install 重建` }
  }
  if (!fs.existsSync(entry)) {
    return { ok: false, detail: 'CLI 入口失效', hint: `${entry} 不存在，执行 fxdevkit install 重建` }
  }
  return { ok: true, detail: entry }
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
        globalOk ? undefined : '执行 fxdevkit install --global 安装全局 hooks',
      ) && healthy

    // ② 本仓库总开关：决定「这个仓库会不会真的被增强」
    const enabled = isRepoEnabled(repoRoot)
    healthy =
      doctorLine(
        '本仓库增强',
        enabled ? '已启用' : '未启用',
        enabled,
        enabled ? undefined : '执行 fxdevkit install 在本仓库启用增强',
      ) && healthy

    const dispatcher = checkDispatcher()
    healthy = doctorLine('入口有效', dispatcher.detail, dispatcher.ok, dispatcher.hint) && healthy

    // ③ 插件：再按作用目录过滤
    const { config } = loadConfig(repoRoot)
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
    '  fxdevkit status                   查看当前状态：全局 hooks / 本仓库启用 / 插件',
    '  fxdevkit doctor                   检查增强链路是否正常',
    '  fxdevkit install --global         安装全局 hooks（一次，所有仓库都会走 dispatcher）',
    '  fxdevkit install                  在当前仓库启用增强（未装全局 hooks 时会自动装）',
    '  fxdevkit uninstall                在当前仓库停用增强',
    '  fxdevkit uninstall --global       卸载全局 hooks，所有仓库均不再增强',
    '  fxdevkit self version             查看 fxdevkit 版本',
    '  fxdevkit self update              更新 fxdevkit 到最新版',
    '  fxdevkit self rollback <version>  回退 fxdevkit 到指定版本',
    '  fxdevkit self uninstall           卸载 fxdevkit',
    '  fxdevkit config show              打印合并后的生效配置',
    '  fxdevkit config validate          校验各插件配置',
    '  fxdevkit report                   统计本地事件',
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
    `[fxdevkit] 全局 hooks ${globalOk ? `已安装 · ${paths.hooks}` : '未安装（fxdevkit install --global）'}\n`,
  )

  // 仓库层：决定本仓库是否真的被增强
  const repoRoot = findRepoRoot(process.cwd())
  if (repoRoot) {
    const enabled = isRepoEnabled(repoRoot)
    process.stdout.write(`[fxdevkit] 仓库 ${repoRoot}\n`)
    process.stdout.write(
      `[fxdevkit] 增强 ${enabled ? '已启用' : '未启用，提交不会被增强（fxdevkit install）'}\n`,
    )
  } else {
    process.stdout.write('[fxdevkit] 当前目录不在 git 仓库中\n')
  }

  const plugins = pluginTable()
  if (plugins.length === 0) {
    process.stdout.write('[fxdevkit] 未发现任何插件\n')
    return 0
  }

  const { config } = loadConfig(repoRoot)
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

function selfInstall(spec: string, action: string): number {
  try {
    runNpm(['install', '-g', spec], path.dirname(paths.home))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[fxdevkit] ${action}失败：${message}\n`)
    process.stderr.write(`[fxdevkit] 可手动执行：npm install -g ${spec}\n`)
    return 1
  }
  // 自身路径可能已变，重建全局 hooks，避免 dispatcher 指向失效入口
  installGlobalHooks(nodePath, cliEntry)
  process.stdout.write(`[fxdevkit] ${action}完成：${spec}\n`)
  return 0
}

function cmdSelf(rest: string[]): number {
  const [action, ...args] = rest
  switch (action) {
    case undefined:
    case 'version':
      process.stdout.write(`${SELF.name} ${SELF.version}\n`)
      return 0

    case 'update':
      process.stdout.write(`[fxdevkit] 当前 ${SELF.version}，正在更新...\n`)
      return selfInstall(`${SELF.name}@latest`, '更新')

    case 'rollback': {
      const version = args[0]
      if (!version) {
        process.stderr.write('[fxdevkit] 用法：fxdevkit self rollback <version>\n')
        return 1
      }
      return selfInstall(`${SELF.name}@${version}`, `回退到 ${version}`)
    }

    case 'uninstall': {
      // fxdevkit 自身要移除，全局 hooks 必须一起清掉，否则所有仓库的提交都会失败
      uninstallGlobalHooks()
      process.stdout.write('[fxdevkit] 已卸载全局 hooks\n')
      try {
        runNpm(['uninstall', '-g', SELF.name], path.dirname(paths.home))
        process.stdout.write(`[fxdevkit] 已卸载 ${SELF.name}\n`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`[fxdevkit] 卸载失败：${message}\n`)
        process.stderr.write(`[fxdevkit] 可手动执行：npm uninstall -g ${SELF.name}\n`)
        return 1
      }
      return 0
    }

    default:
      process.stderr.write(`[fxdevkit] 未知的 self 动作：${action}\n`)
      process.stderr.write('[fxdevkit] 可用动作：version | update | rollback <version> | uninstall\n')
      return 1
  }
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
      return cmdInstall(rest)

    case 'uninstall':
      return cmdUninstall(rest)

    case 'self':
      return cmdSelf(rest)

    case 'plugin':
      return cmdPlugin(rest)

    case 'config':
      return await cmdConfig(rest)

    case 'doctor':
      return await cmdDoctor()

    case 'report':
      return cmdReport()

    case 'hook': {
      const [name, ...args] = rest
      if (!isHookName(name)) return 0
      // 自愈：clone 后全局 hooks 若丢失，只在本仓库「已启用」时重装。
      // 新克隆的仓库默认未启用，不该被自动装上增强。
      if (name === 'post-checkout' && needsReinstall()) {
        const repoRoot = findRepoRoot(process.cwd())
        if (repoRoot && isRepoEnabled(repoRoot)) installGlobalHooks(nodePath, cliEntry)
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
