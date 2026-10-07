/**
 * 本机 codex 问答通道的测试。
 *
 * 跑真的 codex 会烧 token 且要等 reasoning，所以这里全部注入 fake spawn，
 * 只验证：参数拼装、stdout 取答案、失败可读、超时会杀、长文截断。
 * 真实链路（stdout=最终答案、stderr=过程）是 2026-09-17 用 codex-cli 0.154.0 + gpt-5.6-luna 实测的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const moduleUrl = pathToFileURL(
  path.resolve(process.cwd(), 'plugins/feishu/dist/codex.js'),
).href
const { buildCodexArgs, runCodex, clampReply, resolveCodexCommand, writeInstructionsFile, CODEX_DEFAULTS, DEFAULT_SYSTEM_PROMPT } = await import(moduleUrl)

const config = {
  model: 'gpt-5.6-luna',
  effort: 'high',
  timeoutMs: 300_000,
  cwd: 'D:/tmp',
  systemPrompt: '你是 LA-Bot',
  instructionsFile: '',
}

/** 造一个可编程的 fake spawn：close 时机和输出由用例控制 */
function fakeSpawn(outcome) {
  const calls = []
  const spawnImpl = (_cmd, args, opts) => {
    calls.push({ args, opts })
    return {
      stdout: { on: (event, cb) => event === 'data' && outcome.stdout && cb(outcome.stdout) },
      stderr: { on: (event, cb) => event === 'data' && outcome.stderr && cb(outcome.stderr) },
      on: (event, cb) => {
        if (event === 'error' && outcome.error) cb(outcome.error)
        if (event === 'close' && outcome.code !== undefined) cb(outcome.code)
      },
      kill: () => outcome.killed === undefined || (outcome.killed(), undefined),
    }
  }
  return { spawnImpl, calls }
}

test('参数拼齐：只读沙箱、不落会话、指定模型与思考深度，问题在最后', () => {
  const args = buildCodexArgs('长沙天气如何', config)
  assert.deepEqual(args, [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s',
    'read-only',
    '-m',
    'gpt-5.6-luna',
    '-c',
    'model_reasoning_effort=high',
    '长沙天气如何',
  ])
})

test('没配系统指令文件时，不该凭空加参数', () => {
  const args = buildCodexArgs('hi', config)
  assert.ok(!args.some((a) => a.includes('model_instructions_file')), args.join(' '))
})

test('系统指令：走 model_instructions_file，且 Windows 反斜杠要转正斜杠', () => {
  const args = buildCodexArgs('hi', {
    ...config,
    instructionsFile: 'D:\\Users\\me\\.fxdevkit\\codex-instructions.md',
  })
  const flag = args.find((a) => a.includes('model_instructions_file'))
  assert.ok(flag, `要带上系统指令文件：${args.join(' ')}`)
  // -c 的值按 TOML 解析，反斜杠是转义符，不转会被吃掉
  assert.ok(flag.includes('D:/Users/me/.fxdevkit/codex-instructions.md'), flag)
  assert.ok(flag.endsWith('"') === false || flag.includes('"'), '路径要用 TOML 字符串包住')
})

test('系统指令文件写得出来（含建目录）', () => {
  const file = path.join(os.tmpdir(), 'fxdevkit-test', 'nested', 'codex-instructions.md')
  const written = writeInstructionsFile(file, '你是 LA-Bot')
  assert.equal(written, file)
  assert.equal(fs.readFileSync(file, 'utf8'), '你是 LA-Bot')
  fs.rmSync(path.join(os.tmpdir(), 'fxdevkit-test'), { recursive: true, force: true })
})

test('系统指令文件写失败要返回空串，不能让整条链路挂掉', () => {
  const written = writeInstructionsFile('D:\\nul\\not-a-real-dir\\x.md', 'x')
  assert.equal(written, '')
})

test('默认系统提示词非空，且是中文', () => {
  assert.ok(DEFAULT_SYSTEM_PROMPT.length > 0)
  assert.ok(/[\u4e00-\u9fa5]/.test(DEFAULT_SYSTEM_PROMPT))
  assert.equal(CODEX_DEFAULTS.systemPrompt, DEFAULT_SYSTEM_PROMPT)
})

test('成功：stdout 就是最终答案，且 stdin 必须 ignore', async () => {
  const { spawnImpl, calls } = fakeSpawn({ stdout: '收到\n', code: 0 })
  const answer = await runCodex('只回复收到', config, { spawnImpl })
  assert.equal(answer, '收到')
  assert.equal(calls[0].opts.cwd, 'D:/tmp')
  // codex exec 见到管道 stdin 会等它关闭，导致干等到超时（真实踩过）
  assert.equal(calls[0].opts.stdio[0], 'ignore', 'stdin 不 ignore，codex 会挂着不跑')
})

test('非零退出：给退出码和 stderr 尾巴，不是一句 400', async () => {
  const { spawnImpl } = fakeSpawn({ stderr: 'line1\nline2\nerror: boom', code: 1 })
  const answer = await runCodex('hi', config, { spawnImpl })
  assert.ok(answer.includes('退出码 1'), answer)
  assert.ok(answer.includes('error: boom'), answer)
})

test('命令不存在：告诉用户先装 codex', async () => {
  const { spawnImpl } = fakeSpawn({ error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) })
  const answer = await runCodex('hi', config, { spawnImpl })
  assert.ok(answer.includes('codex --version'), answer)
})

test('stdout 为空也要说明，不能当成悄悄过去了', async () => {
  const { spawnImpl } = fakeSpawn({ code: 0 })
  const answer = await runCodex('hi', config, { spawnImpl })
  assert.ok(answer.includes('stdout 为空'), answer)
})

test('超时会 kill 进程并说清怎么调大', async () => {
  let killed = false
  const { spawnImpl } = fakeSpawn({ killed: () => (killed = true) }) // 永不 close
  const answer = await runCodex('hi', { ...config, timeoutMs: 20 }, { spawnImpl })
  assert.ok(killed, '超时后必须 kill')
  assert.ok(answer.includes('超时'), answer)
  assert.ok(answer.includes('timeoutMs'), answer)
})

test('超长答案要截断且注明完整长度', () => {
  const long = 'x'.repeat(4000)
  const clamped = clampReply(long)
  assert.ok(clamped.length < long.length)
  assert.ok(clamped.includes('已截断'), clamped.slice(-60))
  assert.equal(clampReply('短的'), '短的')
})

test('默认值就是你指定的那套（gpt-5.6-luna / high）', () => {
  assert.equal(CODEX_DEFAULTS.model, 'gpt-5.6-luna')
  assert.equal(CODEX_DEFAULTS.effort, 'high')
})

test('Windows 要找 rust 真身 exe，而不是 spawn codex（.cmd shim spawn 不认）', () => {
  const npmDir = 'C:\\Users\\me\\AppData\\Roaming\\npm'
  const exe = path.join(npmDir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
  const command = resolveCodexCommand({
    platform: 'win32',
    arch: 'x64',
    pathEnv: `${npmDir};C:\\Windows\\system32`,
    exists: (p) => p === exe,
  })
  assert.equal(command, exe)
})

test('Windows 找不到 exe 时兜底回 codex，让上层的 ENOENT 提示兜住', () => {
  const command = resolveCodexCommand({
    platform: 'win32',
    arch: 'x64',
    pathEnv: 'C:\\Windows\\system32',
    exists: () => false,
  })
  assert.equal(command, 'codex')
})

test('非 Windows 直接用 codex', () => {
  assert.equal(resolveCodexCommand({ platform: 'darwin' }), 'codex')
  assert.equal(resolveCodexCommand({ platform: 'linux' }), 'codex')
})
