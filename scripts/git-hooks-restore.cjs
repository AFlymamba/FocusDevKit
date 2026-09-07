#!/usr/bin/env node
/**
 * fxdevkit — Cursor git hooks 兼容 wrapper
 *
 * 为什么需要它：
 *   Cursor 3.15.6+ 的 git 扩展在每次 spawn git 时，通过环境变量
 *   GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n 强制注入
 *   core.hooksPath=<devNull>，导致所有 git hooks（pre-commit / commit-msg /
 *   pre-push …）被静默跳过，且命令行上看不到任何痕迹。
 *   这个覆盖是环境变量级，优先级高于 git 的 --global / --local 配置，
 *   所以用 git config 无法对抗。
 *
 * 它做什么：
 *   在把命令转发给真正的 git 之前，从环境变量里删掉 core.hooksPath 这一条
 *   覆盖，让 git 回退到正常的 hooks 解析（即 fxdevkit 全局设置的
 *   core.hooksPath = ~/.fxdevkit/hooks），从而恢复 hooks。
 *
 * 如何启用（Cursor）：
 *   在 settings.json 里配置：
 *     "git.path": ["D:\\softs\\node\\node.exe", "D:\\products\\devkit\\scripts\\git-hooks-restore.cjs"]
 *   然后完全重启 Cursor（不是 reload window）。
 *
 * 如何卸载：
 *   删掉 settings.json 里的 git.path 即可。
 */

'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');

const args = process.argv.slice(2);
const env = { ...process.env };

// —— 删除 Cursor 注入的 core.hooksPath 覆盖 ——
(function restoreHooksPath() {
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
    if (k === 'core.hooksPath') continue; // 洗掉
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
})();

// —— 定位真正的 git ——
const git = env.FXDEVKIT_REAL_GIT || 'D:\\softs\\Git\\bin\\git.exe';
if (!existsSync(git)) {
  process.stderr.write(
    '[fxdevkit git-wrapper] 找不到 git：' + git + '\n' +
    '请设置环境变量 FXDEVKIT_REAL_GIT 指向真正的 git.exe，或修改本脚本默认路径。\n'
  );
  process.exit(1);
}

const child = spawn(git, args, { env, stdio: 'inherit', windowsHide: true });

child.on('error', (err) => {
  process.stderr.write('[fxdevkit git-wrapper] 启动 git 失败：' + err.message + '\n');
  process.exit(1);
});

child.on('close', (code, signal) => {
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
