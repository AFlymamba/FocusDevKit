import path from 'node:path'
import type { FxDevkitConfig } from './config.js'

/**
 * 作用目录判定。
 *
 * 规则（内核保证，插件无感）：
 *   - 插件未配置 projects → 全局生效，任何已启用的仓库都加载
 *   - 插件配置了 projects → 只有仓库根目录位于其中某目录（含子目录）才加载
 */

/** 统一为可比较形式：绝对路径 + 正斜杠 + Windows 下忽略大小写 + 去尾部斜杠 */
function normalizeForCompare(target: string): string {
  let out = path.resolve(target).replace(/\\/g, '/')
  if (process.platform === 'win32') out = out.toLowerCase()
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/** child 是否位于 parent 目录内（含子目录；child 等于 parent 也算命中） */
export function isUnderDirectory(parent: string, child: string): boolean {
  const p = normalizeForCompare(parent)
  const c = normalizeForCompare(child)
  return c === p || c.startsWith(p + '/')
}

export interface ScopeResult {
  inScope: boolean
  /** 未命中时的原因，供日志与 status 输出 */
  reason?: string
}

export function pluginScope(
  config: FxDevkitConfig,
  pluginId: string,
  repoRoot: string | null,
): ScopeResult {
  const projects = config.plugins[pluginId]?.projects

  // 未设置 → 全局生效
  if (!projects || projects.length === 0) return { inScope: true }

  // 设置了却不在仓库里 → 无从匹配，判定不生效
  if (!repoRoot) {
    return { inScope: false, reason: '不在 git 仓库中，无法匹配作用目录' }
  }

  if (projects.some((dir) => isUnderDirectory(dir, repoRoot))) return { inScope: true }

  return {
    inScope: false,
    reason: `当前仓库不在作用目录内（已配：${projects.join(', ')}）`,
  }
}
