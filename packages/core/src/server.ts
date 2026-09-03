import fs from 'node:fs'
import path from 'node:path'
import type { ServerClient } from '@devkit/sdk'
import type { Logger } from '@devkit/sdk'
import { ensureDir, paths, readJsonIfExists } from './paths.js'

export interface ServerOptions {
  url: string | null
  mock: boolean
  timeoutMs: number
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false
    const done = (value: T | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(null), ms)
    timer.unref?.()
    promise.then(
      (value) => done(value),
      () => done(null),
    )
  })
}

/**
 * 本地 mock Server。
 *
 * 个人验证阶段不部署真 Server，但接口契约与真实实现一致，
 * 未来切到 HTTP 只需替换这个对象。
 */
function createMockServer(): ServerClient {
  const dir = paths.mockServer
  const usageFile = path.join(dir, 'usage.jsonl')
  const credentialsFile = path.join(dir, 'credentials.json')
  const configFile = path.join(dir, 'config.json')

  return {
    async reportUsage({ pluginId, action }) {
      try {
        ensureDir(dir)
        fs.appendFileSync(
          usageFile,
          `${JSON.stringify({ ts: new Date().toISOString(), pluginId, action })}\n`,
          'utf8',
        )
      } catch {
        /* 静默 */
      }
    },

    async exchangeCredential(scope) {
      const store = readJsonIfExists<Record<string, { token: string; ttlSec?: number }>>(
        credentialsFile,
      )
      const entry = store?.[scope]
      if (!entry) return null
      const ttl = entry.ttlSec ?? 3600
      return { token: entry.token, expiresAt: Date.now() + ttl * 1000 }
    },

    async fetchConfig<T>(key: string): Promise<T | null> {
      const store = readJsonIfExists<Record<string, unknown>>(configFile)
      return (store?.[key] as T) ?? null
    },
  }
}

function createHttpServer(baseUrl: string, timeoutMs: number): ServerClient {
  const call = async <T>(pathname: string, body: unknown): Promise<T | null> => {
    const result = await withTimeout(
      fetch(new URL(pathname, baseUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs,
    )
    if (result == null || !result.ok) return null
    return (await result.json()) as T
  }

  return {
    async reportUsage(input) {
      await call('/v1/usage', input)
    },
    async exchangeCredential(scope) {
      return call<{ token: string; expiresAt: number }>('/v1/credentials/exchange', { scope })
    },
    async fetchConfig<T>(key: string): Promise<T | null> {
      return call<T>('/v1/config', { key })
    },
  }
}

/** 未授予 net:server 权限时注入的客户端：记录一次越权尝试，返回空值 */
export function createDeniedServer(pluginId: string, logger: Logger): ServerClient {
  const deny = (what: string) => {
    logger.warn(`[${pluginId}] 缺少 net:server 权限，已拒绝 ${what}`)
    return null
  }
  return {
    async reportUsage() {
      deny('用量上报')
    },
    async exchangeCredential() {
      return deny('凭据换取')
    },
    async fetchConfig<T>(): Promise<T | null> {
      return deny('远端配置读取')
    },
  }
}

export function createServerClient(options: ServerOptions): ServerClient {
  if (options.mock || !options.url) return createMockServer()
  return createHttpServer(options.url, options.timeoutMs)
}
