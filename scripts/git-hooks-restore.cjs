#!/usr/bin/env node
/**
 * fxdevkit — Cursor git hooks 兼容 wrapper
 *
 * 为什么需要它：
 *   Cursor 3.15.6+ 的 git 扩展在每次 spawn git 时，通过环境变量
 *   GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n 强制注入
 *   core.hooksPath=<devNull>，导致所有 git hooks（pre-commit / commit-msg /
 *   pre-push …）被静默跳过，且命令行上看不到任何痕迹。
 *
 * 它做什么：
 *   在把命令转发给真正的 git 之前，从环境变量里删掉 core.hooksPath 这一条
 *   覆盖，让 git 回退到正常的 hooks 解析。
 *
 * 启用：在 Cursor settings.json 里配置 git.path = [node.exe, 本文件绝对路径]
 * 卸载：删掉 settings.json 里的 git.path
 *
 * 诊断日志：默认**只记异常**（找不到 git、spawn 失败），写在
 *       ~/.fxdevkit/logs/wrapper.log。
 *
 *       为什么不再记录每次转发：一次 git 调用写两条，Cursor 一天几百次，
 *       攒出来 20MB / 6.7 万行，其中 99.9% 是「正常转发了」这种无用信息。
 *       使用者真正要看的是「它什么时候坏了」，不是「它转发了什么」。
 *
 *       需要看转发细节（比如验证 hooksPath 有没有被洗掉）时，建一个空文件：
 *         ~/.fxdevkit/wrapper-debug
 *       删掉即恢复只记异常。用文件而不是环境变量，是因为 Cursor 是 spawn 本
 *       exe 的，没法单独给它传 env（设系统变量等于永久开启），而标志文件
 *       改完下次 git 调用就生效，不用重启 Cursor。
 */

'use strict';

const { spawn } = require('node:child_process');
const { existsSync, appendFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const LOG_DIR = join(homedir(), '.fxdevkit', 'logs');
const LOG_FILE = join(LOG_DIR, 'wrapper.log');
const DEBUG_FLAG = join(homedir(), '.fxdevkit', 'wrapper-debug');

/** 每次调用一次 existsSync，成本可忽略，换来「改完立即生效、不用重启 Cursor」 */
function debugOn() {
  try {
    return existsSync(DEBUG_FLAG);
  } catch {
    return false;
  }
}

function log(record) {
  try {
    if (record.level !== 'error' && !debugOn()) return;
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), ...record }) + '\n', 'utf8');
  } catch { /* 静默 */ }
}

const args = process.argv.slice(2);
const env = { ...process.env };

// —— 删除 Cursor 注入的 core.hooksPath 覆盖 ——
function restoreHooksPath() {
  const raw = env.GIT_CONFIG_COUNT;
  let count = 0;
  if (raw !== undefined && raw !== '') {
    const n = Number.parseInt(String(raw), 10);
    if (Number.isFinite(n) && n > 0) count = n;
  }
  const keys = [];
  const values = [];
  for (let i = 0; i < count; i++) {
    const k = env['GIT_CONFIG_KEY_' + i];
    const v = env['GIT_CONFIG_VALUE_' + i];
    if (k === 'core.hooksPath') continue;
    keys.push(k);
    values.push(v);
  }
  env.GIT_CONFIG_COUNT = String(keys.length);
  for (let i = 0; i < keys.length; i++) {
    env['GIT_CONFIG_KEY_' + i] = keys[i];
    env['GIT_CONFIG_VALUE_' + i] = values[i];
  }
  for (let i = keys.length; i < count; i++) {
    delete env['GIT_CONFIG_KEY_' + i];
    delete env['GIT_CONFIG_VALUE_' + i];
  }
  return { countBefore: count, countAfter: keys.length, keptKeys: keys };
}
const gitCfg = restoreHooksPath();

// —— 定位真正的 git ——
let git = env.FXDEVKIT_REAL_GIT || 'D:\\softs\\Git\\bin\\git.exe';
if (!existsSync(git)) {
  // 兜底：试试工作流常见位置
  const fallbacks = [
    'C:\\Program Files\\Git\\bin\\git.exe',
    'C:\\Program Files (x86)\\Git\\bin\\git.exe',
    'D:\\softs\\Git\\cmd\\git.exe',
  ];
  for (const f of fallbacks) {
    if (existsSync(f)) { git = f; break; }
  }
}

if (!existsSync(git)) {
  const err = '[fxdevkit git-wrapper] 找不到 git：' + git + '\n';
  log({ level: 'error', msg: 'git not found', tried: git, cwd: process.cwd(), argv: args });
  process.stderr.write(err);
  process.exit(1);
}

// —— 兜底：把 Git for Windows 的 bin 目录塞进 PATH 前面 ——
const gitDir = git.replace(/[\\/][^\\/]+$/, ''); // 去掉 \git.exe
const sep = env.PATH && env.PATH.includes(';') ? ';' : ':';
if (gitDir) {
  env.PATH = gitDir + sep + (env.PATH || '');
  // 如果存在 mingw64\bin 也加上（保险，某些 git 子命令可能需要）
  const mingwBin = join(gitDir, '..', 'mingw64', 'bin');
  if (existsSync(mingwBin)) {
    env.PATH = mingwBin + sep + env.PATH;
  }
}

const child = spawn(git, args, { env, stdio: 'inherit', windowsHide: true });

let stdoutBuf = '';
let stderrBuf = '';
// stdio:'inherit' 时 wrapper 看不到子进程输出，但如果用户开了日志我们也想留个底
// —— 为保持 stdio:'inherit' 的透传优势，不切到 pipe。日志只记元信息。

// 转发细节只在排查时记录（建 ~/.fxdevkit/wrapper-debug）；默认不落盘
log({
  level: 'debug',
  argv: args,
  cwd: process.cwd(),
  git,
  gitCfg,
  hasFxdevkitRealGit: !!env.FXDEVKIT_REAL_GIT,
  pid: child.pid,
});

// 这两处是 wrapper 自己的故障，恒记——git 命令返回非零是 git 的正常语义，不记
child.on('error', (err) => {
  process.stderr.write('[fxdevkit git-wrapper] 启动 git 失败：' + err.message + '\n');
  log({ level: 'error', msg: 'spawn error', err: err.message, git, cwd: process.cwd(), argv: args });
  process.exit(1);
});

child.on('close', (code, signal) => {
  log({ level: 'debug', code, signal, argv: args, cwd: process.cwd() });
  if (signal) {
    process.exit(1);
  } else {
    process.exit(code == null ? 0 : code);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { child.kill(sig); } catch { /* ignore */ }
  });
}
