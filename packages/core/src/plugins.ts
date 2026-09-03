import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { HookName, Permission, PluginDefinition, PluginManifest } from '@devkit/sdk'
import { paths } from './paths.js'

export const PLUGIN_API_VERSION = 1

export interface DiscoveredPlugin {
  id: string
  version: string
  dir: string
  entry: string
  manifest: PluginManifest
}

export interface DiscoveredWithReason extends DiscoveredPlugin {
  /** apiVersion 不兼容等原因导致的跳过原因 */
  skipped?: string
}

function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * 从某个文件位置逐级向上，找到真正包含 @devkit 作用域的 node_modules。
 *
 * 不能靠 require.resolve 反推固定层级：npm workspaces 下包是符号链接，
 * resolve 会返回 packages/ 下的真实路径，层级与 node_modules 布局不一致。
 */
function locateScopeDir(fromFile: string): string | null {
  let dir = path.dirname(fromFile)
  for (;;) {
    const scope = path.join(dir, 'node_modules', '@devkit')
    if (dirExists(scope)) return scope
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function candidateDirs(repoRoot: string | null): string[] {
  const dirs: string[] = []
  if (repoRoot) {
    dirs.push(path.join(repoRoot, 'node_modules', '@devkit'))
    dirs.push(path.join(repoRoot, 'node_modules'))
  }
  dirs.push(paths.plugins)
  dirs.push(path.join(paths.home, 'node_modules', '@devkit'))

  const extra = process.env.DEVKIT_PLUGIN_PATHS
  if (extra) dirs.push(...extra.split(path.delimiter).filter(Boolean))

  // devkit 自身安装位置的 node_modules。
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
      devkit?: PluginManifest
    }
    const manifest = pkg.devkit
    if (!manifest?.id) return

    const entryFile = pkg.main ?? 'dist/index.js'
    const entry = path.resolve(pkgDir, entryFile)
    if (!fs.existsSync(entry)) return

    if (out.has(manifest.id)) return
    out.set(manifest.id, {
      id: manifest.id,
      version: pkg.version ?? '0.0.0',
      dir: pkgDir,
      entry,
      manifest,
      skipped:
        manifest.apiVersion !== PLUGIN_API_VERSION
          ? `apiVersion ${manifest.apiVersion} 与内核 ${PLUGIN_API_VERSION} 不兼容`
          : undefined,
    })
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
    if (entry.name.startsWith('plugin-') && path.basename(dir) === '@devkit') {
      collect(path.join(dir, entry.name), out)
    } else if (entry.name.startsWith('devkit-plugin-')) {
      collect(path.join(dir, entry.name), out)
    }
  }
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
