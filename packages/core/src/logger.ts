import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '@fxdevkit/sdk'
import { ensureDir, paths } from './paths.js'

/**
 * 日志追踪。
 *
 * 两条通道：
 *   - core   内核自身的调度日志（发现 / 装载 / 派发 / 跳过 / 超时 / 兜底）
 *   - plugin 某个插件的执行日志（插件通过 ctx.logger 打出来的）
 *
 * 每条日志同时做两件事：
 *   1. 打到 stderr（即时可见，git hook 的 stdout 会被 git 消费，故走 stderr）
 *   2. 落盘到 ~/.fxdevkit/logs/YYYY-MM-DD.log（结构化 JSON，供 `fxdevkit logs` 回看）
 *
 * 落盘失败一律静默 —— 日志丢了可以补，提交断了不行。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogChannel = 'core' | 'plugin'

export interface LogRecord {
  ts: string
  channel: LogChannel
  plugin?: string
  level: LogLevel
  msg: string
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function isLogLevel(value: string | undefined): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}

/** 落盘级别阈值。默认 info，debug 需要显式开启 */
function threshold(): LogLevel {
  if (process.env.FXDEVKIT_DEBUG === '1') return 'debug'
  return isLogLevel(process.env.FXDEVKIT_LOG_LEVEL) ? process.env.FXDEVKIT_LOG_LEVEL : 'info'
}

function isLogEnabled(): boolean {
  return process.env.FXDEVKIT_LOG !== '0'
}

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function logFile(day: string): string {
  return path.join(paths.logs, `${day}.log`)
}

function write(record: LogRecord, verbose: boolean): void {
  const debugMode = process.env.FXDEVKIT_DEBUG === '1'

  // stderr 打印策略：
  //   error / warn 总是打印（异常必须即时可见）
  //   info / debug 仅当 verbose（命令路径）或 FXDEVKIT_DEBUG=1 时打印，
  //   避免 hook 路径每次提交都刷屏
  if (record.level === 'error' || record.level === 'warn' || verbose || debugMode) {
    const label = record.channel === 'core' ? 'core' : `plugin:${record.plugin ?? '?'}`
    process.stderr.write(`[fxdevkit:${label}] ${record.level} ${record.msg}\n`)
  }

  // 落盘策略：info 及以上总是落盘（供 fxdevkit logs 回看），可被 FXDEVKIT_LOG=0 关闭
  if (!isLogEnabled()) return
  try {
    ensureDir(paths.logs)
    fs.appendFileSync(logFile(today()), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    /* 静默 */
  }
}

function makeLogger(channel: LogChannel, pluginId: string | undefined, verbose: boolean): Logger {
  const emit = (level: LogLevel, message: string): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold()]) return
    if (level === 'debug' && !(verbose || process.env.FXDEVKIT_DEBUG === '1')) return
    write(
      {
        ts: new Date().toISOString(),
        channel,
        plugin: pluginId,
        level,
        msg: message,
      },
      verbose,
    )
  }
  return {
    debug: (message) => emit('debug', message),
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  }
}

/** 内核自身的调度日志 */
export function createCoreLogger(verbose = false): Logger {
  return makeLogger('core', undefined, verbose)
}

/** 某个插件的执行日志 */
export function createPluginLogger(pluginId: string): Logger {
  return makeLogger('plugin', pluginId, false)
}

/** 列出所有日志文件对应的日期（YYYY-MM-DD，升序） */
export function listLogDays(): string[] {
  try {
    return fs
      .readdirSync(paths.logs)
      .filter((name) => name.endsWith('.log'))
      .map((name) => name.replace('.log', ''))
      .sort()
  } catch {
    return []
  }
}

export interface LogQuery {
  /** 日期 YYYY-MM-DD，缺省今天 */
  day?: string
  channel?: LogChannel
  plugin?: string
  level?: LogLevel
}

/** 读取某一天的日志，按 ts 升序 */
export function readLogs(query: LogQuery = {}): LogRecord[] {
  const day = query.day ?? today()
  const file = logFile(day)
  try {
    if (!fs.existsSync(file)) return []
  } catch {
    return []
  }

  let records: LogRecord[] = []
  try {
    records = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line) as LogRecord
        } catch {
          return null
        }
      })
      .filter((record): record is LogRecord => record != null)
  } catch {
    return []
  }

  if (query.channel) records = records.filter((r) => r.channel === query.channel)
  if (query.plugin) records = records.filter((r) => r.plugin === query.plugin)
  if (query.level) {
    const min = LEVEL_ORDER[query.level]
    records = records.filter((r) => LEVEL_ORDER[r.level] >= min)
  }
  return records
}
