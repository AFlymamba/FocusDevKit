import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, paths } from './paths.js'

export interface DevkitEvent {
  ts: string
  plugin: string
  type: string
  repo?: string
  branch?: string | null
  [key: string]: unknown
}

export type Emitter = (type: string, payload?: Record<string, unknown>) => void

export interface EmitterScope {
  repoRoot?: string | null
  branch?: string | null
}

export interface Subscription {
  pluginId: string
  pattern: string
  handler: (event: DevkitEvent) => void | Promise<void>
}

function monthFile(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return path.join(paths.events, `${date.getFullYear()}-${month}.jsonl`)
}

/** 落盘。任何失败都必须静默 —— 统计丢了可以补，提交断了不行 */
function append(event: DevkitEvent, date: Date): void {
  try {
    ensureDir(paths.events)
    fs.appendFileSync(monthFile(date), `${JSON.stringify(event)}\n`, 'utf8')
  } catch {
    /* 静默 */
  }
}

export function matchesPattern(pattern: string, event: DevkitEvent): boolean {
  if (pattern === '*') return true
  const target = `${event.plugin}.${event.type}`
  if (pattern === target) return true
  if (pattern.endsWith('.*')) return event.plugin === pattern.slice(0, -2)
  if (pattern.startsWith('*.')) return event.type === pattern.slice(2)
  return false
}

/**
 * 事件总线：落盘 + 订阅分发。
 *
 * 仅在命令执行路径使用。hook 路径用 createEmitter（只落盘），因为
 * commit hook 对延迟敏感，订阅者的副作用不该阻塞提交。
 */
export class EventBus {
  private subscriptions: Subscription[] = []
  private pending: Promise<unknown>[] = []

  constructor(private scope: EmitterScope = {}) {}

  register(subscriptions: Subscription[]): void {
    this.subscriptions.push(...subscriptions)
  }

  emitterFor(pluginId: string): Emitter {
    return (type, payload = {}) => {
      const now = new Date()
      const event: DevkitEvent = {
        ts: now.toISOString(),
        plugin: pluginId,
        type,
        repo: this.scope.repoRoot ?? undefined,
        branch: this.scope.branch ?? undefined,
        ...payload,
      }
      append(event, now)
      this.dispatch(event)
    }
  }

  /** fire-and-forget，但记录 promise 供 drain 等待，避免命令结束被截断 */
  private dispatch(event: DevkitEvent): void {
    for (const subscription of this.subscriptions) {
      if (!matchesPattern(subscription.pattern, event)) continue
      this.pending.push(
        Promise.resolve()
          .then(() => subscription.handler(event))
          .catch(() => {
            /* 订阅者异常不影响事件源 */
          }),
      )
    }
  }

  /** 等待所有订阅者完成，包括订阅者自身触发的新事件 */
  async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0)
      await Promise.allSettled(batch)
    }
  }
}

/** hook 路径专用：只落盘，不做订阅分发 */
export function createEmitter(pluginId: string, scope: EmitterScope): Emitter {
  return (type, payload = {}) => {
    const now = new Date()
    append(
      {
        ts: now.toISOString(),
        plugin: pluginId,
        type,
        repo: scope.repoRoot ?? undefined,
        branch: scope.branch ?? undefined,
        ...payload,
      },
      now,
    )
  }
}

export function createSilentEmitter(): Emitter {
  return () => {}
}

export function readEvents(month: string): DevkitEvent[] {
  const file = path.join(paths.events, `${month}.jsonl`)
  try {
    if (!fs.existsSync(file)) return []
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as DevkitEvent)
  } catch {
    return []
  }
}

export function listEventMonths(): string[] {
  try {
    return fs
      .readdirSync(paths.events)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.replace('.jsonl', ''))
      .sort()
  } catch {
    return []
  }
}
