import { execFileSync } from 'node:child_process'
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
 * dispatcher 脚本。
 *
 * 退出码约定：
 *   0 → 放行
 *   1 → 插件业务性拒绝（reject）
 *   其他 / node 崩溃 → 一律放行，绝不阻断开发
 */
function dispatcherScript(hookName: string, nodePath: string, cliEntry: string): string {
  return [
    '#!/bin/sh',
    `# managed by fxDevKit · ${hookName}`,
    `"${nodePath}" "${cliEntry}" hook ${hookName} "$@"`,
    'code=$?',
    '[ "$code" -eq 1 ] && exit 1',
    'exit 0',
    '',
  ].join('\n')
}

export function getHooksPath(cwd: string = process.cwd()): string | null {
  try {
    return (
      execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    )
  } catch {
    return null
  }
}

export interface InstallResult {
  hooksDir: string
  installed: HookName[]
  previousHooksPath: string | null
}

export function installHooks(cwd: string, nodePath: string, cliEntry: string): InstallResult {
  ensureLayout()
  const previous = getHooksPath(cwd)

  for (const hook of MANAGED_HOOKS) {
    const file = path.join(paths.hooks, hook)
    fs.writeFileSync(file, dispatcherScript(hook, nodePath, cliEntry), 'utf8')
    try {
      fs.chmodSync(file, 0o755)
    } catch {
      /* Windows 无 chmod 语义，忽略 */
    }
  }

  execFileSync('git', ['config', 'core.hooksPath', paths.hooks], { cwd })

  return { hooksDir: paths.hooks, installed: MANAGED_HOOKS, previousHooksPath: previous }
}

export function uninstallHooks(cwd: string): void {
  try {
    execFileSync('git', ['config', '--unset', 'core.hooksPath'], { cwd })
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

/** post-checkout 里用它自动重装，解决 clone 后 hook 丢失的问题 */
export function needsReinstall(cwd: string = process.cwd()): boolean {
  return getHooksPath(cwd) !== paths.hooks
}
