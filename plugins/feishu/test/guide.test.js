import assert from 'node:assert/strict'
import test from 'node:test'
import { connectedGuide } from '../dist/index.js'

/**
 * 连接成功后的指引文案。
 *
 * 这几行放在「填完凭据、连上飞书之后」，是用户最可能踩坑的地方：
 * 凭据对了、连接成功了，但群里 @ 没反应，而原因全在这三件事里。
 */
const text = connectedGuide().join('\n')

test('必须提醒事件订阅选长连接（选错就完全收不到消息）', () => {
  assert.ok(text.includes('长连接'), '「长连接」是这一步唯一的关键，漏了用户会完全收不到消息')
  assert.ok(text.includes('不是 HTTP 回调'), '要显式排除 HTTP 回调这个错误选项')
})

test('四项权限点一个都不能少', () => {
  for (const scope of [
    'im:message',
    'im:message:readonly',
    'im:message.group_at_msg:readonly',
    'contact:user.base:readonly',
  ]) {
    assert.ok(text.includes(scope), `缺权限点：${scope}`)
  }
})

test('必须提醒发布版本', () => {
  assert.ok(text.includes('发布'), '不发布应用，前面配的全都不生效')
})

test('要告诉用户下一步怎么验证', () => {
  assert.ok(text.includes('ping'), '应给出一个可以立刻验证的动作')
  assert.ok(text.includes('@'), '要提醒群里需要 @ 它')
})

test('要说明进程不能关（否则用户会以为坏了）', () => {
  assert.ok(text.includes('窗口保持开着') || text.includes('离线'), '要交代前台常驻这个限制')
})

test('不该再重复凭据相关的事（那时已经填完了）', () => {
  assert.ok(!text.includes('App Secret'), '凭据已经填完，这里再提只会干扰')
  assert.ok(!text.includes('粘到这里'), '提问话术不该出现在启动后的指引里')
})
