# fxDevKit

> 对人的增强。你需要什么能力，就装什么插件。

[![version](https://img.shields.io/badge/version-1.0.0-blue)](#)
[![node](https://img.shields.io/badge/node-%3E%3D22-green)](#)
[![windows](https://img.shields.io/badge/platform-windows-lightgrey)](#)

---

## 它是什么（一句话）

**fxDevKit 是对人的增强**：你有目标，需要各种能力去达成——**能力就是插件**，需要什么就装什么。

比如你想专注写代码，不想被提交规范、格式检查这些事打断。装上对应的插件，这些事就在背后自动发生，你只管写代码。

三种方式打开它：

| 入口 | 怎么用 | 例子 |
|---|---|---|
| **自动触发** | 你照常做事，它在背后执行 | `git commit` → 自动补前缀 |
| **主动触发** | 你显式调它 | `fxdevkit status`、`fxdevkit <plugin> <cmd>` |
| **对话触发** | 你说一句话，AI 去调插件的 skill | 飞书 @ 机器人查线上日志（演进方向） |

**内核不实现任何能力**，只负责调度与兜底。边界由你的需求决定——你需要什么，就装什么。

当前装的插件以研发类为主（因为眼下最需要这些）：

- 自动给 commit message 加团队约定前缀（`AI `、项目编号、所属领域……）
- 自动跳过 merge / rebase / cherry-pick 的提交
- `fxdevkit commit check` 校验历史提交格式（给 CI 用）
- 自动记录「这次提交触发了什么 / 结果如何」，落到本地事件流

---

## 装上去（3 步）

> 当前 **不发布 npm**。本地源码 `npm link` 方式装。

```powershell
# 1. 装依赖 + 编译
cd D:\products\devkit
npm install
npm run build

# 2. 把 CLI 链接到全局，注册 fxdevkit 命令
cd packages\cli
npm link

# 3. 装全局 hooks（一次，所有仓库默认都被增强）
fxdevkit install
```

> ⚠️ 注意用 **系统自带的 npm**（PowerShell / cmd），不要用任何 IDE 托管的 Node。
> Windows 下 `npm link` 偶发清不干净，残留手动删 `~/.npm/@fxdevkit` 与 `~/.npm/fxdevkit.{cmd,ps1}`。

### 验证

```bash
fxdevkit --version              # 应输出 @fxdevkit/cli 1.0.0
fxdevkit doctor                 # 全绿 = 增强链路正常
git commit -m "test: hello"     # commit message 应被自动加 "AI " 前缀
```

---

## 用了之后日常怎么用

**对你而言没有任何变化**——继续敲 `git commit` / `git push`。
但有两件事可以看：

```bash
fxdevkit status                  # 当前仓库状态：hooks、插件、是否启用
fxdevkit logs --last 20          # 最近 20 条调度日志
fxdevkit logs --plugin plugin-commit-rules   # 某个插件的日志
fxdevkit doctor                  # 完整健康检查
```

想停用某个目录就：

```bash
cd /d/projects/xxx
fxdevkit disable                 # 停用本目录（写进用户配置 exclude）
```

---

## 它由什么构成（四层）

```
你敲的命令（git commit / fxdevkit run / fxdevkit status）
       │
       ▼
┌──────────────────────────────────┐
│  CLI 层  packages/cli            │  解析命令、格式化输出
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│  Core 层  packages/core          │  调度器（找插件 / 装插件 / 授权 / 派发）
│                                │  + 通用模块（git / 配置 / 日志 / 事件 / …）
└──────────────────────────────────┘
       │               │
       ▼               ▼
┌──────────────────────────────────┐
│  Plugin 层  packages/plugin-*    │  每个插件 = 一个独立 npm 包
└──────────────────────────────────┘
       ▲
       │ （契约）
┌──────────────────────────────────┐
│  SDK 层  packages/sdk            │  definePlugin + ctx 字段类型
└──────────────────────────────────┘
```

**铁律**：

| 约束 | 含义 |
|---|---|
| **单向依赖** | CLI → Core；Plugin → SDK；Plugin 不依赖 Core 或 CLI |
| **插件独立** | 插件之间不互相调用、不互相 require |
| **Core 不代笔** | Core 只编排，不替插件写文件/落事件 |

---

## 文档地图（按需读）

> 新人阅读顺序：**本 README → 概念词典 → 命令手册 → 架构设计**。
> 了解有哪些插件：**插件列表.md**。
> 写插件：**概念词典 → 架构设计 §3 → 修改指南 §1**。
> 改内核：**架构设计 → 详细设计 → 修改指南 §2-5**。

| 文档 | 你想了解什么 | 阅读时间 |
|---|---|---|
| **[`docs/概念词典.md`](docs/概念词典.md)** | manifest / apiVersion / hooks / permissions / dispatcher …这些术语都是什么意思、彼此什么关系、配什么代码位置 | 10 分钟 |
| **[`docs/00-产品定义.md`](docs/00-产品定义.md)** | 为什么做、做什么、不做什么、跟 husky/lefthook 怎么配合 | 10 分钟 |
| **[`docs/架构设计.md`](docs/架构设计.md)** | 系统如何运转、用户视角的核心概念与决策 | 15 分钟 |
| **[`docs/详细设计.md`](docs/详细设计.md)** | 实现视角：包结构、模块 API、数据流、调用链 | 30 分钟 |
| **[`docs/命令手册.md`](docs/命令手册.md)** | 每天用的命令速查、环境变量、目录结构、FAQ | 5 分钟查询 |
| **[`docs/修改指南.md`](docs/修改指南.md)** | 加插件 / 改 dispatch / 改 SDK / 排查问题 / 加新命令的具体步骤 | 按场景查 |
| **[`docs/插件列表.md`](docs/插件列表.md)** | 所有插件一览；每个插件的详细文档在其包目录下（`plugins/<插件>/README.md`） | 5 分钟 |
| **[`docs/技术方案.md`](docs/技术方案.md)** | 设计原理、未决项、里程碑、与现状的对照 | 15 分钟 |

---

## 项目布局

```
D:/products/devkit/
├── packages/               # 内核三件套，彼此单向依赖
│   ├── cli/                # @fxdevkit/cli  — 命令行入口（bin: fxdevkit）
│   ├── core/               # @fxdevkit/core — 内核（调度器 + 通用模块）
│   └── sdk/                # @fxdevkit/sdk  — 插件契约（definePlugin + 类型）
├── plugins/                # 插件，每个是独立 npm 包，只依赖 sdk
│   └── commit-rules/       # 第一个插件：commit message 规则化改写（文档见包内 README.md）
├── docs/                   # 全部文档（看上文「文档地图」）
├── scripts/                # 工具脚本（Cursor git hooks 兼容 wrapper）
└── package.json            # npm workspaces 根（packages/* + plugins/*）
```

---

## 当前能力（1.0.0）

- ✅ CLI 命令：`status` / `doctor` / `install` / `uninstall` / `disable` / `enable` / `update [version]` / `plugin` / `config` / `report` / `logs`
- ✅ 通用 hooks：`commit-msg` / `prepare-commit-msg` / `post-checkout` / `post-merge` / `pre-commit` / `pre-push`
- ✅ 第一个插件 `plugin-commit-rules`：自动给 commit message 加 `AI ` 前缀、规则化校验
- ✅ 全局 hooks（`core.hooksPath`）+ 目录级排除（用户配置 `exclude`，跟人走）
- ✅ 作用域（`plugins.<id>.projects`）
- ✅ 日志追踪（双通道：`core` / `plugin`，按天落盘）
- ✅ 事件落盘（按月 JSONL）
- ✅ 插件权限模型（未声明即空实现，不报错）
- ✅ Cursor GUI 提交兼容（`scripts/git-hooks-restore.exe`）

## 还在路上

- ⏳ 第二个插件（接口变更同步 / `api-sync`）—— 验证"加插件的边际成本足够低"
- ⏳ 插件市场 / 签名 / 可信源 —— 等真正出现第三方插件再考虑
- ⏳ `requires` 声明 + `fxdevkit plugins --sync` —— 当前用 `plugin add` 手动替代

---

## 与 husky/lefthook 的关系

| 工具 | 角色 |
|---|---|
| **husky** | 项目级 hook 管理（在 `<repo>/.husky/`） |
| **lefthook** | 项目级 hook 管理（YAML 配置 + 各种执行器） |
| **fxDevKit** | 跨项目的 hook 入口（全局 `~/.fxdevkit/hooks/`）+ 插件派发 |

**关键不冲突**：fxDevKit 内部保留了仓库自有 hook（仓库自有 hook 优先于 fxdevkit 增强）。
原本装了 husky / lefthook 的仓库，**照常执行，不被取代**。

---

## 命令速查（30 秒版）

```bash
# 看状态
fxdevkit status
fxdevkit doctor
fxdevkit logs --last 20

# 装 / 卸
fxdevkit install                  # 装全局 hooks（一次）
fxdevkit uninstall                # 卸载全局 hooks
fxdevkit disable                  # 停用本目录
fxdevkit enable                   # 恢复本目录
fxdevkit update                   # 更新自身（卸载：npm uninstall -g @fxdevkit/cli）

# 插件管理
fxdevkit plugin list
fxdevkit plugin add @fxdevkit/plugin-xxx
fxdevkit plugin enable xxx
fxdevkit plugin disable xxx

# 跑插件命令
fxdevkit commit check             # 触发 plugin-commit-rules 的 check 子命令
```

完整命令见 [`docs/命令手册.md`](docs/命令手册.md)。

---

## 许可

内部项目，未发布。