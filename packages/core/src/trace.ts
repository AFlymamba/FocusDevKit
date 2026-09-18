import type { FxDevkitEvent } from './events.js'

/**
 * 回溯：从事件流里回答「增强到底生效过没有、什么时候停的、为什么停」。
 *
 * 为什么需要单独一层：事件流是流水账，人看不了。而「AI 前缀没了」这类问题
 * 要的不是计数，是三件事——最后一次真正生效是什么时候、最后一次被跳过是
 * 什么原因、中间有没有人动过开关。这里把这三件算成结构化结果，CLI 只负责排版。
 *
 * 内核自身的事件统一用 plugin = 'core'，与插件事件区分开。
 */
export const CORE = 'core'

/** 插件 hook 真正跑完（不是被调用就算，跑完才算） */
export const EV_HANDLED = 'hook.handled'
/** 被调用了但没增强，reason 说明为什么 */
export const EV_SKIPPED = 'hook.skipped'

/** 状态变更事件：谁在什么时候动过开关 */
export const STATE_TYPES = [
  'hooks.installed',
  'hooks.uninstalled',
  'scope.enabled',
  'scope.disabled',
] as const

export type StateType = (typeof STATE_TYPES)[number]

/** 跳过原因。取值固定，便于回溯时按原因归类 */
export const SKIP_REASONS = {
  /** 目录命中 exclude 黑名单 */
  excluded: 'excluded',
  /** 插件清单不合规（如 id 不是 plugin-xxx） */
  invalid: 'invalid',
  /** 插件被用户配置停用 */
  disabled: 'disabled',
  /** 插件配了 projects，当前仓库不在范围内 */
  outOfScope: 'out-of-scope',
  /** 插件加载失败 */
  loadFailed: 'load-failed',
  /** 插件配置非法 */
  configInvalid: 'config-invalid',
  /** 执行超时 */
  timeout: 'timeout',
  /** 执行抛异常 */
  error: 'error',
} as const

export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS]

export interface SkipReasonCount {
  reason: string
  count: number
}

export interface TraceSummary {
  /** 最近一次插件 hook 跑完的事件，没有就是从未生效过 */
  lastHandled: FxDevkitEvent | null
  /** 最近一次「被调用但没增强」，null 表示从没跳过 */
  lastSkipped: FxDevkitEvent | null
  /** 最近一次状态变更（install / uninstall / enable / disable） */
  lastStateChange: FxDevkitEvent | null
  /** 跳过原因分布，按次数降序 */
  skipReasons: SkipReasonCount[]
}

function isType(event: FxDevkitEvent, type: string): boolean {
  return event.plugin === CORE && event.type === type
}

export function isStateChange(event: FxDevkitEvent): boolean {
  return event.plugin === CORE && (STATE_TYPES as readonly string[]).includes(event.type)
}

/**
 * 从事件流算出回溯结论。
 *
 * 入参顺序无所谓——按 ts 排序后取最后一条。ts 是 ISO 8601，字典序即时间序。
 */
export function summarize(events: FxDevkitEvent[]): TraceSummary {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts))

  let lastHandled: FxDevkitEvent | null = null
  let lastSkipped: FxDevkitEvent | null = null
  let lastStateChange: FxDevkitEvent | null = null
  const reasons = new Map<string, number>()

  for (const event of sorted) {
    if (isType(event, EV_HANDLED)) lastHandled = event
    else if (isType(event, EV_SKIPPED)) {
      lastSkipped = event
      const reason = typeof event.reason === 'string' ? event.reason : 'unknown'
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
    } else if (isStateChange(event)) lastStateChange = event
  }

  return {
    lastHandled,
    lastSkipped,
    lastStateChange,
    skipReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  }
}

/**
 * 两个 ISO 时间戳之间差了多少天（不足一天算 0）。
 *
 * 纯字符串运算，不碰 Date.now()，这样测试能给固定时钟。
 */
export function daysBetween(fromTs: string, toTs: string): number {
  const from = Date.parse(fromTs)
  const to = Date.parse(toTs)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.floor((to - from) / 86_400_000)
}

/** 差了多少小时，用于「刚刚 / N 小时前」的措辞 */
export function hoursBetween(fromTs: string, toTs: string): number {
  const from = Date.parse(fromTs)
  const to = Date.parse(toTs)
  if (Number.isNaN(from) || Number.isNaN(to)) return 0
  return Math.floor((to - from) / 3_600_000)
}
