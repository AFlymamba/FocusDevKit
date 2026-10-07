# fxDevKit

**English** | 简体中文

[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)
[![platform](https://img.shields.io/badge/platform-windows-lightgrey.svg)](#)

**fxDevKit 是一个命令行工具：把「增强」挂到你工作流的节点上。**

装一次，之后你照常工作——`git commit` 还是 `git commit`，增强在背后发生，不需要改任何仓库、不需要记新命令。

增强做什么由**插件**决定。内核不内置任何能力，也不认识任何具体的 AI：它只负责发现插件、装载、按权限授权、派发、以及出错时兜底放行。

---

## 它解决什么问题

你在多个仓库里工作，有些事每次都要做、但不想做——给 commit message 加团队前缀、提交前跑一遍检查、把这次做了什么记下来。

项目级 hook 工具（husky / lefthook）能解决，但要**每个仓库配一遍**，配置还进版本库。fxDevKit 是另一条路：

| | husky / lefthook | fxDevKit |
|---|---|---|
| 生效范围 | 单个仓库（`<repo>/.husky/`） | 全局一次，所有仓库 |
| 配置存放 | 仓库内，进版本库 | 用户目录 `~/.fxdevkit/`，跟人走 |
| 能力来源 | 自己写脚本 | 插件（独立 npm 包，装卸自由） |
| 仓库侵入 | 有 | **零**——装完直接能用，不用碰仓库任何文件 |

两者不冲突：仓库里已经装了 husky / lefthook 的，照常执行，fxDevKit 不取代它。

---

## 30 秒看效果

```bash
fxdevkit install                  # 挂全局 hooks，一次
cd /path/to/any/repo
git commit -m "fix: 登录超时"
git log -1 --pretty=%s
# AI fix: 登录超时          ← plugin-commit-rules 加的
```

---

## 装

> 尚未发布 npm 包（发布在规划中），目前用源码安装。

```powershell
git clone https://github.com/AFlymamba/FocusDevKit.git
cd FocusDevKit
npm install
npm run build

cd packages\cli
npm link                          # 注册全局 fxdevkit 命令

fxdevkit install                  # 挂全局 hooks（一次，所有仓库生效）
fxdevkit doctor                   # 全绿 = 链路正常
```

> 用系统自带的 npm（PowerShell / cmd），不要用 IDE 托管的 Node。
> Windows 下 `npm link` 偶发清不干净，残留可手动删 `~/.npm/@fxdevkit` 与 `~/.npm/fxdevkit.{cmd,ps1}`。

卸载：`fxdevkit uninstall` 摘掉全局 hooks，然后 `npm uninstall -g @fxdevkit/cli`。

---

## 日常怎么用

**没有变化**——继续敲 `git commit` / `git push`。想看增强干了什么：

```bash
fxdevkit status      # 当前仓库：hooks、插件、是否被排除
fxdevkit report      # 最近一次的增强概览
fxdevkit trace       # 事件回溯：某次提交到底触发了什么、结果如何
fxdevkit logs --last 20
fxdevkit doctor      # 健康检查
```

某个目录不想被增强：`cd <dir> && fxdevkit disable`（写进用户配置的 `exclude`，跟人走，不进仓库）。

---

## 插件

插件是独立 npm 包，**只依赖 `@fxdevkit/sdk`**，装到 `~/.fxdevkit/` 或工程 `node_modules` 下即被自动发现，不需要向内核注册。

| 插件 | 短名 | 做什么 |
|---|---|---|
| `@fxdevkit/plugin-commit-rules` | `commit` | 按可配规则改写 commit message（默认加 `AI ` 前缀），并提供 CI 校验命令 |
| `@fxdevkit/plugin-feishu` | `feishu` | 飞书入口：群里 @ 机器人 → 本机收到 → 回复原群（无需公网 IP） |

每个插件的详细文档在其包目录下：[commit-rules](plugins/commit-rules/README.md) · [feishu](plugins/feishu/README.md)。

**内核对插件的两条硬约束**：插件之间不互相调用（内核不提供任何插件间通道）；插件只能拿到自己声明过的权限，未声明给空实现而不是报错。

写一个插件的最小骨架（`definePlugin` 的完整字段见 [概念词典](docs/概念词典.md)）：

```ts
import { definePlugin } from '@fxdevkit/sdk'

export default definePlugin({
  id: 'plugin-hello',
  hooks: {
    'commit-msg': async (ctx) => {
      ctx.logger.info('hook 触发了')
      return 'accept'        // 返回 accept 表示放行
    },
  },
  commands: {
    hello: { describe: '打个招呼', handler: async (argv, ctx) => 0 },
  },
})
```

在 `package.json` 里声明 `fxdevkit.{id,name,hooks,commands,permissions}` 即被发现。完整步骤见 [修改指南 §1](docs/修改指南.md)。

---

## 它由什么构成

```
你敲的命令（git commit / fxdevkit status / fxdevkit <plugin> <cmd>）
       │
       ▼
┌──────────────────────────────────┐
│  CLI     packages/cli            │  解析命令、格式化输出
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│  Core    packages/core           │  调度器（发现 / 装载 / 授权 / 派发 / 兜底）
│                                  │  + 通用模块（git / 配置 / 日志 / 事件 / …）
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│  Plugin  plugins/*               │  每个插件 = 一个独立 npm 包
└──────────────────────────────────┘
       ▲
       │ （契约）
┌──────────────────────────────────┐
│  SDK     packages/sdk            │  definePlugin + ctx 类型
└──────────────────────────────────┘
```

依赖是单向的：`CLI → Core`，`Plugin → SDK`。插件不依赖 Core，也不依赖别的插件。

---

## 命令速查

```bash
# 看状态
fxdevkit status | doctor | report | trace | logs --last 20

# 装 / 卸 / 作用域
fxdevkit install          # 挂全局 hooks（一次）
fxdevkit uninstall        # 摘掉全局 hooks
fxdevkit disable          # 停用当前目录（写进用户配置 exclude）
fxdevkit enable           # 恢复当前目录

# 插件
fxdevkit plugin list
fxdevkit plugin add @fxdevkit/plugin-xxx

# 插件命令（命令来自插件自身，CLI 不硬编码任何插件 id）
fxdevkit commit rules              # 当前生效的规则与来源
fxdevkit commit prefix "[AI-GEN] " # 换前缀（连带维护幂等守卫与历史提交放行）
fxdevkit commit check --sha HEAD   # CI 校验，不合规返回 1
```

完整命令、环境变量、目录结构见 [命令手册](docs/命令手册.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [概念词典](docs/概念词典.md) | manifest / hooks / permissions / dispatcher 这些术语是什么意思 |
| [产品定义](docs/00-产品定义.md) | 为什么做、做什么、不做什么、边界在哪 |
| [架构设计](docs/架构设计.md) | 系统如何运转、核心概念与设计决策 |
| [详细设计](docs/详细设计.md) | 实现视角：模块 API、数据流、调用链 |
| [命令手册](docs/命令手册.md) | 命令速查、环境变量、目录结构、排错 |
| [插件列表](docs/插件列表.md) | 插件一览 |
| [修改指南](docs/修改指南.md) | 加插件 / 改内核 / 排查的具体步骤 |
| [技术方案](docs/技术方案.md) | 设计原理、未决项、里程碑 |
| [开发记录](docs/90-开发记录.md) | 已拍板的设计决策及其理由、待办、已知缺口 |

新人阅读顺序：本 README → 概念词典 → 命令手册 → 架构设计。

---

## 现状

- 内核 `packages/core` 约 1900 行；插件 2 个。
- 已覆盖的 hook：`commit-msg` / `prepare-commit-msg` / `post-checkout` / `post-merge` / `pre-commit` / `pre-push`。
- 事件与日志全部落在本地（`~/.fxdevkit/`），不上传。
- 主要在 Windows 上开发验证。

插件化架构的价值需要更多插件来验证——如果你写了一个插件，欢迎提 issue 告诉我们。

---

## License

[MIT](LICENSE) © 2026 AFlymamba
