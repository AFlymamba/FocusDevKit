import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 与 core.test.js 同理：paths.ts 在首次 import 时固化 FXDEVKIT_HOME，必须先隔离
process.env.FXDEVKIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fxdevkit-trace-test-'))
const isolatedHome = process.env.FXDEVKIT_HOME
after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }))

const {
  CORE,
  EV_HANDLED,
  EV_SKIPPED,
  SKIP_REASONS,
  STATE_TYPES,
  summarize,
  isStateChange,
  daysBetween,
  hoursBetween,
} = await import('../dist/index.js')

function coreEvent(type, ts, payload = {}) {
  return { ts, plugin: CORE, type, ...payload }
}

/**
 * 回溯的核心语义：被调用 ≠ 生效。
 * 只要「跑完」才算增强生效，任何一关被拦下都只能落到 skipped，
 * 否则用户会看到「昨天还在生效」的假象。
 */
test('summarize：只有 hook.handled 才算增强生效', () => {
  const summary = summarize([
    coreEvent(EV_SKIPPED, '2026-09-18T10:00:00.000Z', { hook: 'commit-msg', reason: SKIP_REASONS.excluded }),
    coreEvent(EV_HANDLED, '2026-09-15T14:22:00.000Z', { hook: 'commit-msg', pluginId: 'plugin-commit-rules' }),
  ])

  assert.equal(summary.lastHandled.ts, '2026-09-15T14:22:00.000Z')
  assert.equal(summary.lastHandled.pluginId, 'plugin-commit-rules')
  assert.equal(summary.lastSkipped.reason, SKIP_REASONS.excluded)
})

test('summarize：入参乱序也能取到最近一次', () => {
  const summary = summarize([
    coreEvent(EV_HANDLED, '2026-09-18T09:00:00.000Z', { hook: 'commit-msg' }),
    coreEvent(EV_HANDLED, '2026-09-10T09:00:00.000Z', { hook: 'commit-msg' }),
    coreEvent(EV_HANDLED, '2026-09-20T09:00:00.000Z', { hook: 'pre-commit' }),
  ])
  assert.equal(summary.lastHandled.ts, '2026-09-20T09:00:00.000Z')
  assert.equal(summary.lastHandled.hook, 'pre-commit')
})

test('summarize：空事件流不编造结论', () => {
  const summary = summarize([])
  assert.equal(summary.lastHandled, null)
  assert.equal(summary.lastSkipped, null)
  assert.equal(summary.lastStateChange, null)
  assert.deepEqual(summary.skipReasons, [])
})

test('summarize：跳过原因按次数降序，次数相同按原因名字典序', () => {
  const summary = summarize([
    coreEvent(EV_SKIPPED, '2026-09-18T10:00:00.000Z', { reason: SKIP_REASONS.outOfScope }),
    coreEvent(EV_SKIPPED, '2026-09-18T10:01:00.000Z', { reason: SKIP_REASONS.excluded }),
    coreEvent(EV_SKIPPED, '2026-09-18T10:02:00.000Z', { reason: SKIP_REASONS.outOfScope }),
    coreEvent(EV_SKIPPED, '2026-09-18T10:03:00.000Z', { reason: SKIP_REASONS.timeout }),
    coreEvent(EV_SKIPPED, '2026-09-18T10:04:00.000Z', { reason: SKIP_REASONS.excluded }),
  ])
  assert.deepEqual(summary.skipReasons, [
    { reason: SKIP_REASONS.excluded, count: 2 },
    { reason: SKIP_REASONS.outOfScope, count: 2 },
    { reason: SKIP_REASONS.timeout, count: 1 },
  ])
})

test('summarize：状态变更单独抽出，插件事件不混入', () => {
  const summary = summarize([
    { ts: '2026-09-16T09:30:00.000Z', plugin: 'plugin-commit-rules', type: 'commit.rewritten' },
    coreEvent('hooks.installed', '2026-09-16T09:29:00.000Z', { node: '/usr/bin/node' }),
    coreEvent('scope.disabled', '2026-09-17T09:29:00.000Z', { target: 'D:/projects/legacy' }),
  ])
  assert.equal(summary.lastStateChange.type, 'scope.disabled')
  assert.equal(summary.lastStateChange.target, 'D:/projects/legacy')
  // 插件事件不该被当成状态变更
  assert.equal(isStateChange({ plugin: 'plugin-commit-rules', type: 'hooks.installed' }), false)
})

test('STATE_TYPES 覆盖四个开关动作', () => {
  assert.deepEqual([...STATE_TYPES].sort(), [
    'hooks.installed',
    'hooks.uninstalled',
    'scope.disabled',
    'scope.enabled',
  ])
})

test('跳过原因是稳定标识：不含空格，回溯输出才能直接当关键词用', () => {
  for (const reason of Object.values(SKIP_REASONS)) {
    assert.match(reason, /^[a-z-]+$/)
  }
})

test('daysBetween：不足一天算 0，非法时间戳不抛异常', () => {
  assert.equal(daysBetween('2026-09-15T14:00:00.000Z', '2026-09-18T10:00:00.000Z'), 2)
  assert.equal(daysBetween('2026-09-18T09:00:00.000Z', '2026-09-18T23:00:00.000Z'), 0)
  assert.equal(daysBetween('不是时间戳', '2026-09-18T23:00:00.000Z'), 0)
})

test('hoursBetween：用于「N 小时前」的措辞', () => {
  assert.equal(hoursBetween('2026-09-18T09:00:00.000Z', '2026-09-18T12:30:00.000Z'), 3)
  assert.equal(hoursBetween('2026-09-18T09:00:00.000Z', '2026-09-18T09:30:00.000Z'), 0)
})
