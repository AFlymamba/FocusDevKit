import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { definePlugin } from '@devkit/sdk'

type RuleAction = 'skip' | 'prefix' | 'suffix' | 'template'

interface Rule {
  name: string
  /** 命中该正则才应用本规则。缺省表示兜底规则 */
  pattern?: string
  action: RuleAction
  value?: string
}

interface CommitRulesConfig {
  rules: Rule[]
  /** 生效分支，['*'] 表示全部分支 */
  branches: string[]
  dryRun: boolean
}

const DEFAULT_CONFIG: CommitRulesConfig = {
  rules: [
    { name: 'ai-explicit', pattern: '^(AI|ai)[:\\s]', action: 'skip' },
    { name: 'no-ai', pattern: '^(chore|docs|merge|revert)[:\\s]', action: 'skip' },
    { name: 'default', action: 'prefix', value: 'AI ' },
  ],
  branches: ['*'],
  dryRun: false,
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeRules(raw: unknown): Rule[] {
  if (!Array.isArray(raw)) return DEFAULT_CONFIG.rules
  const rules: Rule[] = []
  for (const [index, item] of raw.entries()) {
    if (!isRecord(item)) throw new Error(`rules[${index}] 必须是对象`)
    const { name, pattern, action, value } = item
    if (typeof name !== 'string' || name === '') {
      throw new Error(`rules[${index}].name 必须是非空字符串`)
    }
    if (action !== 'skip' && action !== 'prefix' && action !== 'suffix' && action !== 'template') {
      throw new Error(`rules[${index}].action 必须是 skip / prefix / suffix / template`)
    }
    if (pattern !== undefined && typeof pattern !== 'string') {
      throw new Error(`rules[${index}].pattern 必须是字符串`)
    }
    if (action !== 'skip') {
      if (typeof value !== 'string' || value === '') {
        throw new Error(`rules[${index}].value 在 action=${action} 时必填`)
      }
      try {
        new RegExp(value.replace('{message}', 'x'))
      } catch {
        /* template 的 value 不需要是正则 */
      }
    }
    rules.push({ name, pattern, action, value } as Rule)
  }
  return rules
}

/**
 * 幂等性交叉校验。
 *
 * 兜底规则注入的前缀，必须能被某条 skip 规则匹配，否则同一条 message
 * 被二次处理时会变成 "AI AI xxx"。
 */
function assertIdempotent(rules: Rule[]): void {
  const guards = rules.filter((r) => r.action === 'skip' && r.pattern)
  const fallbacks = rules.filter((r) => !r.pattern && r.action !== 'skip')

  for (const rule of fallbacks) {
    const value = rule.value ?? ''
    const probe = rule.action === 'suffix' ? `fix: something${value}` : `${value}fix: something`
    const covered = guards.some((guard) => new RegExp(guard.pattern as string).test(probe))
    if (covered) continue

    const suggestion =
      rule.action === 'suffix'
        ? `{ name: '${rule.name}-guard', pattern: '${escapeRegExp(value.trim())}$', action: 'skip' }`
        : `{ name: '${rule.name}-guard', pattern: '^${escapeRegExp(value.trim())}', action: 'skip' }`

    throw new Error(
      `规则「${rule.name}」注入的「${value.trim()}」无法被任何 skip 规则匹配，会导致重复注入。建议新增 ${suggestion}`,
    )
  }
}

function branchMatches(patterns: string[] | undefined, branch: string | null): boolean {
  if (!patterns || patterns.length === 0 || patterns.includes('*')) return true
  if (!branch) return true
  return patterns.some((pattern) => {
    if (pattern === branch) return true
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)
    return regex.test(branch)
  })
}

function applyRule(rule: Rule, original: string, firstLine: string): string {
  const value = rule.value ?? ''
  switch (rule.action) {
    case 'prefix':
      return value + original
    case 'suffix':
      return firstLine + value + original.slice(firstLine.length)
    case 'template':
      return value.includes('{message}') ? value.replace('{message}', original) : value + original
    default:
      return original
  }
}

export default definePlugin<CommitRulesConfig>({
  id: 'commit-rules',
  priority: 100,
  defaultConfig: DEFAULT_CONFIG,

  validateConfig(raw) {
    const input = isRecord(raw) ? raw : {}
    const rules = input.rules === undefined ? DEFAULT_CONFIG.rules : normalizeRules(input.rules)
    assertIdempotent(rules)

    const branches = Array.isArray(input.branches)
      ? input.branches.filter((b): b is string => typeof b === 'string')
      : DEFAULT_CONFIG.branches

    return {
      rules,
      branches,
      dryRun: input.dryRun === true,
    }
  },

  hooks: {
    'commit-msg': async (ctx) => {
      const config = ctx.config

      // 守卫：非标准提交流程一律不改写，否则统计数据会失真
      const abnormal = {
        merge: ctx.git.isMerge,
        rebase: ctx.git.isRebase,
        cherryPick: ctx.git.isCherryPick,
        amend: ctx.git.isAmend,
      }
      if (Object.values(abnormal).some(Boolean)) {
        ctx.emit('commit.guarded', { reason: 'non-standard-flow', ...abnormal })
        return 'accept'
      }

      if (!branchMatches(config.branches, ctx.git.branch)) {
        ctx.emit('commit.guarded', { reason: 'branch-out-of-scope', branch: ctx.git.branch })
        return 'accept'
      }

      const file = ctx.messageFile
      if (!file) {
        ctx.logger.warn('未拿到提交信息文件路径，已放行')
        return 'accept'
      }
      if (!fs.existsSync(file)) {
        ctx.logger.warn(`提交信息文件不存在：${file}，已放行`)
        return 'accept'
      }

      const original = fs.readFileSync(file, 'utf8')
      const firstLine = original.split('\n')[0] ?? ''

      // 有 pattern 的规则按顺序短路
      for (const rule of config.rules) {
        if (!rule.pattern) continue
        if (!new RegExp(rule.pattern).test(firstLine)) continue

        if (rule.action === 'skip') {
          ctx.emit('commit.passed', { rule: rule.name, message: firstLine })
          return 'accept'
        }

        const next = applyRule(rule, original, firstLine)
        ctx.emit('commit.rewritten', {
          rule: rule.name,
          action: rule.action,
          value: rule.value,
          original: firstLine,
          result: next.split('\n')[0],
          dryRun: config.dryRun,
        })
        if (!config.dryRun && next !== original) fs.writeFileSync(file, next, 'utf8')
        else if (config.dryRun) ctx.logger.info(`[dry-run] 将改写为：${next.split('\n')[0]}`)
        return next === original ? 'accept' : 'modify'
      }

      // 兜底规则
      const fallback = config.rules.find((rule) => !rule.pattern && rule.action !== 'skip')
      if (!fallback) {
        ctx.emit('commit.passed', { rule: null, message: firstLine })
        return 'accept'
      }

      const next = applyRule(fallback, original, firstLine)
      ctx.emit('commit.rewritten', {
        rule: fallback.name,
        action: fallback.action,
        value: fallback.value,
        original: firstLine,
        result: next.split('\n')[0],
        dryRun: config.dryRun,
      })
      if (!config.dryRun && next !== original) fs.writeFileSync(file, next, 'utf8')
      else if (config.dryRun) ctx.logger.info(`[dry-run] 将改写为：${next.split('\n')[0]}`)

      return next === original ? 'accept' : 'modify'
    },
  },

  commands: {
    check: {
      describe: '校验提交信息是否符合规则（用于 CI，不修改任何内容）',
      handler(argv, ctx) {
        const shaIndex = argv.findIndex((a) => a === '--sha' || a === '-s')
        const sha = shaIndex >= 0 ? argv[shaIndex + 1] : 'HEAD'
        if (!sha) {
          ctx.logger.error('--sha 需要一个值')
          return 1
        }

        let message: string
        try {
          message = execFileSync('git', ['log', '-1', '--pretty=%B', sha], {
            cwd: ctx.git.root,
            encoding: 'utf8',
          })
        } catch {
          ctx.logger.error(`读取提交失败：${sha}`)
          return 1
        }

        const firstLine = message.split('\n')[0] ?? ''
        const config = ctx.config

        for (const rule of config.rules) {
          if (!rule.pattern) continue
          if (!new RegExp(rule.pattern).test(firstLine)) continue
          if (rule.action === 'skip') {
            ctx.logger.info(`通过（命中 skip 规则「${rule.name}」）：${firstLine}`)
            return 0
          }
          ctx.logger.info(`通过（命中规则「${rule.name}」）：${firstLine}`)
          return 0
        }

        const fallback = config.rules.find((rule) => !rule.pattern && rule.action !== 'skip')
        if (!fallback) return 0

        const expected = applyRule(fallback, message, firstLine).split('\n')[0]
        ctx.logger.error(`不符合规则：${firstLine}`)
        ctx.logger.error(`期望形如：${expected}`)
        return 1
      },
    },
  },
})
