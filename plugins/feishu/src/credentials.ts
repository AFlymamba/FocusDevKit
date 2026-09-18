import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeUserConfig } from '@fxdevkit/core'

/**
 * 凭据的获取与引导。
 *
 * 抽成独立模块是为了能脱离真实终端测试——引导流程最容易写错的地方是
 * 「什么时候该提问、什么时候该直接报错」，这两条分支必须可验证。
 *
 * 顺序：环境变量 → 用户配置 → 引导填写。
 * 为什么要有引导：App ID / Secret 是用户手里唯一的必填项，直接报错退出等于
 * 把「去哪建应用、抄哪两个字段」的功课全推给用户。
 *
 * 引导文案的三条原则（都是踩过坑改出来的）：
 *   1. **一次只讲一件事**。信息一次泼完，用户看完第一屏就忘了要做什么。
 *   2. **说人话，不讲解**。用「粘到这里」而不是「请复制字段值」，用 → 指向动作。
 *   3. **后面的事后面说**。权限、事件订阅属于「启动成功之后」的话题，
 *      堵在填字段前面只会让人不知道当前该干嘛。
 */

const FX_HOME = path.join(os.homedir(), '.fxdevkit')

export interface Credentials {
  appId: string
  appSecret: string
}

/** 配置文件里的凭据节（仅本机自用；多机共享或 CI 请改用环境变量） */
export interface StoredCredentials {
  appId?: string
  appSecret?: string
}

export interface CredentialLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface CredentialDeps {
  /** 是否交互终端 */
  isTTY: boolean
  /** 读一行输入（不含换行符） */
  readLine(prompt: string): Promise<string>
  /** 落盘凭据 */
  store(credentials: Credentials): void
  /** 配置目录，仅用于提示文案 */
  home?: string
}

function defaultDeps(): CredentialDeps {
  return {
    isTTY: Boolean(process.stdin.isTTY),
    readLine: readStdinLine,
    store: (credentials) => {
      writeUserConfig({ plugins: { 'plugin-feishu': credentials } })
    },
    home: FX_HOME,
  }
}

export function readStdinLine(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  return new Promise((resolve) => {
    const stdin = process.stdin
    let buffer = ''
    const done = (value: string): void => {
      stdin.off('data', onData)
      stdin.pause()
      resolve(value)
    }
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString()
      const index = buffer.indexOf('\n')
      if (index >= 0) done(buffer.slice(0, index))
    }
    stdin.on('data', onData)
    // 管道 / 非交互环境下拿不到输入，立刻返回，让调用方走非交互分支
    stdin.once('end', () => done(buffer.split('\n')[0] ?? ''))
    stdin.resume()
  })
}

export async function resolveCredentials(
  stored: StoredCredentials,
  log: CredentialLogger,
  overrides: Partial<CredentialDeps> = {},
): Promise<Credentials | null> {
  const deps = { ...defaultDeps(), ...overrides }

  const envAppId = process.env.FEISHU_APP_ID ?? ''
  const envSecret = process.env.FEISHU_APP_SECRET ?? ''
  if (envAppId && envSecret) return { appId: envAppId, appSecret: envSecret }

  const storedAppId = typeof stored.appId === 'string' ? stored.appId : ''
  const storedSecret = typeof stored.appSecret === 'string' ? stored.appSecret : ''
  if (storedAppId && storedSecret) {
    log.info(`凭据来自用户配置（appId ${storedAppId.slice(0, 10)}…）`)
    return { appId: storedAppId, appSecret: storedSecret }
  }

  if (!deps.isTTY) {
    log.error('未找到凭据，且当前不是交互终端。')
    log.error('请二选一：① 设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET；')
    log.error(
      `          ② 在 ${path.join(deps.home ?? FX_HOME, 'config.yaml')} 里写 plugins.plugin-feishu.appId / appSecret`,
    )
    return null
  }

  return askAndStore(log, deps)
}

/**
 * 交互式问答 + 落盘。首次引导与 serve --reset 共用。
 *
 * 节奏是「一次一步」：先只问 App ID，拿到并校验通过后才讲下一步。
 * 用户在任何时刻只需要知道「现在填什么」，不需要预先理解全流程。
 */
export async function askAndStore(
  log: CredentialLogger,
  overrides: Partial<CredentialDeps> = {},
): Promise<Credentials | null> {
  const deps = { ...defaultDeps(), ...overrides }

  if (!deps.isTTY) {
    log.error('引导填写需要交互终端；也可以直接改用户配置，或设置环境变量。')
    return null
  }

  const giveUp = (): null => {
    log.error('已取消。也可以改用环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET。')
    return null
  }

  /* ── 第 1 步：只讲 App ID ───────────────────────────── */
  log.info('需要飞书自建应用的凭据。分两步，先拿 App ID。')
  log.info('')
  log.info('  1. 打开 → https://open.feishu.cn/app')
  log.info('  2. 点「创建企业自建应用」，随便起个名字（比如 fxdevkit）')
  log.info('  3. 进去后点左侧「凭证与基础信息」')
  log.info('  4. 页面上有个 App ID，右边有复制按钮 → 复制它')
  log.info('')

  const appId = (await deps.readLine('把 App ID 粘到这里，回车（直接回车＝放弃）\n> ')).trim()
  if (!appId) return giveUp()
  if (!appId.startsWith('cli_')) {
    log.error('')
    log.error(`这串不像 App ID：${appId}`)
    log.error('App ID 一定以 cli_ 开头。常见的抄错是复制成了应用名字，')
    log.error('或者复制成了下面那一格 App Secret。回去再看看第 4 步。')
    return null
  }

  /* ── 第 2 步：只讲 App Secret ───────────────────────── */
  log.info('')
  log.info(`App ID 记下了：${appId}`)
  log.info('')
  log.info('再拿 App Secret，就在同一个页面、App ID 下面那一格。')
  log.info('它默认是隐藏的，点「显示」或直接点右边的复制按钮。')
  log.info('')

  const appSecret = (await deps.readLine('把 App Secret 粘到这里，回车（直接回车＝放弃）\n> ')).trim()
  if (!appSecret) return giveUp()
  if (appSecret.startsWith('cli_')) {
    log.error('')
    log.error('这串是 App ID，不是 App Secret——两格填反了。')
    log.error('App Secret 不长这样，它没有 cli_ 前缀。重新跑一次再试。')
    return null
  }

  /* ── 落盘 ───────────────────────────────────────────── */
  const configPath = path.join(deps.home ?? FX_HOME, 'config.yaml')
  deps.store({ appId, appSecret })
  log.info('')
  log.info(`两个都齐了，已存到 ${configPath}`)
  return { appId, appSecret }
}

/** 测试用：判断文件是否已存在（避免测试里直接依赖 fs） */
export function fileExists(file: string): boolean {
  return fs.existsSync(file)
}
