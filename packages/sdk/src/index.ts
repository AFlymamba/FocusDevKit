/**
 * fxDevKit 插件协议
 *
 * 约定：插件只依赖本包。内核据此加载、隔离、授权，不关心插件做什么。
 *
 * 凭据原则（硬约束，任何实现都不得违反）：
 *   插件不得在本地保存任何平台凭据。
 *   访问外部平台（Apifox、AI、需求平台）一律经 Server。
 */

export type HookName =
  | 'commit-msg'
  | 'prepare-commit-msg'
  | 'post-checkout'
  | 'post-merge'
  | 'pre-commit'
  | 'pre-push'

export type Permission =
  | 'events:write'
  | 'git:read'
  | 'git:write'
  | 'fs:repo'
  | 'fs:global'
  | 'net:server'
  | 'proc:exec'

export interface PluginManifest {
  /**
   * 内部唯一标识，用于配置键（`plugins.<id>`）、事件记录与日志过滤。
   *
   * **规则：必须形如 `plugin-xxx`**（小写字母 / 数字，连字符分隔），
   * 且必须与代码内 `definePlugin({ id })` 完全一致——不一致的内核拒绝装载。
   * 不合规的清单会被跳过，原因显示在 `fxdevkit plugin list` / `doctor`。
   */
  id: string
  /**
   * 命令行短名，全局唯一，用于 `fxdevkit <name> ...`。
   * 未声明时取 id。要求简短好记，不得与 fxdevkit 内置命令同名。
   */
  name?: string
  /** 插件协议版本。内核不兼容时跳过并告警 */
  apiVersion: number
  hooks?: HookName[]
  commands?: string[]
  permissions?: Permission[]
}

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * Server 客户端。
 *
 * 插件永远拿不到长期凭据，只能通过 exchangeCredential 换取短期、最小权限的令牌。
 * 所有方法失败时返回空值而不是抛出，由插件决定如何降级。
 */
export interface ServerClient {
  reportUsage(input: { pluginId: string; action: string }): Promise<void>
  exchangeCredential(scope: string): Promise<{ token: string; expiresAt: number } | null>
  fetchConfig<T = unknown>(key: string): Promise<T | null>
}

export interface GitContext {
  root: string
  branch: string | null
  /** .git/MERGE_HEAD 存在 */
  isMerge: boolean
  /** .git/rebase-merge 或 rebase-apply 存在 */
  isRebase: boolean
  isCherryPick: boolean
  /** 本次提交为 amend */
  isAmend: boolean
}

export interface HookContext<C = unknown> {
  pluginId: string
  config: C
  logger: Logger
  git: GitContext
  /** git 传给 hook 的原始参数 */
  args: string[]
  /** commit-msg / prepare-commit-msg 下，git 传入的提交信息文件路径 */
  messageFile?: string
  emit(type: string, payload: Record<string, unknown>): void
  server: ServerClient
  permissions: ReadonlySet<Permission>
}

export type HookOutcome = 'accept' | 'reject' | 'modify' | void

export interface CommandContext<C = unknown> {
  pluginId: string
  config: C
  logger: Logger
  git: GitContext
  emit(type: string, payload: Record<string, unknown>): void
  server: ServerClient
  permissions: ReadonlySet<Permission>
}

export interface CommandSpec<C = unknown> {
  describe?: string
  handler(argv: string[], ctx: CommandContext<C>): Promise<number | void> | number | void
}

export interface PluginEvent {
  ts: string
  plugin: string
  type: string
  repo?: string
  branch?: string | null
  [key: string]: unknown
}

export interface SubscriptionContext<C = unknown> {
  pluginId: string
  config: C
  logger: Logger
}

export interface Subscription<C = unknown> {
  /**
   * 事件匹配模式：
   *   `*`                全部事件
   *   `commit-rules.*`   某个插件的全部事件
   *   `*.rewritten`      所有插件的某类事件
   *   `commit-rules.rewritten`  精确匹配
   */
  pattern: string
  handler(event: PluginEvent, ctx: SubscriptionContext<C>): void | Promise<void>
}

export interface PluginDefinition<C = unknown> {
  id: string
  /** 同一 hook 下的执行顺序，小的先跑。默认 100 */
  priority?: number
  defaultConfig?: C
  /** 归一化并校验配置，非法时抛出 */
  validateConfig?(raw: unknown): C
  hooks?: {
    [K in HookName]?: (ctx: HookContext<C>) => Promise<HookOutcome> | HookOutcome
  }
  commands?: Record<string, CommandSpec<C>>
  /** 订阅其他插件发出的事件。仅在命令执行路径激活，hook 路径不激活 */
  subscriptions?: Subscription<C>[]
}

export function definePlugin<C>(definition: PluginDefinition<C>): PluginDefinition<C> {
  return definition
}
