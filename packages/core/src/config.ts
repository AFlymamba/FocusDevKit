import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { paths, REPO_CONFIG_FILE, readTextIfExists } from './paths.js'

export interface PluginSettings {
  enabled?: boolean
  /**
   * 作用目录（含其所有子目录）。
   *
   * - 未设置 / 空数组 → 全局生效：所有已启用 fxdevkit 的仓库都加载该插件
   * - 设置了 → 只有仓库根目录位于其中某个目录下（含子目录）才加载
   *
   * 判定由内核完成，插件自身不感知，也不该自己读这个字段。
   */
  projects?: string[]
}

export interface FxDevkitConfig {
  server: {
    url: string | null
    mock: boolean
    timeoutMs: number
  }
  telemetry: {
    enabled: boolean
  }
  hooks: {
    /** hook 内单个插件的硬超时。超时即跳过，不阻断 git 操作 */
    timeoutMs: number
  }
  plugins: Record<string, PluginSettings & Record<string, unknown>>
}

const DEFAULT_CONFIG: FxDevkitConfig = {
  server: { url: null, mock: true, timeoutMs: 3000 },
  telemetry: { enabled: true },
  hooks: { timeoutMs: 1000 },
  plugins: {},
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 数组整体替换，对象递归合并 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (Array.isArray(patch)) return patch as unknown as T
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as unknown as T
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? deepMerge(out[key], value) : value
  }
  return out as T
}

export interface ConfigLayer {
  name: string
  path?: string
  applied: boolean
}

export interface LoadedConfig {
  config: FxDevkitConfig
  layers: ConfigLayer[]
}

function readYamlFile(file: string): unknown {
  const text = readTextIfExists(file)
  if (text == null || text.trim() === '') return undefined
  try {
    return parseYaml(text)
  } catch {
    return undefined
  }
}

export function loadConfig(repoRoot: string | null): LoadedConfig {
  const layers: ConfigLayer[] = []
  let config = DEFAULT_CONFIG

  // 第 1 层：工程默认（<repo>/.fxdevkit.yaml），跟工程走、进 git
  const repoFile = repoRoot == null ? null : path.join(repoRoot, REPO_CONFIG_FILE)
  const repoRaw = repoFile == null ? undefined : readYamlFile(repoFile)
  layers.push({ name: 'project', path: repoFile ?? undefined, applied: repoRaw !== undefined })
  if (repoRaw !== undefined) config = deepMerge(config, repoRaw)

  // 第 2 层：用户自定义（~/.fxdevkit/config.yaml），覆盖工程默认
  const userFile = paths.userConfig
  const userRaw = readYamlFile(userFile)
  layers.push({ name: 'user', path: userFile, applied: userRaw !== undefined })
  if (userRaw !== undefined) config = deepMerge(config, userRaw)

  // 环境变量覆盖：只覆盖标量，避免 ENV 表达复杂结构
  const envUrl = process.env.FXDEVKIT_SERVER_URL
  if (envUrl) {
    config = deepMerge(config, { server: { url: envUrl, mock: false } })
  }
  if (process.env.FXDEVKIT_SERVER_MOCK === '1') {
    config = deepMerge(config, { server: { mock: true } })
  }
  if (process.env.FXDEVKIT_TELEMETRY === '0') {
    config = deepMerge(config, { telemetry: { enabled: false } })
  }
  const hookTimeout = Number(process.env.FXDEVKIT_HOOK_TIMEOUT_MS)
  if (Number.isFinite(hookTimeout) && hookTimeout > 0) {
    config = deepMerge(config, { hooks: { timeoutMs: hookTimeout } })
  }
  layers.push({ name: 'env', applied: true })

  return { config, layers }
}

export function pluginConfig(config: FxDevkitConfig, pluginId: string): Record<string, unknown> {
  return config.plugins[pluginId] ?? {}
}

export function isPluginEnabled(config: FxDevkitConfig, pluginId: string): boolean {
  return config.plugins[pluginId]?.enabled !== false
}

export function writeUserConfig(patch: Record<string, unknown>): void {
  const existing = (readYamlFile(paths.userConfig) as Record<string, unknown>) ?? {}
  const merged = deepMerge(existing, patch)
  fs.mkdirSync(paths.home, { recursive: true })
  fs.writeFileSync(paths.userConfig, JSON.stringify(merged, null, 2), 'utf8')
}
