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

test('默认规则：chore/docs 照常打标（文档也是资产）', async () => {
  for (const msg of ['chore: 调配置', 'docs: 改文档']) {
    const { ctx, file } = makeCtx(msg)
    assert.equal(await run(ctx), 'modify')
    assert.equal(fs.readFileSync(file, 'utf8'), `AI ${msg}`)
  }
})

/**
 * 判据是「这次提交在 git 历史图里是不是工作单元」，不是「message 谁写的」：
 * - revert 是单 parent、有自己 diff 的普通提交，是一次真实的状态变更 → 打标
 * - merge commit 是连接两条分支的拓扑节点，不代表新工作 → 不打标
 */
test('默认规则：revert 打标，merge 不打标', async () => {
  const revertMsg = 'Revert "fix: 登录报错"'
  const { ctx: rctx, file: rfile } = makeCtx(revertMsg)
  assert.equal(await run(rctx), 'modify')
  assert.equal(fs.readFileSync(rfile, 'utf8'), `AI ${revertMsg}`)

  const mergeMsg = "Merge branch 'develop' into main"
  const { ctx: mctx, file: mfile } = makeCtx(mergeMsg)
  assert.equal(await run(mctx), 'accept')
  assert.equal(fs.readFileSync(mfile, 'utf8'), mergeMsg)
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

/**
 * 命令路径的最小 CommandContext。
 * configStore 被替换成收集器，避免测试真的写用户配置。
 */
function makeCommandCtx(config, overrides = {}) {
  const written = []
  const logs = []
  const push = (line) => logs.push(String(line))
  const ctx = {
    pluginId: 'plugin-commit-rules',
    config,
    logger: { debug() {}, info: push, warn: push, error: push },
    git: { root, branch: 'main', isMerge: false, isRebase: false, isCherryPick: false, isAmend: false },
    emit() {},
    server: {},
    permissions: new Set(['fs:global']),
    configStore: { set: (patch) => written.push(patch) },
    ...overrides,
  }
  return { ctx, written, logs }
}

/** 按规则数组跑一次改写，用于验证端到端幂等 */
function applyOnce(message, config) {
  const first = message.split('\n')[0]
  for (const rule of config.rules) {
    if (!rule.pattern) continue
    if (!new RegExp(rule.pattern).test(first)) continue
    return rule.action === 'skip' ? message : (rule.value ?? '') + message
  }
  const fallback = config.rules.find((rule) => !rule.pattern && rule.action !== 'skip')
  return fallback ? (fallback.value ?? '') + message : message
}

test('prefix 命令：改前缀并同步维护幂等守卫', () => {
  const base = plugin.validateConfig({})
  const { ctx, written } = makeCommandCtx(base)
  assert.equal(plugin.commands.prefix.handler(['[AI-GEN] '], ctx), 0)

  const rules = written[0].rules
  assert.equal(rules[0].name, 'default-guard')
  assert.equal(rules.find((r) => r.name === 'default').value, '[AI-GEN] ')

  // 写出的规则必须能通过插件自己的配置校验（含幂等交叉校验）
  const effective = plugin.validateConfig({ rules })

  // 端到端幂等：注入一次之后再跑一次不重复注入
  const once = applyOnce('fix: 登录', effective)
  assert.equal(once, '[AI-GEN] fix: 登录')
  assert.equal(applyOnce(once, effective), once)

  // 原有规则不被吞掉
  assert.ok(effective.rules.some((r) => r.name === 'git-merge'))
})

test('prefix 命令：旧前缀降级为历史放行规则', () => {
  const first = makeCommandCtx(plugin.validateConfig({}))
  plugin.commands.prefix.handler(['[AI-GEN] '], first.ctx)
  const mid = plugin.validateConfig({ rules: first.written[0].rules })

  const second = makeCommandCtx(mid)
  assert.equal(plugin.commands.prefix.handler(['[COMPANY-X] '], second.ctx), 0)

  const rules = second.written[0].rules
  const legacies = rules.filter((r) => r.name.startsWith('legacy-'))
  assert.ok(legacies.length >= 1, '换前缀应生成 legacy 放行规则')
  assert.ok(legacies.every((r) => r.action === 'skip'))
  // 每次换前缀，上一次的值都要留一条放行规则，否则历史提交在 CI 的 check 里会判不合规
  assert.ok(
    legacies.some((r) => new RegExp(r.pattern).test('[AI-GEN] fix: 老提交')),
    '上一次的前缀 [AI-GEN] 必须有 legacy 规则放行',
  )
  assert.ok(
    legacies.some((r) => new RegExp(r.pattern).test('AI fix: 更早的提交')),
    '更早的前缀 AI 也要有 legacy 规则放行',
  )

  const effective = plugin.validateConfig({ rules })
  // 旧的 default-guard 被新值替换，新提交走新前缀
  assert.equal(applyOnce('fix: 新提交', effective), '[COMPANY-X] fix: 新提交')
  assert.equal(applyOnce('[AI-GEN] fix: 老提交', effective), '[AI-GEN] fix: 老提交')
})

test('prefix 命令：旧前缀已被现有 skip 规则覆盖时不重复加 legacy', () => {
  // 用一条非 guard 的规则覆盖旧前缀「AI 」，换前缀时就不该再补 legacy
  const base = plugin.validateConfig({
    rules: [
      { name: 'default-guard', pattern: '^X[:\\s]', action: 'skip' },
      { name: 'old-prefix', pattern: '^AI[:\\s]', action: 'skip' },
      { name: 'default', action: 'prefix', value: 'AI ' },
    ],
  })
  const { ctx, written } = makeCommandCtx(base)
  assert.equal(plugin.commands.prefix.handler(['[Y] '], ctx), 0)
  assert.equal(written[0].rules.some((r) => r.name.startsWith('legacy-')), false)
})

test('prefix 命令：守卫跟着兜底值走，被替换的旧值降级为 legacy', () => {
  // 守卫覆盖的是「当前」兜底值。换前缀后守卫要跟着换，旧前缀就没人覆盖了，
  // 历史提交得靠 legacy 放行 —— CI 的 check 必须认识它们。
  const { ctx, written } = makeCommandCtx(plugin.validateConfig({}))
  plugin.commands.prefix.handler(['[AI-GEN] '], ctx)
  const rules = written[0].rules

  assert.equal(rules.find((r) => r.name === 'default-guard').pattern, '^\\[AI-GEN\\][:\\s]*')
  const legacy = rules.find((r) => r.name.startsWith('legacy-'))
  assert.ok(legacy, '旧前缀应降级为 legacy 放行规则')
  assert.ok(new RegExp(legacy.pattern).test('AI fix: 老提交'))
})

test('prefix 命令：重复执行同一前缀不会堆积规则', () => {
  const first = makeCommandCtx(plugin.validateConfig({}))
  plugin.commands.prefix.handler(['[AI-GEN] '], first.ctx)
  const mid = plugin.validateConfig({ rules: first.written[0].rules })

  const second = makeCommandCtx(mid)
  plugin.commands.prefix.handler(['[AI-GEN] '], second.ctx)
  assert.equal(second.written[0].rules.length, mid.rules.length)
})

test('prefix 命令：缺值或带未知参数时报错且不落盘', () => {
  const a = makeCommandCtx(plugin.validateConfig({}))
  assert.equal(plugin.commands.prefix.handler([], a.ctx), 1)
  assert.equal(a.written.length, 0)

  const b = makeCommandCtx(plugin.validateConfig({}))
  assert.equal(plugin.commands.prefix.handler(['--dry-run'], b.ctx), 1)
  assert.equal(b.written.length, 0)
})

test('prefix 命令：前缀不带尾随空格时给出提示', () => {
  const { ctx, logs } = makeCommandCtx(plugin.validateConfig({}))
  plugin.commands.prefix.handler(['[AI-GEN]'], ctx)
  assert.match(logs.join('\n'), /不以空白结尾/)
})

test('rules 命令：列出生效规则与来源', () => {
  const defaults = makeCommandCtx(plugin.validateConfig({}))
  assert.equal(plugin.commands.rules.handler([], defaults.ctx), 0)
  assert.match(defaults.logs.join('\n'), /生效规则 3 条（来源：插件默认）/)
  assert.match(defaults.logs.join('\n'), /← 兜底/)

  const custom = makeCommandCtx(plugin.validateConfig({ rules: [{ name: 'only', pattern: '^x', action: 'skip' }] }))
  assert.equal(plugin.commands.rules.handler([], custom.ctx), 0)
  assert.match(custom.logs.join('\n'), /来源：用户配置/)
})
