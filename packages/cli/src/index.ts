#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import {
  DEVKit_HOME,
  dispatchHook,
  discoverPlugins,
  findRepoRoot,
  installHooks,
  listEventMonths,
  loadConfig,
  loadPlugin,
  needsReinstall,
  paths,
  pluginConfig,
  readEvents,
  runPluginCommand,
  uninstallHooks,
} from '@devkit/core'
import type { HookName } from '@devkit/sdk'

const cliEntry = fileURLToPath(import.meta.url)
const nodePath = process.execPath

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

const HELP = `devkit — 研发全生命周期插件化工作台

用法:
  devkit install                    安装 git hooks（core.hooksPath 托管）
  devkit uninstall                  卸载 git hooks
  devkit plugin list                列出已发现插件
  devkit plugin add <pkg>           安装插件到 ${DEVKit_HOME}
  devkit plugin remove <pkg>        卸载插件
  devkit plugin enable <id>         启用插件
  devkit plugin disable <id>        禁用插件
  devkit config show                打印合并后的生效配置
  devkit config validate            校验各插件配置
  devkit check [--sha <sha>]        校验提交信息（转发 commit-rules）
  devkit report                     统计本地事件
  devkit hook <name> [args...]      内部命令：派发 git hook

环境变量:
  DEVKIT_HOME            覆盖全局目录（默认 ~/.devkit）
  DEVKIT_SERVER_URL      指向真实 Server，设置后自动关闭 mock
  DEVKIT_SERVER_MOCK=1   强制使用本地 mock Server
  DEVKIT_TELEMETRY=0     关闭事件落盘
  DEVKIT_HOOK_TIMEOUT_MS 单个插件在 hook 中的硬超时（默认 1000）
  DEVKIT_DEBUG=1         输出调试日志
`

function cmdInstall(): number {
  const cwd = process.cwd()
  const repoRoot = findRepoRoot(cwd)
  if (!repoRoot) {
    process.stderr.write('[devkit] 当前目录不在 git 仓库中\n')
    return 1
  }
  const result = installHooks(repoRoot, nodePath, cliEntry)
  process.stdout.write(`[devkit] hooks 目录：${result.hooksDir}\n`)
  process.stdout.write(`[devkit] 已托管：${result.installed.join(', ')}\n`)
  if (result.previousHooksPath) {
    process.stdout.write(`[devkit] 原 core.hooksPath：${result.previousHooksPath}（已被覆盖）\n`)
  }
  return 0
}

function cmdUninstall(): number {
  const repoRoot = findRepoRoot(process.cwd())
  if (!repoRoot) return 1
  uninstallHooks(repoRoot)
  process.stdout.write('[devkit] 已卸载 hooks\n')
  return 0
}

function cmdPluginList(): number {
  const repoRoot = findRepoRoot(process.cwd())
  const plugins = discoverPlugins(repoRoot)
  if (plugins.length === 0) {
    process.stdout.write('[devkit] 未发现任何插件\n')
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
      `${JSON.stringify({ name: 'devkit-plugins', private: true, dependencies: {} }, null, 2)}\n`,
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
        process.stderr.write('[devkit] 用法：devkit plugin add <pkg>\n')
        return 1
      }
      ensurePluginHome()
      runNpm(['install', pkg], paths.home)
      return cmdPluginList()
    }
    case 'remove': {
      const pkg = args[0]
      if (!pkg) {
        process.stderr.write('[devkit] 用法：devkit plugin remove <pkg>\n')
        return 1
      }
      ensurePluginHome()
      runNpm(['uninstall', pkg], paths.home)
      return cmdPluginList()
    }
    case 'enable': {
      const id = args[0]
      if (!id) {
        process.stderr.write('[devkit] 用法：devkit plugin enable <id>\n')
        return 1
      }
      setPluginEnabled(id, true)
      return cmdPluginList()
    }
    case 'disable': {
      const id = args[0]
      if (!id) {
        process.stderr.write('[devkit] 用法：devkit plugin disable <id>\n')
        return 1
      }
      setPluginEnabled(id, false)
      return cmdPluginList()
    }
    default:
      process.stderr.write(`[devkit] 未知的 plugin 动作：${action}\n`)
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
        process.stderr.write(`[devkit] ${discovered.id}: ${discovered.skipped}\n`)
        failed = true
        continue
      }
      const definition = await loadPlugin(discovered)
      if (!definition) {
        process.stderr.write(`[devkit] ${discovered.id}: 加载失败\n`)
        failed = true
        continue
      }
      try {
        const raw = {
          ...((definition.defaultConfig ?? {}) as object),
          ...pluginConfig(config, discovered.id),
        }
        if (definition.validateConfig) definition.validateConfig(raw)
        process.stdout.write(`[devkit] ${discovered.id}: ok\n`)
      } catch (error) {
        process.stderr.write(
          `[devkit] ${discovered.id}: ${error instanceof Error ? error.message : String(error)}\n`,
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
    process.stdout.write('[devkit] 暂无事件记录\n')
    return 0
  }

  const counters = new Map<string, number>()
  for (const month of months) {
    for (const event of readEvents(month)) {
      const key = `${event.plugin} · ${event.type}`
      counters.set(key, (counters.get(key) ?? 0) + 1)
    }
  }

  process.stdout.write(`[devkit] 事件文件：${months.join(', ')}\n`)
  for (const [key, count] of [...counters.entries()].sort()) {
    process.stdout.write(`  ${count}\t${key}\n`)
  }
  return 0
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const [command, ...rest] = argv

  switch (command) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(HELP)
      return 0

    case 'install':
      return cmdInstall()

    case 'uninstall':
      return cmdUninstall()

    case 'plugin':
      return cmdPlugin(rest)

    case 'config':
      return await cmdConfig(rest)

    case 'check':
      return runPluginCommand('commit-rules', 'check', rest)

    case 'report':
      return cmdReport()

    case 'hook': {
      const [name, ...args] = rest
      if (!isHookName(name)) return 0
      if (name === 'post-checkout' && needsReinstall()) {
        const repoRoot = findRepoRoot(process.cwd())
        if (repoRoot) installHooks(repoRoot, nodePath, cliEntry)
      }
      return dispatchHook(name, args)
    }

    default:
      process.stderr.write(`[devkit] 未知命令：${command}\n${HELP}`)
      return 1
  }
}

const invokedAsHook = process.argv[2] === 'hook'

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[devkit] ${message}\n`)
    // hook 路径下任何异常都不得阻断 git
    process.exit(invokedAsHook ? 0 : 1)
  })
