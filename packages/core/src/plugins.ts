import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { HookName, Permission, PluginDefinition, PluginManifest } from '@fxdevkit/sdk'
import { paths } from './paths.js'

export const PLUGIN_API_VERSION = 1

export interface DiscoveredPlugin {
  id: string
  /** 命令行短名，全局唯一，用于 `fxdevkit <name> ...` */
  name: string
  version: string
  dir: string
  entry: string
  manifest: PluginManifest
}

export interface DiscoveredWithReason extends DiscoveredPlugin {
  /** apiVersion 不兼容导致的跳过原因 */
  skipped?: string
  /** 同一 id 存在多份时，被版本选择忽略的版本与所在目录 */
  ignoredVersions?: { version: string; dir: string }[]
}

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * 从某个文件位置逐级向上，找到真正包含 @fxdevkit 作用域的 node_modules。
 *
 * 不能靠 require.resolve 反推固定层级：npm workspaces 下包是符号链接，
 * resolve 会返回 packages/ 下的真实路径，层级与 node_modules 布局不一致。
 */
function locateScopeDir(fromFile: string): string | null {
  let dir = path.dirname(fromFile)
  for (;;) {
    const scope = path.join(dir, 'node_modules', '@fxdevkit')
    if (dirExists(scope)) return scope
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function candidateDirs(repoRoot: string | null): string[] {
  const dirs: string[] = []
  if (repoRoot) {
    dirs.push(path.join(repoRoot, 'node_modules', '@fxdevkit'))
    dirs.push(path.join(repoRoot, 'node_modules'))
  }
  dirs.push(paths.plugins)
  dirs.push(path.join(paths.home, 'node_modules', '@fxdevkit'))

  const extra = process.env.FXDEVKIT_PLUGIN_PATHS
  if (extra) dirs.push(...extra.split(path.delimiter).filter(Boolean))

  // fxdevkit 自身安装位置的 node_modules。
  // 以内核自身位置为起点，不依赖任何包的 exports 配置（CJS 解析 ESM-only 包会失败）。
  const scope = locateScopeDir(fileURLToPath(import.meta.url))
  if (scope) {
    dirs.push(scope)
    dirs.push(path.resolve(scope, '..'))
  }

  return dirs.filter(dirExists)
}

function collect(pkgDir: string, out: Map<string, DiscoveredWithReason>): void {
  try {
    const pkgPath = path.join(pkgDir, 'package.json')
    if (!fs.existsSync(pkgPath)) return
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      name?: string
      version?: string
      main?: string
      fxdevkit?: PluginManifest
    }
    const manifest = pkg.fxdevkit
    if (!manifest?.id) return

    const entryFile = pkg.main ?? 'dist/index.js'
    const entry = path.resolve(pkgDir, entryFile)
    if (!fs.existsSync(entry)) return

    const version = pkg.version ?? '0.0.0'
    const record: DiscoveredWithReason = {
      id: manifest.id,
      name: manifest.name ?? manifest.id,
      version,
      dir: pkgDir,
      entry,
      manifest,
      skipped:
        manifest.apiVersion !== PLUGIN_API_VERSION
          ? `apiVersion ${manifest.apiVersion} 与内核 ${PLUGIN_API_VERSION} 不兼容`
          : undefined,
    }

    const existing = out.get(manifest.id)
    if (!existing) {
      out.set(manifest.id, record)
      return
    }

    // 同一 id 存在多份时取版本更高的一份；被忽略的留档，使选择过程可审查。
    // 版本相同说明是同一份在多个候选目录被重复扫到（workspaces 符号链接），静默跳过。
    const ignored = existing.ignoredVersions ?? []
    const cmp = compareVersion(version, existing.version)
    if (cmp > 0) {
      ignored.push({ version: existing.version, dir: existing.dir })
      out.set(manifest.id, { ...record, ignoredVersions: ignored })
    } else if (cmp < 0) {
      ignored.push({ version, dir: pkgDir })
      existing.ignoredVersions = ignored
    }
  } catch {
    /* 单个包异常不影响其他插件 */
  }
}

function scanDir(dir: string, out: Map<string, DiscoveredWithReason>): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const isDirLike = entry.isDirectory() || entry.isSymbolicLink()
    if (!isDirLike) continue

    if (entry.name.startsWith('@')) {
      scanDir(path.join(dir, entry.name), out)
      continue
    }
    if (entry.name.startsWith('plugin-') && path.basename(dir) === '@fxdevkit') {
      collect(path.join(dir, entry.name), out)
    } else if (entry.name.startsWith('fxdevkit-plugin-')) {
      collect(path.join(dir, entry.name), out)
    }
  }
}

function parseVersion(version: string): number[] | null {
  const parts = version.split(/[.\-+]/).map((part) => Number.parseInt(part, 10))
  return parts.some((part) => Number.isNaN(part)) ? null : parts
}

/** 语义化版本比较。无法解析时返回 0，保持先到先得 */
function compareVersion(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function discoverPlugins(repoRoot: string | null): DiscoveredWithReason[] {
  const found = new Map<string, DiscoveredWithReason>()
  for (const dir of candidateDirs(repoRoot)) scanDir(dir, found)
  return [...found.values()]
}

export function selectPlugins(
  plugins: DiscoveredWithReason[],
  hook: HookName,
): DiscoveredWithReason[] {
  return plugins.filter((p) => p.manifest.hooks?.includes(hook))
}

export async function loadPlugin(
  discovered: DiscoveredPlugin,
): Promise<PluginDefinition<any> | null> {
  try {
    const mod = (await import(pathToFileURL(discovered.entry).href)) as {
      default?: PluginDefinition<any>
    }
    const definition = mod.default
    if (!definition) return null
    if (definition.id !== discovered.id) return null
    return definition
  } catch {
    return null
  }
}

export function hasPermission(
  granted: ReadonlySet<Permission> | undefined,
  required: Permission,
): boolean {
  return granted?.has(required) ?? false
}

export function permissionSet(manifest: PluginManifest): ReadonlySet<Permission> {
  return new Set(manifest.permissions ?? [])
}
