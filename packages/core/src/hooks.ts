import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { HookName } from '@fxdevkit/sdk'
import { loadConfig, writeUserConfig } from './config.js'
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
 * dispatcher 脚本版本。
 *
 * 版本戳写进脚本，doctor 据此判断「盘上的 hook 是不是当前版本生成的」——
 * 老脚本没有自愈能力，只能靠版本号识别出来再提示重建。
 */
export const HOOK_SCRIPT_VERSION = 2

/**
 * dispatcher 脚本。
 *
 * 退出码约定：
 *   0 → 放行
 *   1 → 阻断（插件业务性 reject，或仓库自有 hook 失败）
 *   其他 / node 崩溃 → 一律放行，绝不阻断开发
 *
 * node 不写死单一路径，运行时按三级解析：
 *   ① 环境变量 FXDEVKIT_NODE（用户显式指定，最高优先级）
 *   ② 安装时记录的路径（确定性最好）
 *   ③ PATH 里的 node（兜底）
 *
 * 为什么必须这样：曾经把安装时刻的 node 绝对路径写死在脚本里，
 * node 一升级（IDE 内置 node 目录从 22.22.2-2 换成 22.22.2-3）路径就失效，
 * hook 退出码变成 127，脚本判定「非 1 → 放行」，于是整条增强链路静默失效，
 * 用户以为插件还在工作。三级解析 + 找不到时往 stderr 打一行告警，
 * 就是为了让这种失效不再无声。
 */
/** 生成 dispatcher 脚本内容（导出供体检与测试校验退出码语义） */
export function dispatcherScript(hookName: string, nodePath: string, cliEntry: string): string {
  return [
    '#!/bin/sh',
    `# fxdevkit-hook v${HOOK_SCRIPT_VERSION} · ${hookName}`,
    `# node: ${nodePath}`,
    `# entry: ${cliEntry}`,
    'FX_NODE="${FXDEVKIT_NODE:-}"',
    `[ -n "$FX_NODE" ] || FX_NODE="${nodePath}"`,
    `[ -e "$FX_NODE" ] || FX_NODE="$(command -v node 2>/dev/null)"`,
    'if [ ! -e "$FX_NODE" ]; then',
    '  echo "[fxdevkit] 未找到可用的 node，本次增强已跳过（修复：fxdevkit install）" >&2',
    '  exit 0',
    'fi',
    // CLI 入口已不存在 = fxdevkit 被卸载但 hooks 残留，静默放行，
    // 绝不因「工具已卸载」阻断用户的 git 操作。
    `[ -e "${cliEntry}" ] || exit 0`,
    `"$FX_NODE" "${cliEntry}" hook ${hookName} "$@"`,
    'code=$?',
    '[ "$code" -eq 1 ] && exit 1',
    'exit 0',
    '',
  ].join('\n')
}

/** 从 PATH 里找一个可用的 node，用于兜底与体检 */
function resolveNodeFromPath(): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where', ['node'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return out.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
    }
    const out = execFileSync('sh', ['-c', 'command -v node'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

export interface HooksHealth {
  ok: boolean
  /** 脚本是旧版生成的，需要重建才算修好 */
  outdated: boolean
  detail: string
  hint?: string
}

/**
 * 体检：盘上的 hook 脚本是否还有效。
 *
 * 查四件事：脚本在不在、是不是当前版本、CLI 入口在不在、node 还能不能找到。
 * node 记录路径失效不算致命——运行时会回退到 PATH 里的 node，
 * 只有当 PATH 里也没有时才判定为故障。
 */
export function checkHooksHealth(): HooksHealth {
  const script = path.join(paths.hooks, 'commit-msg')
  if (!fs.existsSync(script)) {
    return { ok: false, outdated: true, detail: '未生成', hint: '执行 fxdevkit install' }
  }

  const text = fs.readFileSync(script, 'utf8')
  const version = /^# fxdevkit-hook v(\d+)/m.exec(text)?.[1]
  const recordedNode = /^# node: (.+)$/m.exec(text)?.[1]?.trim()
  const entry = /^# entry: (.+)$/m.exec(text)?.[1]?.trim()

  if (!version || !entry) {
    return {
      ok: false,
      outdated: true,
      detail: '旧版脚本（无版本戳）',
      hint: '无法自检，执行 fxdevkit install 重建',
    }
  }

  if (!fs.existsSync(entry)) {
    return {
      ok: false,
      outdated: false,
      detail: 'CLI 入口失效',
      hint: `${entry} 不存在，执行 fxdevkit install 重建`,
    }
  }

  if (Number(version) < HOOK_SCRIPT_VERSION) {
    return {
      ok: false,
      outdated: true,
      detail: `脚本版本 v${version}（当前 v${HOOK_SCRIPT_VERSION}）`,
      hint: '执行 fxdevkit install 重建',
    }
  }

  const recordedOk = recordedNode != null && fs.existsSync(recordedNode)
  if (recordedOk) return { ok: true, outdated: false, detail: entry }

  const fallback = resolveNodeFromPath()
  if (!fallback) {
    return {
      ok: false,
      outdated: false,
      detail: 'Node 不可用',
      hint: '记录路径已失效，且 PATH 中找不到 node；执行 fxdevkit install 重建',
    }
  }

  return {
    ok: true,
    outdated: false,
    detail: `记录路径已失效，运行时回退 ${fallback}`,
    hint: '建议执行 fxdevkit install 更新记录路径',
  }
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
 *
 * 覆盖前把用户原有的全局 core.hooksPath 存进用户配置（previousHooksPath），
 * uninstall 时据此还原——不存的话，装一次就把用户原有的 hooks 配置永久冲掉。
 */
export function installGlobalHooks(nodePath: string, cliEntry: string): InstallResult {
  const hooksDir = writeDispatchers(nodePath, cliEntry)
  const previousGlobal = getGlobalHooksPath()

  // 首次覆盖非 fxdevkit 的旧值时记录；重复 install 覆盖的是自己的 hooks 目录，不覆盖记录
  if (previousGlobal && previousGlobal !== paths.hooks) {
    const { config } = loadConfig()
    if (!config.previousHooksPath) {
      writeUserConfig({ previousHooksPath: previousGlobal })
    }
  }

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
 * 卸载全局 hooks：清 global core.hooksPath 并删除 dispatcher 脚本。
 *
 * 若安装前用户另有全局 hooksPath（记录在 previousHooksPath），卸载时还原它，
 * 让原有的 hooks 管理器（husky 全局配置等）回到安装前的状态。
 */
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

  const { config } = loadConfig()
  const previous = config.previousHooksPath
  if (typeof previous === 'string' && previous !== '' && previous !== paths.hooks) {
    // 还原用户安装前的旧值；只有当当前值仍是我们的（或已不存在）时才动手，
    // 避免覆盖用户卸载前手动改过的配置
    const current = getGlobalHooksPath()
    if (current == null || current === paths.hooks) {
      gitConfig(['--global', 'core.hooksPath', previous])
    }
  }
  if (config.previousHooksPath != null) {
    writeUserConfig({ previousHooksPath: null })
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

/** post-checkout 里用它判断是否需要重装 */
export function needsReinstall(): boolean {
  return !isGlobalInstalled()
}
