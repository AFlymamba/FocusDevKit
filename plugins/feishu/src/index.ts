import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'
import { definePlugin } from '@fxdevkit/sdk'
import { askAndStore, resolveCredentials, type StoredCredentials } from './credentials.js'
import { CODEX_DEFAULTS, CODEX_EFFORTS, runCodex, writeInstructionsFile, type CodexConfig } from './codex.js'

/**
 * 飞书入口插件（M1）。
 *
 * 职责只有一件事：把「群里 @ 机器人」变成「本机插件能力的一次调用」，
 * 再把结果送回原来的群。ping / logs / help 是硬编码的死数据；
 * 其余问题转发给本机 codex 问答（这是第一个接进来的「真能力」，
 * M2 的能力注册表会把它变成显式声明的东西，而不是兜底分支里的特例）。
 *
 * 两个必须守住的现实约束：
 *   1. 飞书长连接是集群模式、不广播——同一应用多个客户端只有随机一个收到，
 *      所以本机必须单实例（见 pid 锁）。
 *   2. 群里任何人都能 @ 机器人，所以调用者白名单不是可选项（见 allowOpenIds）。
 */

const VERSION = '0.1.0'

interface FeishuConfig {
  /** 飞书自建应用的 App ID。仅本机自用；与 appSecret 一样建议优先用环境变量 */
  appId?: string
  /** 飞书自建应用的 App Secret。注意：存在配置文件里是明文 */
  appSecret?: string
  /** 允许调用的 open_id 白名单。空数组 = 不限制（不建议，见 README） */
  allowOpenIds: string[]
  /** 允许响应的群 chat_id。空数组 = 不限制 */
  allowChats: string[]
  /** 执行前先回一条「收到」，避免群里看着像没反应 */
  ack: boolean
  /** logs 的默认条数 */
  defaultLogLines: number
  /** 本机 codex 问答的配置（兜底分支用） */
  codex: CodexConfig
}

const DEFAULT_CONFIG: FeishuConfig = {
  allowOpenIds: [],
  allowChats: [],
  ack: true,
  defaultLogLines: 10,
  codex: { ...CODEX_DEFAULTS, cwd: '', instructionsFile: '' },
}

const FX_HOME = path.join(os.homedir(), '.fxdevkit')
const LOCK_FILE = path.join(FX_HOME, 'plugins', 'plugin-feishu', 'serve.lock')
const LOG_DIR = path.join(FX_HOME, 'logs')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 飞书的业务错误藏在 axios error 的 response.data 里（例如权限不足的 99991672），
 * 而 error.message 只有一句 'Request failed with status code 400'。
 * 只取 message 等于把最关键的信息丢了，所以要往里挖。
 *
 * 挖出来之后要说人话：告诉用户缺什么、点哪里补、补完还要做什么。
 * 返回的是给用户看的一句话或多行文本，不是堆栈。
 */
export function explainReplyError(error: unknown): string {
  const fallback = errText(error)

  const found: { code: number; msg: string } | null = findApiError(error)
  if (!found) return fallback

  const { code, msg } = found

  if (code === 99991672) {
    // Access denied：缺权限。msg 里带有一键开通链接（含 appId 和缺的 scope），直接用它最省事
    // 按 RFC 3986 的合法 URL 字符集取，别用「取到逗号为止」——
    // scope 列表本身是逗号分隔的，那样会把链接拦腰截断
    const link = msg.match(/https:\/\/open\.feishu\.cn\/app\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/)?.[0]
    const lines = [
      '回复失败：应用还没开通「发消息」权限（收消息和发消息在飞书里是分开授权的）。',
    ]
    if (link) lines.push(`点这个链接开通任意一个即可 → ${link}`)
    lines.push('开通后要去「版本管理与发布」发一版才生效')
    return lines.join('\n')
  }

  if (code === 230002 || code === 230098) {
    return `回复失败：这个会话里没有这个机器人（已被移出群或不是群成员）。\n${fallback}`
  }

  return `回复失败：飞书返回 ${code} ${msg}`
}

/** 在任意嵌套结构里找 { code: number, msg: string } 形状的飞书业务错误 */
function findApiError(input: unknown, depth = 0): { code: number; msg: string } | null {
  if (depth > 6 || input === null || typeof input !== 'object') return null

  const record = input as Record<string, unknown>
  if (typeof record.code === 'number' && typeof record.msg === 'string') {
    return { code: record.code, msg: record.msg }
  }

  // axios error 把响应体放在 response.data
  for (const key of ['response', 'data', 'error']) {
    if (key in record) {
      const hit = findApiError(record[key], depth + 1)
      if (hit) return hit
    }
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const hit = findApiError(item, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
}

/* 凭据的获取与引导见 ./credentials.ts */

interface LockInfo {
  pid: number
  startedAt: string
}

function readLock(): LockInfo | null {
  try {
    if (!fs.existsSync(LOCK_FILE)) return null
    const parsed: unknown = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (!isRecord(parsed) || typeof parsed.pid !== 'number') return null
    return { pid: parsed.pid, startedAt: str(parsed.startedAt) }
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function writeLock(): void {
  try {
    fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true })
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      'utf8',
    )
  } catch {
    /* 锁写不进去不影响主流程，只是失去保护 */
  }
}

function releaseLock(): void {
  try {
    fs.rmSync(LOCK_FILE, { force: true })
  } catch {
    /* 静默 */
  }
}

/* ---------------- 内置能力 ---------------- */

/** 取最近 n 条调度日志（跨天回溯），格式压平成一屏可读 */
function tailLogs(n: number): string {
  try {
    if (!fs.existsSync(LOG_DIR)) return '暂无日志'

    const days = fs
      .readdirSync(LOG_DIR)
      .filter((name) => name.endsWith('.log'))
      .sort()
      .reverse()

    const out: string[] = []
    for (const day of days) {
      const lines = fs
        .readFileSync(path.join(LOG_DIR, day), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')

      for (let i = lines.length - 1; i >= 0; i -= 1) {
        let record: unknown = null
        try {
          record = JSON.parse(lines[i]) as unknown
        } catch {
          continue
        }
        if (!isRecord(record)) continue
        const time = str(record.ts).slice(11, 19)
        const plugin = record.plugin ? `:${String(record.plugin)}` : ''
        out.unshift(`${time} ${String(record.channel)}${plugin} ${String(record.level)} ${String(record.msg)}`)
        if (out.length >= n) return out.join('\n')
      }
    }
    return out.length > 0 ? out.join('\n') : '暂无日志'
  } catch (error) {
    return `读取日志失败：${errText(error)}`
  }
}

/**
 * 事件幂等去重。飞书的事件推送是 at-least-once：处理慢、网络抖动、断线重连，
 * 都可能让同一条消息推过来两次。群里「一条消息两份回答」就是没做这个的后果。
 *
 * 按 message_id 判重，TTL 过期自动清理（顺带在每次查询时做，不设定时器）。
 * 空 message_id 不去重——宁可重不可丢。
 */
export function createDeduper(ttlMs: number): { isDuplicate: (messageId: string) => boolean } {
  const seen = new Map<string, number>()
  return {
    isDuplicate(messageId: string): boolean {
      const now = Date.now()
      for (const [id, ts] of seen) {
        if (now - ts > ttlMs) seen.delete(id)
      }
      if (messageId === '') return false
      if (seen.has(messageId)) return true
      seen.set(messageId, now)
      return false
    },
  }
}

function duration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h} 小时 ${m} 分` : m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

/* ---------------- 消息解析 ---------------- */

interface IncomingMessage {
  messageId: string
  chatId: string
  /** group = 群聊，p2p = 单聊 */
  chatType: string
  msgType: string
  text: string
  /** mentions 里的占位符，如 @_user_1，需要从文本里剥掉 */
  mentionKeys: string[]
  /** mentions 里被 @ 的人的 open_id */
  mentionOpenIds: string[]
  senderOpenId: string
}

function parseIncoming(data: unknown): IncomingMessage | null {
  if (!isRecord(data)) return null
  const message = isRecord(data.message) ? data.message : null
  if (!message) return null

  let text = ''
  try {
    const content: unknown = JSON.parse(str(message.content))
    if (isRecord(content)) text = str(content.text)
  } catch {
    text = str(message.content)
  }

  const sender = isRecord(data.sender) ? data.sender : {}
  const senderId = isRecord(sender.sender_id) ? sender.sender_id : {}

  const mentionKeys: string[] = []
  const mentionOpenIds: string[] = []
  if (Array.isArray(message.mentions)) {
    for (const item of message.mentions) {
      if (!isRecord(item)) continue
      if (typeof item.key === 'string') mentionKeys.push(item.key)
      const id = isRecord(item.id) ? item.id : {}
      if (typeof id.open_id === 'string') mentionOpenIds.push(id.open_id)
    }
  }

  return {
    messageId: str(message.message_id),
    chatId: str(message.chat_id),
    chatType: str(message.chat_type),
    msgType: str(message.msg_type),
    text,
    mentionKeys,
    mentionOpenIds,
    senderOpenId: str(senderId.open_id),
  }
}

/** 去掉 @ 占位符后剩下的才是真正的问题 */
function stripMentions(text: string, keys: string[]): string {
  let out = text
  for (const key of keys) out = out.split(key).join(' ')
  return out.replace(/\s+/g, ' ').trim()
}

/* ---------------- 发送 ---------------- */

type CreateMessage = (payload: {
  params: { receive_id_type: string }
  data: { receive_id: string; msg_type: string; content: string }
}) => Promise<unknown>

/**
 * 返回 true 表示消息确实发出去了。
 * 必须让调用方知道成败——发送失败还打「已回复」会让用户以为对面收到了。
 */
export async function sendText(
  client: Lark.Client,
  idType: 'chat_id' | 'open_id',
  id: string,
  text: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const create = client.im.v1.message.create as unknown as CreateMessage
  try {
    await create({
      params: { receive_id_type: idType },
      data: { receive_id: id, msg_type: 'text', content: JSON.stringify({ text }) },
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

export default definePlugin<FeishuConfig>({
  id: 'plugin-feishu',
  defaultConfig: DEFAULT_CONFIG,

  validateConfig(raw) {
    const input = isRecord(raw) ? raw : {}
    const lines = input.defaultLogLines
    const codexRaw = isRecord(input.codex) ? input.codex : {}
    const codexModel = typeof codexRaw.model === 'string' && codexRaw.model !== '' ? codexRaw.model : CODEX_DEFAULTS.model
    const codexEffort =
      typeof codexRaw.effort === 'string' && (CODEX_EFFORTS as readonly string[]).includes(codexRaw.effort)
        ? codexRaw.effort
        : CODEX_DEFAULTS.effort
    const codexTimeout =
      typeof codexRaw.timeoutMs === 'number' && codexRaw.timeoutMs >= 10_000 && codexRaw.timeoutMs <= 600_000
        ? Math.floor(codexRaw.timeoutMs)
        : CODEX_DEFAULTS.timeoutMs
    const codexCwd = typeof codexRaw.cwd === 'string' && codexRaw.cwd !== '' ? codexRaw.cwd : os.homedir()
    // 允许显式传空串 = 完全不要系统指令
    const codexPrompt =
      typeof codexRaw.systemPrompt === 'string' ? codexRaw.systemPrompt : CODEX_DEFAULTS.systemPrompt
    return {
      appId: typeof input.appId === 'string' ? input.appId : undefined,
      appSecret: typeof input.appSecret === 'string' ? input.appSecret : undefined,
      allowOpenIds: stringList(input.allowOpenIds),
      allowChats: stringList(input.allowChats),
      ack: input.ack !== false,
      defaultLogLines:
        typeof lines === 'number' && lines > 0 && lines <= 50
          ? Math.floor(lines)
          : DEFAULT_CONFIG.defaultLogLines,
      codex: {
        model: codexModel,
        effort: codexEffort,
        timeoutMs: codexTimeout,
        cwd: codexCwd,
        systemPrompt: codexPrompt,
        instructionsFile: '',
      },
    }
  },

  commands: {
    serve: {
      describe: '启动飞书长连接，前台常驻（Ctrl+C 停止）',
      async handler(argv, ctx) {
        const reset = argv.includes('--reset')
        const credentials = reset
          ? await askAndStore(ctx.logger)
          : await resolveCredentials(ctx.config as StoredCredentials, ctx.logger)
        if (!credentials) return 1
        const { appId, appSecret } = credentials

        const lock = readLock()
        if (lock && pidAlive(lock.pid)) {
          ctx.logger.error(
            `已有实例在运行（pid ${lock.pid}，启动于 ${lock.startedAt}）。长连接不广播，重复启动会互相抢消息，请先停掉旧实例。`,
          )
          return 1
        }
        writeLock()

        const base: Record<string, unknown> = {
          appId,
          appSecret,
          loggerLevel: Lark.LoggerLevel.info,
        }
        if (process.env.FEISHU_DOMAIN === 'lark') base.domain = 'https://open.larksuite.com'
        type ClientOptions = ConstructorParameters<typeof Lark.Client>[0]
        const client = new Lark.Client(base as unknown as ClientOptions)
        const wsClient = new Lark.WSClient(base as unknown as ClientOptions)

        // 机器人自己的 open_id：用于判断群里 @ 的是不是我。
        // 拿不到就降级——但降级时必须有调用者白名单兜底，否则群里的任何人都能唤起本机。
        let botOpenId = ''
        try {
          // 注意：不要用解构取出 request 再调用，会丢 this（SDK 内部访问 this.formatPayload）
          const raw = client as unknown as {
            request(payload: { method: 'GET'; url: string }): Promise<unknown>
          }
          const info: unknown = await raw.request({ method: 'GET', url: '/open-apis/bot/v3/info' })
          const bot = isRecord(info) && isRecord(info.bot) ? info.bot : null
          botOpenId = str(bot?.open_id)
        } catch (error) {
          ctx.logger.warn(`读取机器人自身 open_id 失败：${errText(error)}`)
        }
        if (botOpenId) ctx.logger.info(`机器人 open_id：${botOpenId}`)
        else ctx.logger.warn('未拿到 open_id，群内降级为「有人被 @ 就响应」（此时必须配置 allowOpenIds）')

        const startedAt = Date.now()
        const config = ctx.config
        const deduper = createDeduper(10 * 60_000)

        // 系统指令要落到文件里才能让 codex 读到（它没有 --system 参数）
        const instructionsFile =
          config.codex.systemPrompt === ''
            ? ''
            : writeInstructionsFile(
                path.join(FX_HOME, 'plugins', 'plugin-feishu', 'codex-instructions.md'),
                config.codex.systemPrompt,
              )
        if (config.codex.systemPrompt !== '' && instructionsFile === '') {
          ctx.logger.warn('系统指令文件没写成，这次调用不带系统指令（不影响链路）')
        }
        const codexConfig: CodexConfig = { ...config.codex, instructionsFile }
        const ask: typeof runCodex = (q, cfg, d) => runCodex(q, { ...cfg, ...codexConfig }, d)

        ctx.logger.info(
          `白名单 ${config.allowOpenIds.length} 人 · 群 ${
            config.allowChats.length > 0 ? `${config.allowChats.length} 个` : '不限'
          } · 回执 ${config.ack ? '开' : '关'}`,
        )

        const handle = async (raw: unknown): Promise<void> => {
          const incoming = parseIncoming(raw)
          if (!incoming) return
          if (deduper.isDuplicate(incoming.messageId)) {
            ctx.logger.debug(`重复推送，已忽略：${incoming.messageId}`)
            return
          }

          const { chatId, chatType, senderOpenId } = incoming
          const question = stripMentions(incoming.text, incoming.mentionKeys)

          if (incoming.msgType && incoming.msgType !== 'text') {
            ctx.emit('feishu.ignored', { reason: 'non-text', chatId, msgType: incoming.msgType })
            return
          }

          if (chatType === 'group') {
            if (botOpenId) {
              if (!incoming.mentionOpenIds.includes(botOpenId)) {
                // 没 @ 我。默认不打扰，排查「为什么没反应」时开 FXDEVKIT_DEBUG=1 就能看到
                ctx.logger.debug(`忽略：@ 的不是我 [${chatId}] ${question}`)
                return
              }
            } else if (incoming.mentionKeys.length === 0) {
              ctx.logger.debug(`忽略：群里没人被 @ [${chatId}]`)
              return
            } else if (config.allowOpenIds.length === 0) {
              ctx.emit('feishu.denied', { reason: 'no-bot-open-id-and-no-whitelist', chatId })
              ctx.logger.warn('未识别机器人身份且未配白名单，已拒绝群消息')
              return
            }
          }

          if (config.allowOpenIds.length > 0 && !config.allowOpenIds.includes(senderOpenId)) {
            ctx.emit('feishu.denied', { reason: 'sender-not-allowed', chatId, senderOpenId })
            ctx.logger.warn(`调用者不在白名单，已忽略：${senderOpenId}（群 ${chatId}）`)
            return
          }
          if (config.allowChats.length > 0 && !config.allowChats.includes(chatId)) {
            ctx.emit('feishu.denied', { reason: 'chat-not-allowed', chatId })
            return
          }

          ctx.emit('feishu.received', {
            chatId,
            chatType,
            senderOpenId,
            question,
            chars: question.length,
          })
          ctx.logger.info(`收到 [${chatId}] ${senderOpenId}：${question}`)

          const idType: 'chat_id' | 'open_id' = chatType === 'p2p' ? 'open_id' : 'chat_id'
          const receiver = chatType === 'p2p' ? senderOpenId : chatId

          if (config.ack) {
            const ack = await sendText(client, idType, receiver, '收到，正在查…')
            if (!ack.ok) ctx.logger.warn(`回执没发出去：${explainReplyError(ack.error)}`)
          }

          const answer = await answerFor(question, config, startedAt, {
            log: (m) => ctx.logger.info(m),
            ask,
          })
          const sent = await sendText(client, idType, receiver, answer)

          if (sent.ok) {
            ctx.logger.info(`已回复 [${chatId}] ${answer.length} 字`)
            ctx.emit('feishu.replied', { chatId, senderOpenId, chars: answer.length })
          } else {
            ctx.logger.error(explainReplyError(sent.error))
            // 失败也要进事件流，否则「有人问了但没回应」在报告里完全看不见
            ctx.emit('feishu.reply_failed', { chatId, senderOpenId, chars: answer.length })
          }
        }

        const dispatcher = new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data: unknown) => {
            // 不能 await handle：codex 问答动辄几十秒，飞书对推送有确认超时，
            // 等它处理完才确认 = 必然被判定超时 = 重推 = 一条消息回两遍。
            // 这里立即确认，慢活丢到后台跑；网络层的重推由 message_id 去重兜住。
            // 代价是进程崩溃时正在处理的消息会丢——群聊场景可接受（再 @ 一次就行）。
            void handle(data).catch((error: unknown) => {
              ctx.logger.error(`处理消息失败：${errText(error)}`)
            })
          },
        })

        const stop = (signal: string): void => {
          ctx.logger.info(`收到 ${signal}，正在断开并退出`)
          releaseLock()
          process.exit(0)
        }
        process.on('SIGINT', () => stop('SIGINT'))
        process.on('SIGTERM', () => stop('SIGTERM'))

        ctx.logger.info('飞书长连接启动中（Ctrl+C 停止）…')
        try {
          const started: unknown = wsClient.start({ eventDispatcher: dispatcher })
          if (started && typeof (started as { then?: unknown }).then === 'function') {
            await started as Promise<unknown>
          }
        } catch (error) {
          ctx.logger.error(`长连接启动失败：${errText(error)}`)
          releaseLock()
          return 1
        }

        ctx.logger.info('')
        for (const line of connectedGuide()) ctx.logger.info(line)
        // 长时间没人说话时，至少让终端能看出它还活着
        const heartbeat = setInterval(() => {
          ctx.logger.info(`在线 ${duration(Date.now() - startedAt)}，等待消息`)
        }, 10 * 60 * 1000)
        heartbeat.unref?.()

        // 常驻：插件命令路径没有超时包装，这里永久挂起直到收到信号
        await new Promise<never>(() => {})
        return 0
      },
    },
  },
})

/**
 * 连接成功后的指引。
 *
 * 为什么放这里而不是放在填凭据时：权限、事件订阅、发布都属于「启动成功之后」
 * 才该操心的事。堵在填字段前面，用户会连当前该干嘛都分不清。
 * 抽成独立函数是为了能被测试守住——这几行漏掉任何一句，用户都会在群里等不到回应。
 */
export function connectedGuide(): string[] {
  return [
    '连接成功。接下来三步，做完机器人才会在群里应你：',
    '  1. 开放平台 → 该应用 → 「权限管理」，勾这四项：',
    '       im:message / im:message:readonly',
    '       im:message.group_at_msg:readonly / contact:user.base:readonly',
    '  2. 同应用 → 「事件与回调」→ 添加事件 im.message.receive_v1',
    '       ⚠️ 接收方式必须选「长连接」，不是 HTTP 回调（选错就完全收不到）',
    '       ⚠️ 只切接收方式不加事件＝没订阅，一样收不到；两样都要做',
    '  3. 同应用 → 「版本管理与发布」→ 创建版本并发布。',
    '       权限和事件改动保存后不生效，发布之后才生效（自己的团队可自助审批）',
    '',
    '做完把机器人拉进群，@ 它发一句：ping',
    '',
    '（这个窗口保持开着。关了或电脑睡了，机器人就离线）',
    '等待消息…',
  ]
}

/**
 * 能力分派。ping / logs / help 是死数据；其余交给本机 codex。
 * deps 用来注入 runner 和日志，测试不用真的跑 codex。
 */
export async function answerFor(
  question: string,
  config: FeishuConfig,
  startedAt: number,
  deps?: { ask?: typeof runCodex; log?: (message: string) => void },
): Promise<string> {
  const ask = deps?.ask ?? runCodex
  const log = deps?.log ?? (() => {})
  const parts = question.split(' ').filter((p) => p !== '')
  const head = (parts[0] ?? '').toLowerCase()
  const rest = parts.slice(1)

  switch (head) {
    case 'ping':
      return [
        'pong',
        `插件：plugin-feishu@${VERSION}`,
        `在线时长：${duration(Date.now() - startedAt)}`,
        `本机：${os.hostname()}`,
      ].join('\n')

    case 'logs': {
      const parsed = Number.parseInt(rest[0] ?? '', 10)
      const n = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50) : config.defaultLogLines
      return tailLogs(n)
    }

    case 'help':
      return [
        '当前可用：',
        '  ping          看本机是否在线',
        `  logs [n]      最近 n 条调度日志（默认 ${config.defaultLogLines}）`,
        '  help          这份说明',
        `  其它任意问题  转给本机 codex 回答（model ${config.codex.model} / 思考 ${config.codex.effort}，只读沙箱）`,
      ].join('\n')

    default: {
      if (question === '') return '想问什么？直接说就行，@ 我 + 一句话。'
      return ask(question, config.codex, { log })
    }
  }
}
