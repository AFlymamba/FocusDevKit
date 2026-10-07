import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { definePlugin } from '@fxdevkit/sdk'

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

/**
 * 默认规则的判据：这次提交在 git 历史图里是不是一个「工作单元」。
 *
 * - `git revert` 是单 parent、有自己 diff 的普通提交，是一次真实的状态变更（而且是最需要
 *   追溯的一类），所以**要打标**。
 * - merge commit 是拓扑节点，作用是连接两条分支，本身不代表新工作，所以不打标。
 *   提交时它由流程守卫（isMerge）拦下，这条规则是给 CI 的 `check` 用的——那个场景没有
 *   git 上下文，只能看 message，而 git 的 merge message 格式是固定的。
 * - 其余（含 `chore:` / `docs:`）一律打标：前缀标记的是「这次提交发生在 AI 增强环境下」，
 *   不是「这次改动是不是代码」。文档也是资产，混合提交时 type 由人主观挑，拿它当判据不可靠。
 */
const DEFAULT_CONFIG: CommitRulesConfig = {
  rules: [
    { name: 'default-guard', pattern: '^(AI|ai)[:\\s]', action: 'skip' },
    { name: 'git-merge', pattern: '^Merge ', action: 'skip' },
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

/**
 * 按注入值生成幂等守卫的 pattern。
 *
 * 守卫必须能认出「本规则注入之后的样子」，否则同一条 message 被二次处理会重复注入。
 * 结尾的 `[:\\s]*` 是为了兼容手写时省略空格的写法（`[AI-GEN]: xxx`）。
 */
function guardPattern(value: string): string {
  return `^${escapeRegExp(value.trim())}[:\\s]*`
}

function isFallback(rule: Rule): boolean {
  return !rule.pattern && rule.action !== 'skip'
}

/**
 * 换掉兜底规则注入的前缀，连带处理两件必须一起做的事：
 *
 *   1. 幂等守卫：注入值必须能被某条 skip 规则匹配，否则重复注入
 *   2. 旧前缀放行：换成新前缀后，历史提交在 check 里不能被判不合规
 *
 * 这两件事如果交给用户手改，几乎必然漏掉——所以封成一条命令，不开放逐步配置。
 */
function setFallbackPrefix(rules: Rule[], value: string): Rule[] {
  const withoutGuard = rules.filter((rule) => rule.name !== 'default-guard')
  const previous = withoutGuard.find(isFallback)

  let next: Rule[]
  if (previous) {
    next = withoutGuard.map((rule) => (isFallback(rule) ? { ...rule, action: 'prefix', value } : rule))
  } else {
    next = [...withoutGuard, { name: 'default', action: 'prefix', value }]
  }

  const stale = previous?.value
  if (stale && stale !== value) {
    const probe = `${stale}fix: something`
    const covered = withoutGuard.some(
      (rule) => rule.action === 'skip' && rule.pattern && new RegExp(rule.pattern).test(probe),
    )
    if (!covered) {
      const seq = next.filter((rule) => rule.name.startsWith('legacy-')).length + 1
      next = [...next, { name: `legacy-${seq}`, pattern: guardPattern(stale), action: 'skip' }]
    }
  }

  // 守卫放最前：它是机器生成的幂等保护，必须优先于其他规则命中才可靠
  return [{ name: 'default-guard', pattern: guardPattern(value), action: 'skip' }, ...next]
}

export default definePlugin<CommitRulesConfig>({
  id: 'plugin-commit-rules',
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

    rules: {
      describe: '列出生效的规则与来源',
      handler(_argv, ctx) {
        const { rules, branches, dryRun } = ctx.config
        const overridden = JSON.stringify(rules) !== JSON.stringify(DEFAULT_CONFIG.rules)
        ctx.logger.info(`生效规则 ${rules.length} 条（来源：${overridden ? '用户配置' : '插件默认'}）`)
        for (const [index, rule] of rules.entries()) {
          const order = `${index + 1}.`.padStart(3)
          const name = rule.name.padEnd(18)
          const action = rule.action.padEnd(8)
          if (rule.pattern) ctx.logger.info(`${order} ${name}${action}/${rule.pattern}/`)
          else ctx.logger.info(`${order} ${name}${action}"${rule.value}"  ← 兜底`)
        }
        ctx.logger.info(`branches: ${branches.join(', ')}   dryRun: ${dryRun}`)
        ctx.logger.info('手改位置：~/.fxdevkit/config.yaml 的 plugins.plugin-commit-rules.rules')
        return 0
      },
    },

    prefix: {
      describe: '设置兜底前缀，同步维护幂等守卫与旧前缀放行规则',
      handler(argv, ctx) {
        const flags = argv.filter((arg) => arg.startsWith('-'))
        if (flags.length > 0) {
          ctx.logger.error(`未知参数：${flags.join(' ')}`)
          ctx.logger.error('用法：fxdevkit commit prefix "AI "')
          return 1
        }

        const value = argv.join(' ')
        if (value.trim() === '') {
          ctx.logger.error('缺少前缀值')
          ctx.logger.error('用法：fxdevkit commit prefix "AI "')
          return 1
        }

        const current = ctx.config.rules
        const next = setFallbackPrefix(current, value)
        // 自己拼出来的规则再走一遍幂等校验，兜到就兜到这里，别落到 hook 里才发现
        assertIdempotent(next)

        ctx.configStore.set({ rules: next })
        ctx.logger.info(`已写入兜底前缀："${value}"`)
        ctx.logger.info('同步维护：')
        ctx.logger.info(`  幂等守卫  default-guard  /${guardPattern(value)}/`)

        const added = next.filter((rule) => !current.some((old) => old.name === rule.name))
        const fallbackAdded = added.some((rule) => rule.name === 'default')
        for (const rule of added) {
          if (!rule.name.startsWith('legacy-')) continue
          ctx.logger.info(`  历史放行  ${rule.name}  /${rule.pattern}/  ← 旧前缀的提交仍判合规`)
        }
        if (fallbackAdded) ctx.logger.info(`  兜底规则  default  "${value}"（原先没有兜底规则，已新增）`)

        if (!/\s$/.test(value)) {
          ctx.logger.warn(
            `前缀不以空白结尾：结果形如「${value}fix: xxx」，且守卫会挡掉所有以「${value.trim()}」开头的提交`,
          )
        }
        ctx.logger.warn('写回是整体序列化，~/.fxdevkit/config.yaml 里原有的注释会被清掉')
        return 0
      },
    },
  },
})
