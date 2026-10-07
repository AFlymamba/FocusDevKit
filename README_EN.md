# fxDevKit

English | [简体中文](README.md)

[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)
[![platform](https://img.shields.io/badge/platform-windows-lightgrey.svg)](#)

**fxDevKit is a CLI that attaches enhancements to the nodes of your workflow.**

Install it once, then keep working as you always have — `git commit` is still `git commit`. Enhancements run in the background. No repository setup, no new commands to memorize.

What an enhancement does is decided entirely by **plugins**. The kernel ships no capabilities of its own and knows nothing about any specific AI: it discovers plugins, loads them, grants permissions, dispatches, and fails open.

---

## What it solves

You work across many repositories, and some things need doing every single time — prefixing commit messages with a team tag, running a check before commit, recording what just happened.

Project-level hook tools (husky, lefthook) solve this, but you have to configure them **once per repository**, and that config lands in version control. fxDevKit takes the other route:

| | husky / lefthook | fxDevKit |
|---|---|---|
| Scope | One repository (`<repo>/.husky/`) | Global, once for all repositories |
| Config lives in | The repo, committed | `~/.fxdevkit/`, follows the user |
| Capabilities | You write scripts | Plugins (standalone npm packages) |
| Repo intrusion | Yes | **None** — nothing is written into your repositories |

They do not conflict. A repo that already uses husky or lefthook keeps working; fxDevKit does not replace it.

---

## See it in 30 seconds

```bash
fxdevkit install                  # install global hooks, once
cd /path/to/any/repo
git commit -m "fix: login timeout"
git log -1 --pretty=%s
# AI fix: login timeout    <- added by plugin-commit-rules
```

---

## Install

> Not yet published to npm (publishing is planned). Install from source for now.

```powershell
git clone https://github.com/AFlymamba/FocusDevKit.git
cd FocusDevKit
npm install
npm run build

cd packages\cli
npm link                          # registers the global `fxdevkit` command

fxdevkit install                  # install global hooks (once, all repos)
fxdevkit doctor                   # all green = the chain works
```

> Use the system npm (PowerShell / cmd), not a Node bundled with an IDE.
> On Windows, `npm link` occasionally leaves residue; remove `~/.npm/@fxdevkit` and `~/.npm/fxdevkit.{cmd,ps1}` manually.

Uninstall: `fxdevkit uninstall` removes the global hooks, then `npm uninstall -g @fxdevkit/cli`.

---

## Day to day

**Nothing changes** — keep typing `git commit` / `git push`. To see what the enhancements did:

```bash
fxdevkit status      # this repo: hooks, plugins, whether it is excluded
fxdevkit report      # overview of the most recent enhancement
fxdevkit trace       # event trace: what a given commit triggered and how it ended
fxdevkit logs --last 20
fxdevkit doctor      # health check
```

To exclude one directory: `cd <dir> && fxdevkit disable` (writes `exclude` into your user config — it follows you, never enters the repo).

---

## Plugins

A plugin is a standalone npm package that depends **only on `@fxdevkit/sdk`**. Drop it into `~/.fxdevkit/` or a project's `node_modules` and it is discovered automatically — no registration with the kernel.

| Plugin | Short name | What it does |
|---|---|---|
| `@fxdevkit/plugin-commit-rules` | `commit` | Rewrites commit messages by configurable rules (adds an `AI ` prefix by default) and provides a CI check command |
| `@fxdevkit/plugin-feishu` | `feishu` | Feishu entry: @ the bot in a group chat → your machine receives it → replies in the same group (no public IP needed) |

Full docs live in each package: [commit-rules](plugins/commit-rules/README.md) · [feishu](plugins/feishu/README.md).

**Two hard constraints the kernel enforces:** plugins never call each other (the kernel provides no inter-plugin channel), and a plugin only receives the permissions it declared — undeclared ones arrive as empty implementations rather than errors.

Minimal plugin skeleton (see [Concepts](docs/概念词典.md) for all `definePlugin` fields — the doc is in Chinese):

```ts
import { definePlugin } from '@fxdevkit/sdk'

export default definePlugin({
  id: 'plugin-hello',
  hooks: {
    'commit-msg': async (ctx) => {
      ctx.logger.info('hook fired')
      return 'accept'        // 'accept' lets the commit through
    },
  },
  commands: {
    hello: { describe: 'say hello', handler: async (argv, ctx) => 0 },
  },
})
```

Declare `fxdevkit.{id,name,hooks,commands,permissions}` in `package.json` and it is discovered. Full walkthrough in [修改指南 §1](docs/修改指南.md) (Chinese).

---

## How it is built

```
Your command (git commit / fxdevkit status / fxdevkit <plugin> <cmd>)
       │
       ▼
┌──────────────────────────────────┐
│  CLI     packages/cli            │  parse commands, format output
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│  Core    packages/core           │  scheduler (discover / load / authorize / dispatch / fail-open)
│                                  │  + shared modules (git / config / log / events / …)
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│  Plugin  plugins/*               │  each plugin = a standalone npm package
└──────────────────────────────────┘
       ▲
       │ (contract)
┌──────────────────────────────────┐
│  SDK     packages/sdk            │  definePlugin + ctx types
└──────────────────────────────────┘
```

Dependencies are one-directional: `CLI → Core`, `Plugin → SDK`. A plugin depends on neither Core nor another plugin.

---

## Command cheat sheet

```bash
# status
fxdevkit status | doctor | report | trace | logs --last 20

# install / uninstall / scope
fxdevkit install          # install global hooks (once)
fxdevkit uninstall        # remove global hooks
fxdevkit disable          # disable for the current directory
fxdevkit enable           # re-enable for the current directory

# plugins
fxdevkit plugin list
fxdevkit plugin add @fxdevkit/plugin-xxx

# plugin commands (they come from the plugin itself; the CLI hardcodes no plugin id)
fxdevkit commit rules              # which rules are in effect, and where they come from
fxdevkit commit prefix "[AI-GEN] " # change the prefix (also maintains the idempotency guard)
fxdevkit commit check --sha HEAD   # CI check, exits 1 when non-compliant
```

---

## Docs

> Most docs are written in Chinese. The list below tells you what each one covers.

| Doc | What is in it |
|---|---|
| [概念词典 (Concepts)](docs/概念词典.md) | What manifest / hooks / permissions / dispatcher mean |
| [产品定义 (Product definition)](docs/00-产品定义.md) | Why it exists, what it does, what it deliberately does not do |
| [架构设计 (Architecture)](docs/架构设计.md) | How the system runs, key concepts and design decisions |
| [详细设计 (Detailed design)](docs/详细设计.md) | Module APIs, data flow, call chains |
| [命令手册 (Commands)](docs/命令手册.md) | Command reference, env vars, directory layout, troubleshooting |
| [插件列表 (Plugins)](docs/插件列表.md) | Plugin overview |
| [修改指南 (How to modify)](docs/修改指南.md) | Step-by-step: add a plugin, change the kernel, debug |
| [技术方案 (Technical plan)](docs/技术方案.md) | Design rationale, open questions, milestones |
| [开发记录 (Dev record)](docs/90-开发记录.md) | Settled design decisions and their reasoning, TODOs, known gaps |

Reading order: this README → 概念词典 → 命令手册 → 架构设计.

---

## Status

- Kernel (`packages/core`) is roughly 1,900 lines; 2 plugins exist.
- Hooks covered: `commit-msg` / `prepare-commit-msg` / `post-checkout` / `post-merge` / `pre-commit` / `pre-push`.
- Events and logs stay on your machine (`~/.fxdevkit/`). Nothing is uploaded.
- Developed and verified primarily on Windows.

A plugin architecture only proves itself with more plugins. If you write one, open an issue and tell us.

---

## License

[MIT](LICENSE) © 2026 AFlymamba
