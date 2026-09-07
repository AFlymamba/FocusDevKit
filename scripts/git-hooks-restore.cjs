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
 * 诊断：每次被调用都会向 ~/.fxdevkit/logs/wrapper.log 追加一行 JSON
 *       （含时间、cwd、参数、清理后的 GIT_CONFIG、spawn 的 git、退出码）。
 *       排查 Cursor 报"没有 Git 存储库"等问题时直接看这个文件。
 */

'use strict';

const { spawn } = require('node:child_process');
const { existsSync, appendFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const LOG_DIR = join(homedir(), '.fxdevkit', 'logs');
const LOG_FILE = join(LOG_DIR, 'wrapper.log');

function log(record) {
  try {
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

log({
  level: 'info',
  argv: args,
  cwd: process.cwd(),
  git,
  gitCfg,
  hasFxdevkitRealGit: !!env.FXDEVKIT_REAL_GIT,
  pid: child.pid,
});

child.on('error', (err) => {
  process.stderr.write('[fxdevkit git-wrapper] 启动 git 失败：' + err.message + '\n');
  log({ level: 'error', msg: 'spawn error', err: err.message, git, cwd: process.cwd() });
  process.exit(1);
});

child.on('close', (code, signal) => {
  log({ level: 'info', code, signal, argv: args, cwd: process.cwd() });
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
