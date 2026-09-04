import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { GitContext } from '@fxdevkit/sdk'
import { paths, readJsonIfExists } from './paths.js'

function run(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

export function findRepoRoot(cwd: string = process.cwd()): string | null {
  return run(['rev-parse', '--show-toplevel'], cwd) || null
}

export function findGitDir(cwd: string): string | null {
  return run(['rev-parse', '--absolute-git-dir'], cwd) || null
}

/**
 * amend 状态。
 *
 * commit-msg hook 拿不到命令行参数，无法自行判断 --amend；
 * 只有 prepare-commit-msg 能拿到 source 与 commit sha。
 * 因此在这里落状态，由 commit-msg 消费。
 */
type AmendState = Record<string, { isAmend: boolean; ts: number }>

const STATE_TTL_MS = 5 * 60 * 1000

function stateFile(): string {
  return path.join(paths.cache, 'commit-state.json')
}

export function markAmendState(repoRoot: string, isAmend: boolean): void {
  try {
    const all = readJsonIfExists<AmendState>(stateFile()) ?? {}
    all[repoRoot] = { isAmend, ts: Date.now() }
    for (const [key, value] of Object.entries(all)) {
      if (Date.now() - value.ts > STATE_TTL_MS) delete all[key]
    }
    fs.writeFileSync(stateFile(), JSON.stringify(all), 'utf8')
  } catch {
    /* 状态记录失败不影响提交 */
  }
}

export function consumeAmendState(repoRoot: string): boolean {
  try {
    const all = readJsonIfExists<AmendState>(stateFile()) ?? {}
    const entry = all[repoRoot]
    delete all[repoRoot]
    fs.writeFileSync(stateFile(), JSON.stringify(all), 'utf8')
    return entry?.isAmend ?? false
  } catch {
    return false
  }
}

/** prepare-commit-msg 的参数：<file> <source> [<sha>]，source=commit 且带 sha 即为 amend */
export function isAmendInvocation(args: string[]): boolean {
  return args[1] === 'commit' && typeof args[2] === 'string' && args[2].length > 0
}

export function detectGitContext(cwd: string = process.cwd(), isAmend = false): GitContext {
  const root = findRepoRoot(cwd) ?? cwd
  const gitDir = findGitDir(root)

  const exists = (name: string): boolean =>
    gitDir != null && fs.existsSync(path.join(gitDir, name))

  return {
    root,
    branch: run(['symbolic-ref', '--short', 'HEAD'], root),
    isMerge: exists('MERGE_HEAD'),
    isRebase: exists('rebase-merge') || exists('rebase-apply'),
    isCherryPick: exists('CHERRY_PICK_HEAD'),
    isAmend,
  }
}
