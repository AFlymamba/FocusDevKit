import assert from 'node:assert/strict'
import test from 'node:test'
import { askAndStore, resolveCredentials } from '../dist/credentials.js'

/** 收集日志，供断言文案里有没有把用户该做的事说清楚 */
function collector() {
  const lines = []
  return {
    lines,
    log: {
      info: (m) => lines.push(`info:${m}`),
      warn: (m) => lines.push(`warn:${m}`),
      error: (m) => lines.push(`error:${m}`),
    },
  }
}

function fakeInput(answers) {
  const queue = [...answers]
  return async () => queue.shift() ?? ''
}

test('环境变量优先于用户配置', async () => {
  process.env.FEISHU_APP_ID = 'cli_from_env'
  process.env.FEISHU_APP_SECRET = 'secret_from_env'
  try {
    const { log, lines } = collector()
    const result = await resolveCredentials({ appId: 'cli_from_config', appSecret: 'secret_from_config' }, log)
    assert.deepEqual(result, { appId: 'cli_from_env', appSecret: 'secret_from_env' })
    assert.equal(lines.length, 0, '命中环境变量时不该有任何输出')
  } finally {
    delete process.env.FEISHU_APP_ID
    delete process.env.FEISHU_APP_SECRET
  }
})

test('用户配置里的凭据可直接使用，不再提问', async () => {
  const { log, lines } = collector()
  let asked = false
  const result = await resolveCredentials(
    { appId: 'cli_from_config', appSecret: 'secret_from_config' },
    log,
    {
      isTTY: true,
      readLine: async () => {
        asked = true
        return ''
      },
    },
  )
  assert.deepEqual(result, { appId: 'cli_from_config', appSecret: 'secret_from_config' })
  assert.equal(asked, false, '已有凭据就不该再问')
  assert.ok(
    lines.some((l) => l.includes('用户配置')),
    '应说明凭据来源',
  )
})

test('无凭据且非交互终端：报错并给出两条可操作的出路，不进入提问', async () => {
  const { log, lines } = collector()
  let asked = false
  const result = await resolveCredentials({}, log, {
    isTTY: false,
    readLine: async () => {
      asked = true
      return ''
    },
    home: 'D:/fake/home',
  })
  assert.equal(result, null)
  assert.equal(asked, false, '非交互环境下不能卡在提问上')
  assert.ok(
    lines.some((l) => l.includes('FEISHU_APP_ID')),
    '应提示环境变量这条路',
  )
  assert.ok(
    lines.some((l) => l.includes('config.yaml')),
    '应提示配置文件这条路',
  )
})

test('无凭据且是交互终端：走引导，输入合法则落盘', async () => {
  const { log, lines } = collector()
  const stored = []
  const result = await resolveCredentials({}, log, {
    isTTY: true,
    readLine: fakeInput(['cli_abc123', 'the_secret']),
    store: (c) => stored.push(c),
    home: 'D:/fake/home',
  })
  assert.deepEqual(result, { appId: 'cli_abc123', appSecret: 'the_secret' })
  assert.deepEqual(stored, [{ appId: 'cli_abc123', appSecret: 'the_secret' }])
  assert.ok(
    lines.some((l) => l.includes('open.feishu.cn/app')),
    '引导里必须给出建应用的地址',
  )
})

test('引导时输入为空：中止，不落盘', async () => {
  const { log } = collector()
  const stored = []
  const result = await resolveCredentials({}, log, {
    isTTY: true,
    readLine: async () => '',
    store: (c) => stored.push(c),
  })
  assert.equal(result, null)
  assert.deepEqual(stored, [], '用户放弃时不该写入任何东西')
})

test('只填了 App ID 没填 Secret：中止，不落盘', async () => {
  const { log } = collector()
  const stored = []
  const result = await resolveCredentials({}, log, {
    isTTY: true,
    readLine: fakeInput(['cli_abc123', '']),
    store: (c) => stored.push(c),
  })
  assert.equal(result, null)
  assert.deepEqual(stored, [])
})

test('--reset 在非交互终端下明确拒绝', async () => {
  const { log, lines } = collector()
  const result = await askAndStore(log, { isTTY: false })
  assert.equal(result, null)
  assert.ok(
    lines.some((l) => l.includes('交互终端')),
    '应说明需要交互终端',
  )
})

test('输入两端空白会被裁掉', async () => {
  const { log } = collector()
  const stored = []
  const result = await resolveCredentials({}, log, {
    isTTY: true,
    readLine: fakeInput(['  cli_abc123  ', '  secret  ']),
    store: (c) => stored.push(c),
  })
  assert.deepEqual(result, { appId: 'cli_abc123', appSecret: 'secret' })
})

test('App ID 抄错（不以 cli_ 开头）：就地纠正，不落盘', async () => {
  const { log, lines } = collector()
  const stored = []
  const result = await resolveCredentials({}, log, {
    isTTY: true,
    readLine: fakeInput(['app_secret_value', '']),
    store: (c) => stored.push(c),
  })
  assert.equal(result, null)
  assert.deepEqual(stored, [], '抄错时不该把脏数据写进配置')
  assert.ok(
    lines.some((l) => l.includes('一定以 cli_ 开头')),
    '应明确指出 App ID 的形状要求',
  )
})

test('两个字段填反（Secret 位填了 cli_ 开头）：就地纠正，不落盘', async () => {
  const { log, lines } = collector()
  const stored = []
  const result = await resolveCredentials({}, log, {
    isTTY: true,
    readLine: fakeInput(['cli_correct', 'cli_also_looks_like_id']),
    store: (c) => stored.push(c),
  })
  assert.equal(result, null)
  assert.deepEqual(stored, [])
  assert.ok(
    lines.some((l) => l.includes('填反')),
    '应点出「填反了」这个具体错法',
  )
})

/* ── 引导节奏：一次只讲一件事 ─────────────────────────── */

test('问 App ID 时，不该提前讲 App Secret 的操作细节', async () => {
  const { log, lines } = collector()
  // 第一步就填错退出，这样能单独看到「第 1 步」的全部输出
  await resolveCredentials({}, log, {
    isTTY: true,
    readLine: fakeInput(['bad_id']),
    store: () => {},
  })
  const firstStep = lines.join('\n')
  assert.ok(firstStep.includes('凭证与基础信息'), '第 1 步要点名具体页面')
  assert.ok(
    !firstStep.includes('显示'),
    '第 1 步不该讲 App Secret 的「显示」按钮——那是第 2 步的事',
  )
})

test('拿到 App ID 之后，才讲 App Secret 怎么拿', async () => {
  const { log, lines } = collector()
  await resolveCredentials({}, log, {
    isTTY: true,
    readLine: fakeInput(['cli_good', '']),
    store: () => {},
  })
  const text = lines.join('\n')
  assert.ok(
    text.indexOf('默认是隐藏的') > text.indexOf('把 App ID 粘到这里'),
    'App Secret 的说明必须出现在 App ID 提问之后',
  )
  assert.ok(text.includes('显示'), '拿到 App ID 后应说明 Secret 默认被隐藏、需点显示')
})

test('提问行要指向动作，而不是罗列字段名', async () => {
  const { log } = collector()
  const prompts = []
  await resolveCredentials({}, log, {
    isTTY: true,
    readLine: async (prompt) => {
      prompts.push(prompt)
      return prompts.length === 1 ? 'cli_good' : 'secret'
    },
    store: () => {},
  })
  assert.equal(prompts.length, 2)
  assert.ok(prompts[0].includes('粘到这里'), '提问要说清是把值粘进来')
  assert.ok(prompts[1].includes('粘到这里'), '第二步同样要说清动作')
})
