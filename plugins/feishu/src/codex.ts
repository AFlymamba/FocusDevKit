/**
 * 本机 codex 的问答通道。
 *
 * 实测基础（codex-cli 0.154.0）：
 *   codex exec --skip-git-repo-check --ephemeral -s read-only -m <model> \
 *     -c model_reasoning_effort=<effort> "<问题>"
 *   stdout = 最终答案（干净的）；过程与 token 统计都在 stderr。
 *
 * 三个安全决定（改动前先想清楚）：
 *   - read-only 沙箱：问答不该改文件。要让它改代码是以后的事，走显式配置
 *   - --ephemeral：不留会话文件，群里的每句话是独立问答
 *   - 超时 kill：reasoning=high 可能跑几分钟，不能让它挂死长连接的事件循环
 */
import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface CodexConfig {
  model: string
  effort: string
  /** 毫秒。到点 kill 进程，回复「超时」 */
  timeoutMs: number
  /** codex 的工作目录。空串 = 用户主目录 */
  cwd: string
  /** 传给 codex 的模型指令（相当于 system prompt）。空串 = 完全不传 */
  systemPrompt: string
  /** systemPrompt 落地成的文件路径（运行时写）。空串 = 不带这条参数 */
  instructionsFile: string
}

/**
 * 默认系统指令。这句「不要自称 Codex」不是装饰——
 * 实测：model_instructions_file 是**追加**在 codex 自带指令之上的，
 * 不点名的话模型在群里会自称 Codex，用户会以为接错了东西。
 */
export const DEFAULT_SYSTEM_PROMPT =
  '你在飞书群里回答提问。回答简洁直接，用中文。群友称呼你为「机器人」，不要自称 Codex。'

export const CODEX_DEFAULTS = {
  model: 'gpt-5.6-luna',
  effort: 'high',
  timeoutMs: 300_000,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

/**
 * codex 没有 --system 参数，系统指令走 config 项 `model_instructions_file`（指向一个文件）。
 * 所以要把 systemPrompt 落到文件里再传路径。写失败返回 ''，上层会提示但不阻断——
 * 没有系统指令只是人设淡一点，不该让机器人整条链路挂掉。
 */
export function writeInstructionsFile(file: string, content: string): string {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, 'utf8')
    return file
  } catch {
    return ''
  }
}

export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const

export function buildCodexArgs(question: string, config: CodexConfig): string[] {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s',
    'read-only',
    '-m',
    config.model,
    '-c',
    `model_reasoning_effort=${config.effort}`,
  ]

  if (config.instructionsFile !== '') {
    // -c 的值按 TOML 解析，而 TOML 基本字符串里反斜杠是转义符——Windows 路径必须先转正斜杠
    const file = config.instructionsFile.split('\\').join('/')
    args.push('-c', `model_instructions_file="${file}"`)
  }

  args.push(question)
  return args
}

/** 群消息太长没人读，飞书 text 也有限制。截断要明说 */
const MAX_REPLY_CHARS = 3500

export function clampReply(text: string): string {
  if (text.length <= MAX_REPLY_CHARS) return text
  return `${text.slice(0, MAX_REPLY_CHARS)}\n\n（太长了，已截断。完整答案 ${text.length} 字）`
}

type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { cwd: string; windowsHide: boolean; stdio: readonly ['ignore', 'pipe', 'pipe'] },
) => CodexChild

interface CodexChild {
  stdout: { on(event: 'data', cb: (chunk: string) => void): void }
  stderr: { on(event: 'data', cb: (chunk: string) => void): void }
  on(event: 'error', cb: (error: Error) => void): void
  on(event: 'close', cb: (code: number | null) => void): void
  kill(): void
}

/**
 * 定位 codex 的可执行文件。
 *
 * Windows 上有两个坑，都不能用 spawn('codex') 解决：
 *   1. npm 全局命令是 codex.cmd shim，spawn 不认（实测 ENOENT）；
 *   2. Node 修复 CVE-2024-27980 后 spawn .cmd 强制要求 shell:true，
 *      而问题文本来自群里消息，走 shell 有注入面，不干。
 *
 * 所以直接找 rust 真身 .exe：从 PATH 里每个目录探测 npm 全局包的位置
 * （npm 平铺在 <dir>/node_modules/@openai/...，包内嵌套在 codex 包的 node_modules 里）。
 * 非 Windows 直接用 'codex'。
 */
export function resolveCodexCommand(deps?: {
  platform?: string
  arch?: string
  pathEnv?: string
  exists?: (p: string) => boolean
}): string {
  const platform = deps?.platform ?? process.platform
  if (platform !== 'win32') return 'codex'

  const exists = deps?.exists ?? ((p: string) => fs.existsSync(p))
  const arch = deps?.arch ?? os.arch()
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const pathEnv = deps?.pathEnv ?? process.env.PATH ?? ''

  for (const dir of pathEnv.split(';')) {
    if (dir.trim() === '') continue
    // npm 老版把平台包嵌套在主包的 node_modules 里（本机实况），新版平铺在全局 node_modules
    const roots = [
      path.join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai'),
      path.join(dir, 'node_modules', '@openai'),
    ]
    for (const root of roots) {
      const exe = path.join(root, `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe')
      if (exists(exe)) return exe
    }
  }
  return 'codex' // 兜底交给 spawn 报 ENOENT，上层有对应的人话提示
}

export async function runCodex(
  question: string,
  config: CodexConfig,
  deps?: { spawnImpl?: SpawnLike; log?: (message: string) => void },
): Promise<string> {
  const spawnImpl = deps?.spawnImpl ?? (nodeSpawn as unknown as SpawnLike)
  const log = deps?.log ?? (() => {})
  const cwd = config.cwd || os.homedir()
  const args = buildCodexArgs(question, config)
  const command = resolveCodexCommand()

  log(`转发给本机 codex（model ${config.model} / 思考 ${config.effort}）…`)

  return new Promise<string>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    // stdin 必须 ignore：codex exec 见到「stdin 是管道」就会等它关闭（把 stdin 追加为 <stdin> 块），
    // 我们的问题全在参数里，不给 stdin。默认的 pipe 会让 codex 干等到超时（实测踩过）。
    const child = spawnImpl(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve(
        `codex 超时（${Math.round(config.timeoutMs / 1000)} 秒没跑完，已终止）。` +
          `可以在配置里调大 plugins.plugin-feishu.codex.timeoutMs，或换个轻量问题试试。`,
      )
    }, config.timeoutMs)

    const finish = (text: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(clampReply(text))
    }

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        finish('本机没有找到 codex 命令。先确认 `codex --version` 在终端里能跑通，再回来 @ 我。')
        return
      }
      finish(`codex 启动失败：${error.message}`)
    })
    child.on('close', (code) => {
      if (code === 0) {
        const answer = stdout.trim()
        finish(answer !== '' ? answer : 'codex 跑完了但没有返回内容（stdout 为空）。')
        return
      }
      const tail = stderr.trim().split('\n').slice(-5).join('\n')
      finish(`codex 退出码 ${code ?? '未知'}。最后几行输出：\n${tail || '（无）'}`)
    })
  })
}
