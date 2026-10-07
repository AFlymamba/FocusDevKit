import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ⚠️ 必须在 import 任何 dist 模块之前设置：paths.ts 在首次 import 时固化
// FXDEVKIT_HOME，之后改 env 无效。先隔离，避免测试读写真实 ~/.fxdevkit。
process.env.FXDEVKIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdevkit-core-test-'))
const isolatedHome = process.env.FXDEVKIT_HOME
after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }))

const {
  dispatcherScript,
  HOOK_SCRIPT_VERSION,
  isDirExcluded,
  addExclude,
  unsafeExcludeReason,
  pluginScope,
  discoverPlugins,
  createEmitter,
  createSilentEmitter,
  listLogDays,
  loadConfig,
  isPluginEnabled,
  runPluginCommand,
} = await import('../dist/index.js')

/**
 * dispatcher 脚本是整条增强链路的闸门，退出码语义是产品铁律的最后一道防线：
 *   只有 1 阻断；node 崩溃（127 等）、入口失效、插件崩溃一律放行。
 */
test('dispatcher 脚本：带版本戳，node 三级解析齐备', () => {
  const script = dispatcherScript('commit-msg', '/some/node', '/some/entry.js')
  assert.match(script, new RegExp(`^# fxdevkit-hook v${HOOK_SCRIPT_VERSION} · commit-msg$`, 'm'))
  // ① env 覆盖 ② 安装时记录 ③ PATH 兜底，三级缺一不可
  assert.match(script, /FXDEVKIT_NODE/)
  assert.match(script, /command -v node/)
  // node 彻底找不到时告警并放行，绝不 exit 1
  assert.match(script, /echo .*>&2/)
  assert.match(script, /exit 0/)
})

test('dispatcher 脚本：入口不存在时静默放行', () => {
  const script = dispatcherScript('pre-push', '/some/node', '/gone/entry.js')
  // [ -e entry ] || exit 0 —— fxdevkit 被卸载但 hooks 残留的场景
  assert.match(script, /\[ -e "\/gone\/entry\.js" \] \|\| exit 0/)
})

test('dispatcher 脚本：只有退出码 1 透传为阻断', () => {
  const script = dispatcherScript('commit-msg', '/node', '/entry.js')
  assert.match(script, /\[ "\$code" -eq 1 \] && exit 1/)
  assert.match(script, /exit 0\n?$/m)
})

test('exclude：黑名单命中含子目录，根/主目录被拒绝写入', () => {
  assert.equal(unsafeExcludeReason('C:\\'), '驱动器根目录不能被排除')
  assert.equal(unsafeExcludeReason(os.homedir()), '用户主目录不能被排除')
  assert.equal(unsafeExcludeReason('D:/projects/legacy'), null)

  addExclude('D:/projects/legacy')
  assert.equal(isDirExcluded({ exclude: ['D:/projects/legacy'] }, 'D:/projects/legacy/sub'), true)
  assert.equal(isDirExcluded({ exclude: ['D:/projects/legacy'] }, 'D:/projects/other'), false)
})

test('scope：projects 未配置即全局，配置后按前缀匹配（Windows 忽略大小写）', () => {
  const config = { plugins: { 'plugin-x': { projects: ['D:/products/order-service'] } } }

  assert.equal(pluginScope({ plugins: {} }, 'plugin-x', 'D:/any').inScope, true)
  assert.equal(pluginScope(config, 'plugin-x', 'D:/products/order-service/app').inScope, true)
  assert.equal(pluginScope(config, 'plugin-x', 'd:/PRODUCTS/order-service').inScope, true)
  assert.equal(pluginScope(config, 'plugin-x', 'D:/products/other').inScope, false)
})

test('插件发现：id 必须形如 plugin-xxx，apiVersion 不匹配标记跳过', () => {
  const mkPlugin = (dir, id, apiVersion) => {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: `@fxdevkit/${id}`,
      version: '0.1.0',
      main: 'dist/index.js',
      fxdevkit: { id, apiVersion, hooks: ['commit-msg'] },
    }))
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'export default { id: ' + JSON.stringify(id) + ' }')
  }

  // 扫描只认 `@fxdevkit/plugin-*` 或 `fxdevkit-plugin-*` 目录布局
  mkPlugin(path.join(isolatedHome, 'plugins', 'fxdevkit-plugin-ok'), 'plugin-ok', 1)
  mkPlugin(path.join(isolatedHome, 'plugins', 'fxdevkit-plugin-badid'), 'commit-rules', 1)
  mkPlugin(path.join(isolatedHome, 'plugins', 'fxdevkit-plugin-badapi'), 'plugin-badapi', 99)

  const found = discoverPlugins(null)
  const byId = new Map(found.map((p) => [p.id, p]))
  assert.ok(byId.has('plugin-ok'), '合规插件应被发现')
  assert.equal(byId.get('plugin-ok')?.skipped, undefined)
  assert.match(byId.get('commit-rules')?.skipped ?? '', /plugin-xxx/)
  assert.match(byId.get('plugin-badapi')?.skipped ?? '', /apiVersion/)
})

test('事件：真实 emitter 落盘，silent emitter 不落盘', () => {
  const eventsDir = path.join(isolatedHome, 'events')

  createEmitter('plugin-x', { repoRoot: null, branch: null })('test.event', {})
  assert.equal(fs.readdirSync(eventsDir).length, 1)

  const before = fs.readdirSync(eventsDir).length
  createSilentEmitter()('test.event', {})
  assert.equal(fs.readdirSync(eventsDir).length, before)
})

/**
 * logs 目录下混着 wrapper.log（Cursor git wrapper 的诊断日志，不属于某一天）。
 * 它曾经被当成「日期」列进 fxdevkit logs --days，让人以为有个叫 wrapper 的日期。
 */
test('日志日期：只认 YYYY-MM-DD，wrapper.log 不算一天', () => {
  const logsDir = path.join(isolatedHome, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.writeFileSync(path.join(logsDir, '2026-09-17.log'), '')
  fs.writeFileSync(path.join(logsDir, '2026-09-18.log'), '')
  fs.writeFileSync(path.join(logsDir, 'wrapper.log'), '')

  assert.deepEqual(listLogDays(), ['2026-09-17', '2026-09-18'])
})

test('配置：默认配置健全，enabled 默认为 true', () => {
  const { config } = loadConfig()
  assert.equal(config.telemetry.enabled, true)
  assert.equal(config.hooks.timeoutMs, 1000)
  // exclude 测试写入过一条，此时应能读回（写入落在隔离目录）
  assert.deepEqual(config.exclude, ['D:/projects/legacy'])
  assert.equal(isPluginEnabled(config, '不存在的插件'), true)
  assert.equal(isPluginEnabled({ plugins: { 'plugin-x': { enabled: false } } }, 'plugin-x'), false)
})

/**
 * configStore 是插件唯一能持久化自己配置的通道。
 * 两条约束都在这里锁住：
 *   1. 写出的内容只能落在 plugins.<自身 id> 下——插件碰不到全局配置，也碰不到别人的
 *   2. 未声明 fs:global 时是空实现，不落盘（不是抛错，插件不需要写两套分支）
 */
test('配置写回：写入被限制在自身命名空间，未声明 fs:global 时不落盘', async () => {
  const mkWriter = (dirName, id, permissions) => {
    const dir = path.join(isolatedHome, 'plugins', dirName)
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: `@fxdevkit/${id}`,
        version: '0.1.0',
        main: 'dist/index.js',
        fxdevkit: { id, apiVersion: 1, commands: ['write'], permissions },
      }),
    )
    fs.writeFileSync(
      path.join(dir, 'dist', 'index.js'),
      `export default {
  id: ${JSON.stringify(id)},
  commands: {
    write: {
      handler(_argv, ctx) {
        ctx.configStore.set({ rules: [{ name: 'x' }], exclude: ['/evil'] })
        return 0
      },
    },
  },
}
`,
    )
  }

  mkWriter('fxdevkit-plugin-writer', 'plugin-writer', ['fs:global'])
  mkWriter('fxdevkit-plugin-noperm', 'plugin-noperm', [])

  assert.equal(await runPluginCommand('plugin-writer', 'write', []), 0)
  assert.equal(await runPluginCommand('plugin-noperm', 'write', []), 0)

  const { config } = loadConfig()
  const written = config.plugins['plugin-writer']
  assert.deepEqual(written?.rules, [{ name: 'x' }])
  // 想借 patch 写全局 exclude 也只会落在自己命名空间下
  assert.deepEqual(written?.exclude, ['/evil'])
  assert.ok(!(config.exclude ?? []).includes('/evil'), '全局 exclude 不应被插件写入')

  // 未授权：静默空实现，配置里连键都不该出现
  assert.equal(config.plugins['plugin-noperm'], undefined)
})
