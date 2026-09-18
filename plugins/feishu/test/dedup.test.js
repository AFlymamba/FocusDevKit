/**
 * 飞书事件是 at-least-once，同一条消息可能推两次。
 * 「一条消息两份回答」的截图（2026-09-18）就是没做去重的后果——这里守住它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(
  path.resolve(process.cwd(), 'plugins/feishu/dist/index.js'),
).href
const { createDeduper } = await import(moduleUrl)

test('同一条消息第二次判为重复', () => {
  const d = createDeduper(60_000)
  assert.equal(d.isDuplicate('om_1'), false)
  assert.equal(d.isDuplicate('om_1'), true)
})

test('不同消息互不影响', () => {
  const d = createDeduper(60_000)
  assert.equal(d.isDuplicate('om_1'), false)
  assert.equal(d.isDuplicate('om_2'), false)
  assert.equal(d.isDuplicate('om_1'), true)
  assert.equal(d.isDuplicate('om_2'), true)
})

test('TTL 过期后放行（时钟不可注入，用极短 TTL 验证语义）', async () => {
  const d = createDeduper(1) // 1ms 过期
  assert.equal(d.isDuplicate('om_1'), false)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(d.isDuplicate('om_1'), false, '过期后应视为新消息')
})

test('空 message_id 永不去重（宁可重不可丢）', () => {
  const d = createDeduper(60_000)
  assert.equal(d.isDuplicate(''), false)
  assert.equal(d.isDuplicate(''), false)
})
