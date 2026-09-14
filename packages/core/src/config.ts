import fs from 'node:fs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { paths, readTextIfExists } from './paths.js'

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
  /**
   * 全局排除目录（黑名单，含子目录）。
   *
   * 命中即不被增强，优先级高于插件自身的 `projects` 白名单。
   * 用 `fxdevkit disable` / `enable` 维护，也可直接手改本文件。
   */
  exclude: string[]
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
  exclude: [],
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

/**
 * 配置只有「源码默认 + 用户覆盖」两层（XDG-style）：
 *   1. 插件代码内置 DEFAULT_CONFIG（npm 安装路径内，不可改、升级会被覆盖）
 *   2. 用户配置 ~/.fxdevkit/config.yaml（跟人走，跨升级保留）
 *   3. 环境变量覆盖（仅用于临时调试）
 *
 * 工程目录零侵入：<repo>/.fxdevkit.yaml 这一层不存在。
 * 别问"那某工程跟其他不一样怎么办"，等真出现再说（YAGNI）。
 */
export function loadConfig(): LoadedConfig {
  const layers: ConfigLayer[] = []
  let config = DEFAULT_CONFIG

  // 第 1 层：用户配置（~/.fxdevkit/config.yaml）
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
  // 文件是 .yaml，就写真 YAML（JSON 虽然也是 YAML 的子集，但读起来别扭）
  fs.writeFileSync(paths.userConfig, stringifyYaml(merged), 'utf8')
}
