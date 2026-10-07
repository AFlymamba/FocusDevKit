import os from 'node:os'
import { loadConfig, writeUserConfig } from './config.js'
import type { FxDevkitConfig } from './config.js'
import { isUnderDirectory, normalizeForCompare } from './scope.js'

/**
 * 全局排除目录（黑名单）。
 *
 * 语义：exclude 里的目录**及其子目录**一律不被增强。
 * 优先级高于插件的 `projects` 白名单——黑名单命中即跳过，不再看白名单。
 *
 * 状态存在 `~/.fxdevkit/config.yaml`，跟人走：换机器、重新 clone 都不丢。
 * 与仓库本地的 git config 相比，这是它存在的全部理由。
 */

/** 读取 exclude 列表（容错：非字符串项忽略） */
export function excludeList(config: FxDevkitConfig): string[] {
  const list = config.exclude
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
}

/** 该目录是否被排除（含其被上级目录覆盖的情况） */
export function isDirExcluded(config: FxDevkitConfig, dir: string | null): boolean {
  if (!dir) return false
  return excludeList(config).some((excluded) => isUnderDirectory(excluded, dir))
}

/**
 * 判断目标是否危险；安全返回 null。
 *
 * 盘根与用户主目录一旦写进 exclude 等于一次性排除一大片，事后极难排查，
 * 所以直接拒绝写入，而不是默默接受。
 */
export function unsafeExcludeReason(dir: string): string | null {
  const target = normalizeForCompare(dir)
  if (target === '/' || /^[a-z]:$/.test(target)) return '驱动器根目录不能被排除'
  const home = normalizeForCompare(os.homedir())
  if (target === home || isUnderDirectory(target, home)) return '用户主目录不能被排除'
  return null
}

export interface ExcludeChange {
  /** 列表是否真的变了 */
  changed: boolean
  list: string[]
}

/** 把目录加入 exclude。已被覆盖（含已存在）时不重复写入 */
export function addExclude(dir: string): ExcludeChange {
  const current = excludeList(loadConfig().config)
  if (current.some((excluded) => isUnderDirectory(excluded, dir))) {
    return { changed: false, list: current }
  }
  const next = [...current, dir]
  writeUserConfig({ exclude: next })
  return { changed: true, list: next }
}

/**
 * 从 exclude 中移除目录。
 *
 * 只移除「等于该目录或其子目录」的条目；若覆盖它的是**上级条目**，
 * 该条目保留（删掉会连带放开同级其它目录），由调用方向用户提示。
 */
export function removeExclude(dir: string): ExcludeChange {
  const current = excludeList(loadConfig().config)
  const next = current.filter((excluded) => !isUnderDirectory(dir, excluded))
  if (next.length === current.length) return { changed: false, list: current }
  writeUserConfig({ exclude: next })
  return { changed: true, list: next }
}
