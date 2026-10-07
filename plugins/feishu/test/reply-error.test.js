/**
 * 回复链路的错误处理与成败判定。
 *
 * 这两件事的共同点：错了不能假装对了。
 * - 发送失败必须让调用方知道（曾经失败也打「已回复」，用户在群里等半天）
 * - 飞书把真正的错误原因藏在 response.data 里（只取 error.message 只能拿到一句 status 400）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(
  path.resolve(process.cwd(), 'plugins/feishu/dist/index.js'),
).href
const mod = await import(moduleUrl)
const { explainReplyError } = mod

/** 模拟飞书 SDK 抛出的 axios error：message 里没有有用信息，真相在 response.data */
function permissionError() {
  // 照抄真实线上返回：scope 列表是逗号分隔的，链接里还有多个 & 参数
  const msg =
    'Access denied. One of the following scopes is required: ' +
    '[im:message:send, im:message, im:message:send_as_bot].应用尚未开通所需的应用身份权限，' +
    '点击链接申请并开通任一权限即可：' +
    'https://open.feishu.cn/app/cli_aa210ebf02b8dbb5/auth?q=im:message:send,im:message,im:message:send_as_bot&op_from=openapi&token_type=tenant'
  return {
    message: 'Request failed with status code 400',
    response: { status: 400, data: { code: 99991672, msg } },
  }
}

test('权限不足要说人话，不能只剩一句 status code', () => {
  const text = explainReplyError(permissionError())
  assert.ok(!text.includes('Request failed with status code 400'), '不该停在 axios 的 message 上')
  assert.ok(text.includes('发消息'), `要说清缺的是什么权限：${text}`)
  assert.ok(text.includes('收消息') && text.includes('分开'), `要解释收发权限是两回事：${text}`)
})

test('权限不足要给出一键开通链接', () => {
  const text = explainReplyError(permissionError())
  assert.ok(
    text.includes('https://open.feishu.cn/app/cli_aa210ebf02b8dbb5/auth?'),
    `链接里带着 appId 和缺的 scope，直接点最省事：${text}`,
  )
})

test('开通链接不能因为 scope 里的逗号被截断', () => {
  const text = explainReplyError(permissionError())
  // scope 列表本身是逗号分隔的，链接必须完整带出来才够一键开通
  assert.ok(text.includes('q=im:message:send,im:message'), `链接被截断了：${text}`)
  assert.ok(text.includes('op_from=openapi'), `链接尾部也被吃掉了：${text}`)
})

test('权限不足要提醒发版后才生效', () => {
  const text = explainReplyError(permissionError())
  assert.ok(text.includes('版本管理与发布'), `开通不等于生效，必须提醒发版：${text}`)
})

test('找得到藏在各层里的错误（数组包装、SDK 双元素结构）', () => {
  const wrapped = [[permissionError(), { code: 99991672, msg: 'dummy' }]]
  const text = explainReplyError(wrapped)
  assert.ok(text.includes('发消息'), `嵌套结构也要挖出来：${text}`)
})

test('机器人不在群里要说清楚是这个原因', () => {
  const text = explainReplyError({
    message: 'Request failed with status code 400',
    response: { status: 400, data: { code: 230002, msg: 'Bot is NOT in the chat' } },
  })
  assert.ok(text.includes('移出群') || text.includes('会话'), `要指出机器人不在群里：${text}`)
})

test('看不懂的错误至少保留原始信息，不能变成空话', () => {
  const text = explainReplyError(new Error('socket hang up'))
  assert.ok(text.includes('socket hang up'), `未知错误要透传原文：${text}`)
})
