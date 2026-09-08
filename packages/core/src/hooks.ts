import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { HookName } from '@fxdevkit/sdk'
import { ensureLayout, paths } from './paths.js'

export const MANAGED_HOOKS: HookName[] = [
  'commit-msg',
  'prepare-commit-msg',
  'post-checkout',
  'post-merge',
  'pre-commit',
  'pre-push',
]

/**
 * 仓库级启用开关的 git config 键。
 *
 * 全局 hooks 装好后，所有仓库**默认都会被插件增强**（默认启用）。
 * 这个键只在显式设为 `false` 时表示「停用」，用于排除个别不想增强的仓库。
 * 目录级收窄请用插件的 projects 作用域，而不是逐个仓库关开关。
 */
export const REPO_ENABLED_KEY = 'fxdevkit.enabled'

/**
 * dispatcher 脚本。
 *
 * 退出码约定：
 *   0 → 放行
 *   1 → 阻断（插件业务性 reject，或仓库自有 hook 失败）
 *   其他 / node 崩溃 → 一律放行，绝不阻断开发
 */
function dispatcherScript(hookName: string, nodePath: string, cliEntry: string): string {
  return [
    '#!/bin/sh',
    `# managed by fxDevKit · ${hookName}`,
    // 入口（Node 或 CLI 脚本）已不存在 = fxdevkit 被卸载但 hooks 残留，静默放行，
    // 绝不因「工具已卸载」阻断用户的 git 操作。
    `[ -e "${nodePath}" ] && [ -e "${cliEntry}" ] || exit 0`,
    `"${nodePath}" "${cliEntry}" hook ${hookName} "$@"`,
    'code=$?',
    '[ "$code" -eq 1 ] && exit 1',
    'exit 0',
    '',
  ].join('\n')
}

function gitConfig(args: string[], cwd?: string): string | null {
  try {
    return (
      execFileSync('git', ['config', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    )
  } catch {
    return null
  }
}

/** 全局 core.hooksPath。设了它，所有仓库（含以后新建的）都会走 dispatcher */
export function getGlobalHooksPath(): string | null {
  return gitConfig(['--global', '--get', 'core.hooksPath'])
}

/**
 * 仓库级 core.hooksPath。旧版本逐仓库托管时留下的，用于迁移判定。
 *
 * 必须用 --local：不带作用域的 --get 会回退读到全局值，导致新仓库
 * （本身没有仓库级配置）被误判为「需要迁移」，进而去 unset 一个不存在的键。
 */
export function getRepoHooksPath(cwd: string): string | null {
  return gitConfig(['--local', '--get', 'core.hooksPath'], cwd)
}

export function isGlobalInstalled(): boolean {
  return getGlobalHooksPath() === paths.hooks
}

/** 把 dispatcher 脚本写到 ~/.fxdevkit/hooks */
function writeDispatchers(nodePath: string, cliEntry: string): string {
  ensureLayout()
  for (const hook of MANAGED_HOOKS) {
    const file = path.join(paths.hooks, hook)
    fs.writeFileSync(file, dispatcherScript(hook, nodePath, cliEntry), 'utf8')
    try {
      fs.chmodSync(file, 0o755)
    } catch {
      /* Windows 无 chmod 语义，忽略 */
    }
  }
  return paths.hooks
}

export interface InstallResult {
  hooksDir: string
  installed: HookName[]
  /** 全局装过之后，本仓库是否也已启用 */
  repoEnabled: boolean
  /** 迁移信息：本仓库此前是否用旧的「逐仓库 core.hooksPath」方式托管 */
  migratedFromRepoHooksPath: string | null
}

/**
 * 安装全局 hooks。
 *
 * 一次设置，所有仓库（包括以后新建 / 克隆的）都会走 dispatcher。
 * 注意：git 的 core.hooksPath 是「替换」语义，所以 dispatcher 内部会
 * 主动执行仓库自有的 .git/hooks/<name>，不会取缔它们（见 runRepoOwnHook）。
 */
export function installGlobalHooks(nodePath: string, cliEntry: string): InstallResult {
  const hooksDir = writeDispatchers(nodePath, cliEntry)
  const previousGlobal = getGlobalHooksPath()

  gitConfig(['--global', 'core.hooksPath', paths.hooks])

  return {
    hooksDir,
    installed: MANAGED_HOOKS,
    repoEnabled: true,
    migratedFromRepoHooksPath: null,
    ...(previousGlobal ? { previousGlobal } : {}),
  } as InstallResult & { previousGlobal?: string }
}

/**
 * 在当前仓库显式启用 fxdevkit 增强（覆盖之前的停用标记）。
 *
 * 默认所有仓库都是启用的，本函数用于把某个此前 fxdevkit uninstall
 * 停用过的仓库重新拉回增强态。全局 hooks 未装时会自动补装。
 */
export function enableRepo(cwd: string, nodePath: string, cliEntry: string): InstallResult {
  const previousRepoHooksPath = getRepoHooksPath(cwd)
  let migrated: string | null = null

  if (!isGlobalInstalled()) {
    writeDispatchers(nodePath, cliEntry)
    gitConfig(['--global', 'core.hooksPath', paths.hooks])
  }

  // 迁移：旧版本是给每个仓库单独设 core.hooksPath。现在统一走全局，
  // 仓库级的值会盖住全局值，必须清掉，否则全局配置对它无效。
  if (previousRepoHooksPath) {
    try {
      execFileSync('git', ['config', '--unset', 'core.hooksPath'], {
        cwd,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
      migrated = previousRepoHooksPath
    } catch {
      /* 键已不存在时忽略 */
    }
  }

  gitConfig([REPO_ENABLED_KEY, 'true'], cwd)

  return {
    hooksDir: paths.hooks,
    installed: MANAGED_HOOKS,
    repoEnabled: true,
    migratedFromRepoHooksPath: migrated,
  }
}

export function disableRepo(cwd: string): void {
  gitConfig([REPO_ENABLED_KEY, 'false'], cwd)
}

/** 当前仓库是否启用了增强。默认启用——除非显式设 fxdevkit.enabled=false 停用 */
export function isRepoEnabled(cwd: string): boolean {
  return gitConfig(['--local', '--get', REPO_ENABLED_KEY], cwd) !== 'false'
}

/** 卸载全局 hooks：清 global core.hooksPath 并删除 dispatcher 脚本 */
export function uninstallGlobalHooks(): void {
  try {
    execFileSync('git', ['config', '--global', '--unset', 'core.hooksPath'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  } catch {
    /* 未设置时忽略 */
  }
  for (const hook of MANAGED_HOOKS) {
    try {
      fs.rmSync(path.join(paths.hooks, hook), { force: true })
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 决定用什么来执行一个 hook 脚本。
 *
 * Windows 下不能直接 spawn 带 shebang 的脚本——CreateProcess 不认
 * `#!/bin/sh`，cmd.exe 会报「不是可运行的程序」。所以要自己读 shebang
 * 取出解释器（sh / bash / node / python...），再把脚本路径作为参数传进去。
 * Unix 内核原生支持 shebang，直接执行即可。
 */
function resolveRunner(hookFile: string): { cmd: string; prefix: string[] } | null {
  if (process.platform !== 'win32') return { cmd: hookFile, prefix: [] }

  let firstLine = ''
  try {
    firstLine = fs.readFileSync(hookFile, 'utf8').split('\n')[0] ?? ''
  } catch {
    return { cmd: hookFile, prefix: [] }
  }

  const match = /^#!\s*(\S+)(.*)$/.exec(firstLine)
  // 没有 shebang：可能是 .exe / .bat / .cmd，交给系统直接执行
  if (!match) return { cmd: hookFile, prefix: [] }

  const rest = (match[2] ?? '').trim()
  const interpreter = match[1] ?? ''
  const last = interpreter.split('/').pop() ?? ''

  // #!/usr/bin/env bash 这类：真正的解释器在后面
  if (last === 'env') {
    const runner = rest.split(/\s+/)[0]
    if (!runner) return null
    return { cmd: runner, prefix: [hookFile] }
  }

  if (!last) return null
  return { cmd: last, prefix: [hookFile] }
}

/**
 * 执行仓库自有的 hook（`<repo>/.git/hooks/<name>`）。
 *
 * 全局 core.hooksPath 接管后，git 不会再执行仓库自己的 hooks。
 * 这里主动补执行，保证「不取缔、只追加」：
 *   - 项目级（仓库自有）优先于用户级（fxdevkit 全局增强）
 *   - 仓库自有 hook 返回非零 → 按 git 原生语义阻断，不继续跑增强
 *   - 仓库自有 hook 压根执行不起来（解释器缺失等）→ 返回 null 放行，
 *     绝不能因为「跑不起来」把用户的提交卡住
 *
 * @returns 退出码；hook 不存在或无法执行时返回 null
 */
export function runRepoOwnHook(repoRoot: string, hookName: string, args: string[]): number | null {
  let gitDir: string | null
  try {
    gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
  if (!gitDir) return null

  const hookFile = path.join(gitDir, 'hooks', hookName)
  if (!fs.existsSync(hookFile)) return null
  try {
    fs.accessSync(hookFile, fs.constants.X_OK)
  } catch {
    return null
  }

  // .sample 不是真 hook，git 也不会执行它们
  if (hookFile.endsWith('.sample')) return null

  const runner = resolveRunner(hookFile)
  if (!runner) return null

  try {
    const result = spawnSync(runner.cmd, [...runner.prefix, ...args], {
      cwd: repoRoot,
      stdio: 'inherit',
    })
    // 执行不起来（解释器缺失、权限问题）不算 hook 失败，按「无力执行」放行
    if (result.error) return null
    return result.status
  } catch {
    return null
  }
}

/** 兼容旧调用：默认语义为「在当前仓库启用」 */
export function installHooks(cwd: string, nodePath: string, cliEntry: string): InstallResult {
  return enableRepo(cwd, nodePath, cliEntry)
}

/** 兼容旧调用：默认语义为「在当前仓库停用」 */
export function uninstallHooks(cwd: string): void {
  disableRepo(cwd)
}

/** post-checkout 里用它判断是否需要重装 */
export function needsReinstall(): boolean {
  return !isGlobalInstalled()
}
