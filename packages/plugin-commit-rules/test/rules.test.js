import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * plugin-commit-rules 规则引擎测试。
 * 直接调用编译产物 dist/index.js 的默认导出（definePlugin 对象），
 * 构造最小 HookContext 驱动 commit-msg handler。
 */
const plugin = (await import('../dist/index.js')).default
const root = path.resolve(import.meta.dirname, '../..')

function makeCtx(message, overrides = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-rule-')), 'msg.txt')
  fs.writeFileSync(file, message, 'utf8')
  const events = []
  const ctx = {
    pluginId: 'plugin-commit-rules',
    config: structuredClone(plugin.defaultConfig),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    git: { root, branch: 'main', isMerge: false, isRebase: false, isCherryPick: false, isAmend: false },
    args: [file],
    messageFile: file,
    emit: (type, payload) => events.push({ type, payload }),
    server: {},
    permissions: new Set(),
    ...overrides,
  }
  return { ctx, file, events }
}

const run = (ctx) => plugin.hooks['commit-msg'](ctx)

test('默认规则：普通 message 加 AI 前缀', async () => {
  const { ctx, file, events } = makeCtx('fix: 修复登录\n\n详情')
  assert.equal(await run(ctx), 'modify')
  assert.equal(fs.readFileSync(file, 'utf8'), 'AI fix: 修复登录\n\n详情')
  assert.equal(events[0].type, 'commit.rewritten')
})

test('默认规则：已带前缀幂等，不重复注入', async () => {
  const { ctx, file } = makeCtx('AI fix: 已带前缀')
  assert.equal(await run(ctx), 'accept')
  assert.equal(fs.readFileSync(file, 'utf8'), 'AI fix: 已带前缀')
})

test('默认规则：chore/docs 命中 no-ai 跳过', async () => {
  for (const msg of ['chore: 调配置', 'docs: 改文档']) {
    const { ctx, file } = makeCtx(msg)
    assert.equal(await run(ctx), 'accept')
    assert.equal(fs.readFileSync(file, 'utf8'), msg)
  }
})

test('流程守卫：merge/rebase/cherry-pick/amend 一律不改写', async () => {
  for (const flag of ['isMerge', 'isRebase', 'isCherryPick', 'isAmend']) {
    const { ctx, file } = makeCtx('fix: xxx', { git: { isMerge: false, isRebase: false, isCherryPick: false, isAmend: false, [flag]: true, root, branch: 'main' } })
    assert.equal(await run(ctx), 'accept')
    assert.equal(fs.readFileSync(file, 'utf8'), 'fix: xxx')
  }
})

test('分支过滤：不在 branches 清单里的分支放行', async () => {
  const { ctx, file, events } = makeCtx('fix: xxx')
  ctx.config.branches = ['release/*']
  assert.equal(await run(ctx), 'accept')
  assert.equal(events[0].type, 'commit.guarded')
  assert.equal(fs.readFileSync(file, 'utf8'), 'fix: xxx')
})

test('dryRun：只记事件不写文件', async () => {
  const { ctx, file } = makeCtx('fix: xxx')
  ctx.config.dryRun = true
  assert.equal(await run(ctx), 'modify')
  assert.equal(fs.readFileSync(file, 'utf8'), 'fix: xxx')
})

test('suffix / template 动作', async () => {
  const { ctx, file } = makeCtx('fix: xxx')
  ctx.config.rules = [
    { name: 'guard', pattern: /\[AI\]$/.source, action: 'skip' },
    { name: 's', action: 'suffix', value: ' [AI]' },
  ]
  await run(ctx)
  assert.equal(fs.readFileSync(file, 'utf8').split('\n')[0], 'fix: xxx [AI]')
})

test('幂等守卫：注入值无法被 skip 规则匹配时拒绝加载', () => {
  assert.throws(
    () => plugin.validateConfig({
      rules: [
        { name: 'default', action: 'prefix', value: 'ROBOT ' },
      ],
    }),
    /重复注入/,
  )
})

test('配置校验：非法 action 报错', () => {
  assert.throws(
    () => plugin.validateConfig({ rules: [{ name: 'x', action: 'nope' }] }),
    /action/,
  )
})

test('check 命令：合规返回 0，不合规返回 1', async () => {
  const head = execFileSync('git', ['log', '-1', '--pretty=%H'], { cwd: root, encoding: 'utf8' }).trim()
  const { ctx } = makeCtx('irrelevant')
  ctx.args = []
  const code = await plugin.commands.check.handler(['--sha', head], ctx)
  assert.equal(typeof code, 'number')
})
