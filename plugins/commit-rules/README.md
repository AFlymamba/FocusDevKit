# plugin-commit-rules 插件：工作原理与使用

> 挂在 `git commit` 背后，按**可配置规则**自动改写或校验提交信息。
> 对应源码：`src/index.ts`
> 最后更新：2026-09-25

> **归属**：[fxDevKit](../../README.md)（[English](../../README_EN.md)）的插件，遵循 MIT 许可。
> **本文档定位**：面向使用者与插件作者，讲清插件的工作原理、默认规则与自定义方法。

---

## 一、它解决什么问题

一句话：**让「给 commit message 加 AI 前缀」这件小事，从"每次手动敲"变成"规则化自动处理"。**

更准确地说，它解决三类问题：

| 问题 | 它怎么做 |
|---|---|
| 团队约定要加 `AI ` 前缀，容易忘 | 提交时自动加，无需记得 |
| 重复加（`AI AI xxx`） | 幂等守卫，已带前缀的不重复加 |
| 某些类型/分支不该加前缀 | 用 skip 规则跳过，用 branches 限定分支 |

它**不绑定** "AI 前缀" 这一种做法——规则完全可配，你能改成加后缀、套模板、按类型跳过，甚至改成"校验格式、违规阻断"（`check` 命令）。

---

## 二、工作原理（规则引擎）

### 2.1 触发时机

插件在 manifest 里声明监听 `commit-msg` 这个 git hook：

```jsonc
// package.json
"fxdevkit": {
  "id": "plugin-commit-rules",
  "name": "commit",
  "hooks": ["commit-msg"],        // ← 监听这个 hook
  "commands": ["check", "rules", "prefix"],   // ← 提供 fxdevkit commit <cmd> 命令
  "permissions": ["events:write", "git:read", "fs:repo", "fs:global", "proc:exec"]
}
```

> `fs:global` 是 `commands.prefix` 写用户配置所需的权限（`ctx.configStore.set`）。未声明时内核给的是空实现——命令不报错，但配置不会落盘。

`commit-msg` hook 的触发点是：**git 执行 `git commit`，用户填完信息、git 准备落库之前**。此时 git 会把提交信息写进一个临时文件，把文件路径作为参数传给 hook。插件要做的事就是：**读这个文件 → 按规则改 → 写回这个文件**。git 随后用改写后的内容落库。

> 关键设计：插件改的是**文件**，不是改 git 的状态。它拿到的是一个文件路径（`ctx.messageFile`），改完写回即可。git 会自己读文件。

### 2.2 一次 commit-msg 的完整处理流程

```
git commit 触发 commit-msg hook
        │
        ▼
① 异常流程守卫：merge / rebase / cherry-pick / amend
        │  命中 → 不改写，直接放行（避免污染统计）
        ▼
② 分支过滤：当前分支不在 branches 清单里 → 放行
        │
        ▼
③ 取提交信息文件（ctx.messageFile），读第一行 firstLine
        │  文件不存在 → 放行
        ▼
④ 按顺序匹配「有 pattern 的规则」
        │  命中且 action=skip   → 放行（不改写）
        │  命中且其他 action     → 改写 → 写回文件 → 结束
        │  没命中任何一条        → 继续下一步
        ▼
⑤ 兜底规则（无 pattern、非 skip 的那条）
        │  不存在 → 放行
        │  存在   → 改写 → 写回文件 → 结束
```

**顺序是关键**：有 `pattern` 的规则**从上到下短路匹配**，第一条命中的生效；都没命中才落到兜底规则。所以规则顺序就是优先级。

### 2.3 规则引擎的四个概念

一条规则长这样：

```ts
interface Rule {
  name: string        // 规则名（用于日志/事件/报错定位）
  pattern?: string    // 正则，命中才应用本规则；缺省 = 兜底规则
  action: RuleAction  // skip | prefix | suffix | template
  value?: string      // skip 不需要；其他 action 必填
}
```

**action 四种动作**（假设原文第一行是 `fix: 修复登录`，body 是 `\n\n详情`）：

| action | 效果 | 示例（value=`AI `） |
|---|---|---|
| `skip` | 命中 pattern 则**不改写、放行** | — |
| `prefix` | 整段前加 value | `AI fix: 修复登录\n\n详情` |
| `suffix` | 第一行末尾加 value（body 不动） | `fix: 修复登录 AI \n\n详情` |
| `template` | value 含 `{message}` 则替换为原文，否则 value+原文 | value=`[AI] {message}` → `[AI] fix: 修复登录\n\n详情` |

**pattern 匹配的对象是第一行**（`firstLine`），不是整段 message。body 不会被 pattern 扫描。

---

## 三、默认规则（开箱即用，什么都不配）

插件内置三条默认规则（源码 `DEFAULT_CONFIG`）：

```yaml
rules:
  - name: default-guard
    pattern: '^(AI|ai)[:\s]'    # 已带前缀 → 跳过（幂等，防重复注入）
    action: skip
  - name: git-merge
    pattern: '^Merge '          # merge commit 是拓扑节点，不是工作单元
    action: skip
  - name: default
    action: prefix              # 兜底 → 加 "AI " 前缀
    value: 'AI '
branches:
  - '*'                         # 全部分支生效
dryRun: false                   # 真正改写
```

**判据是「这次提交在 git 历史图里是不是一个工作单元」，不是「message 是谁写的」：**

| commit | parent 数 | 在图里的角色 | 打标 |
|---|---|---|---|
| 普通提交 | 1 | 工作单元 | ✅ |
| `git revert` | 1 | 工作单元：有自己的 tree 和 diff，是一次真实的状态变更 | ✅ |
| `git merge`（--no-ff） | 2 | 拓扑节点：作用是连接两条分支，本身不代表新工作 | ❌ |
| `git cherry-pick` | 1 | 已有工作的搬运，原提交已打过标 | ❌（流程守卫拦） |
| `git commit --amend` | 1 | 重写上一个节点 | ❌（流程守卫拦） |

效果对照：

| 你输入的 message | 入库后 |
|---|---|
| `fix: 修复登录` | `AI fix: 修复登录` |
| `feat: 新增导出` | `AI feat: 新增导出` |
| `docs: 改文档` | `AI docs: 改文档` |
| `chore: 调配置` | `AI chore: 调配置` |
| `Revert "fix: 登录报错"` | `AI Revert "fix: 登录报错"` |
| `AI fix: 已经带了` | `AI fix: 已经带了`（不重复加） |
| `Merge branch 'develop' into main` | 不变 |

> **为什么 `docs:` / `chore:` 也打标**：前缀标记的是「这次提交发生在 AI 增强环境下」，不是「这次改动是不是代码」。
> 文档同样是资产；而且一次提交常常同时含代码和文档，Conventional Commits 的 type 由人主观挑选，
> 拿它去推测「AI 参与度」并不可靠。

> **为什么 revert 打标、merge 不打标**：`git revert` 创建的是单 parent、有自己 tree 和 diff 的普通提交，
> 是一次真实的状态变更，也是 GitFlow 里最需要追溯的一类操作（为什么回滚、回滚了什么）。
> merge commit 在 `--no-ff` 下唯一的"内容"就是它有两个 parent，代表分支整合这个动作，不是新工作。

**merge / rebase / cherry-pick / amend 在提交时一律不改写**——这是流程守卫（步骤①），发生在规则匹配之前，
判据是 git 状态而不是 message 文本。注意 **`git revert` 不在其中**，它走规则链，由兜底规则打标。

---

## 四、使用

### 4.1 开箱即用

插件装好后，什么都不配，直接提交就会按默认规则加 `AI ` 前缀：

```bash
git commit -m "fix: 修复登录超时"     # 入库后变成 "AI fix: 修复登录超时"
```

验证它确实生效：

```bash
fxdevkit logs --plugin plugin-commit-rules --last 10   # 看插件的执行日志
fxdevkit report                                  # 看 commit.rewritten 事件
```

### 4.2 自定义规则（重点）

配置写在 `~/.fxdevkit/config.yaml`（**用户级配置**，跟人走）：

| 位置 | 性质 |
|---|---|
| `~/.fxdevkit/config.yaml` | 用户自定义（跟人走，跨升级保留） |

源码默认（`@fxdevkit/cli` 包内 `DEFAULT_CONFIG`，三条默认规则）会被用户配置整体覆盖。

配置结构如下（完整版）：

```yaml
plugins:
  plugin-commit-rules:
    rules:              # ← 规则数组
      - name: default-guard
        pattern: '^(AI|ai)[:\s]'
        action: skip
      - name: git-merge
        pattern: '^Merge '
        action: skip
      - name: default
        action: prefix
        value: 'AI '
    branches:           # ← 生效分支
      - '*'
    dryRun: false       # ← true = 只预览不改写
```

改完**无需重启**，下次提交立即生效（配置是每次 hook 触发时重新读的）。

### 4.3 用命令配置（推荐）

有两个命令，避免你手写上面那段 YAML。

**先看现在的规则**：

```bash
$ fxdevkit commit rules
生效规则 3 条（来源：插件默认）
 1. default-guard     skip    /^(AI|ai)[:\s]/
 2. git-merge         skip    /^Merge /
 3. default           prefix  "AI "  ← 兜底
branches: *   dryRun: false
手改位置：~/.fxdevkit/config.yaml 的 plugins.plugin-commit-rules.rules
```

**换前缀**（换公司、换标注风格的场景）：

```bash
$ fxdevkit commit prefix "[AI-GEN] "
已写入兜底前缀："[AI-GEN] "
同步维护：
  幂等守卫  default-guard  /^\[AI-GEN\][:\s]*/
  历史放行  legacy-1       /^AI[:\s]*/   ← 旧前缀的提交仍判合规
```

这一条命令替你做三件事，缺任何一件配置都是坏的：

| # | 动作 | 不做会怎样 |
|---|---|---|
| ① | 改兜底规则的 `value` | 前缀不变 |
| ② | 同步改幂等守卫的 `pattern` | 插件拒绝加载：`注入的「[AI-GEN]」无法被任何 skip 规则匹配，会导致重复注入` |
| ③ | 把旧前缀降级成 `legacy-N` 放行规则 | 历史提交在 CI 的 `commit check` 里被判不合规 |

第 ③ 条每次换前缀都会出现——守卫只对应**当前**兜底值，值一换，旧值就没人认了，得留一条放行。反复换：

```bash
$ fxdevkit commit prefix "[COMPANY-X] "
  幂等守卫  default-guard  /^\[COMPANY-X\][:\s]*/
  历史放行  legacy-2       /^\[AI-GEN\][:\s]*/   ← 上一次的前缀
```

`legacy-N` 会累积，这是对的：历史提交里并存过多种前缀，CI 都得放行，别当冗余清理。

> 命令只覆盖「兜底前缀」这一个维度。要加正则规则、改后缀、套模板、只在某分支生效，仍然手写 YAML（见 §五 示例）。

---

## 五、自定义示例（照着改）

### 示例 1：换个前缀，改成 🤖

```yaml
plugins:
  plugin-commit-rules:
    rules:
      - name: default-guard
        pattern: '^(🤖|AI|ai)'        # 必须把新前缀也纳入幂等匹配
        action: skip
      - name: git-merge
        pattern: '^Merge '
        action: skip
      - name: default
        action: prefix
        value: '🤖 '
```

> ⚠️ 关键：改 `value` 后，**必须**同步改 `default-guard` 的 `pattern` 让它能匹配新前缀。否则插件会报「注入的『🤖』无法被任何 skip 规则匹配，会导致重复注入」并拒绝加载（这是幂等守卫在保护你，见 §6.2）。
> 用 `fxdevkit commit prefix "🤖 "` 就不用自己盯这些。

### 示例 2：跳过某类来源的提交（比如自动生成的版本号）

```yaml
plugins:
  plugin-commit-rules:
    rules:
      - name: default-guard
        pattern: '^(AI|ai)[:\s]'
        action: skip
      - name: git-merge
        pattern: '^Merge '
        action: skip
      - name: bot-bump
        pattern: '^\[bot\]'          # CI 机器人打的提交不打标
        action: skip
      - name: default
        action: prefix
        value: 'AI '
```

### 示例 3：改成加后缀

```yaml
plugins:
  plugin-commit-rules:
    rules:
      - name: default-guard
        pattern: '(AI)$'               # 末尾带 AI 的跳过
        action: skip
      - name: git-merge
        pattern: '^Merge '
        action: skip
      - name: default
        action: suffix
        value: ' [AI]'                 # 第一行末尾加 " [AI]"
```

### 示例 4：套模板

```yaml
plugins:
  plugin-commit-rules:
    rules:
      - name: default-guard
        pattern: '^\[AI\]'
        action: skip
      - name: git-merge
        pattern: '^Merge '
        action: skip
      - name: default
        action: template
        value: '[AI] {message}'        # {message} = 原文
```

### 示例 5：只预览，不改写（dryRun）

```yaml
plugins:
  plugin-commit-rules:
    dryRun: true
```

效果：提交不会被改写，但日志会打出 `[dry-run] 将改写为：AI xxx`，方便先看看规则对不对。

### 示例 6：只在特定分支生效

```yaml
plugins:
  plugin-commit-rules:
    branches:
      - 'main'
      - 'release/*'       # 支持通配符
```

不在清单里的分支，提交**不加前缀**（直接放行）。

---

## 六、两个必须知道的语义

### 6.1 「整体替换」，不是「追加」

`rules` 是数组，内核合并配置时**数组整体替换**。也就是说：**你一旦写了 `rules`，默认那 3 条规则就被你写的完全取代了**，不是"在你写的之上再加默认"。

所以要"加一条规则"，正确做法是**把默认 3 条抄过来 + 加你那条**（见示例 2）。

> 这也是 `fxdevkit commit prefix` 存在的原因：它替你读出现有规则再改，不会把默认规则写丢。

### 6.2 幂等守卫：改了注入值，必须同步改 skip 匹配

插件在加载时（`validateConfig`）会做一道**幂等交叉校验**（源码 `assertIdempotent`）：

> 兜底规则注入的 value，必须能被某条 skip 规则的正则匹配到，否则同一条 message 会被二次处理成 `AI AI xxx`。

不满足就**报错并拒绝加载**，错误信息会直接告诉你该怎么补。这是防呆设计，不是 bug。

`fxdevkit commit prefix` 会把这一步一起做掉，手写 YAML 时才需要自己盯。

### 6.3 换前缀会波及历史提交

`commit check` 的判定是「命中 skip 规则 → 通过，落到兜底 → 不合规」。换前缀后，用旧前缀的提交两头都不占，CI 会被判不合规。

所以 `commit prefix` 会自动补一条 `legacy-N` 规则，把旧前缀放行。手写 YAML 换前缀时，记得自己留一条。

---

## 七、验证方法

| 你想确认 | 命令 |
|---|---|
| 当前生效的规则与来源 | `fxdevkit commit rules` |
| 规则是否生效 | `git commit -m "test: xxx"` 后看 message 是否被改写 |
| 只看不改 | 配置 `dryRun: true`，看日志 `[dry-run]` |
| 插件执行日志 | `fxdevkit logs --plugin plugin-commit-rules --last 20` |
| 事件流水 | `fxdevkit report`（看 `commit.rewritten` / `commit.passed` / `commit.guarded`） |
| 校验格式（CI 用） | `fxdevkit commit check --sha HEAD`（不改任何东西，违规返回 1） |
| 配置是否被读到 | `fxdevkit doctor` + `fxdevkit logs --core` |

---

## 八、常见问题

**Q1：`docs:` / `chore:` 也被加了前缀，能跳过吗？**
A：这是预期行为——文档也是资产，前缀标记的是「这次提交发生在 AI 增强环境下」，不是「这次改动是不是代码」。确实要跳过就自己加一条 skip 规则（见示例 2 的写法）。注意 rules 是整体替换，得把默认规则一起抄上。

**Q2：我改了 `value` 后插件报错「会导致重复注入」？**
A：幂等守卫在保护你。用 `fxdevkit commit prefix "<新前缀>"` 一条命令改（它会把守卫和 legacy 一起改），或者手写时同步改 `default-guard` 的 `pattern` 覆盖新值（见示例 1）。

**Q3：merge / rebase 的提交会被改吗？revert 呢？**
A：merge / rebase / cherry-pick / amend 不会——流程守卫（§2.2 步骤①）直接放行，与规则无关。
**revert 会加前缀**：它是单 parent、有自己 diff 的普通提交，是一次真实的状态变更，属于工作单元。

**Q4：配置改了要重启吗？**
A：不用。配置是每次 hook 触发时重新读的，下次提交即生效。

**Q5：我只想调整 plugin-commit-rules 的规则（不影响所有仓库的默认行为）？**
A：用 `fxdevkit commit prefix` 改前缀；更复杂的规则改 `~/.fxdevkit/config.yaml` 里的 `plugins.plugin-commit-rules.rules`（数组字段是整体替换语义，不是追加）。**注意**：fxdevkit 不会在仓库根目录写 `.fxdevkit.yaml`，所有配置都集中在用户目录。

**Q6：`fxdevkit commit prefix` 会不会把我手写的注释弄丢？**
A：会。写回是整份 YAML 重新序列化，注释不保留。命令执行时会打一条 warn 提醒。

---

## 九、代码位置索引

| 你想找 | 位置 |
|---|---|
| 插件全部逻辑 | `src/index.ts` |
| 默认规则 | 同文件 `DEFAULT_CONFIG` |
| 规则校验 + 幂等守卫 | 同文件 `normalizeRules` / `assertIdempotent` |
| 换前缀的三件连带动作 | 同文件 `setFallbackPrefix` |
| commit-msg 处理流程 | 同文件 `hooks['commit-msg']` |
| check 命令 | 同文件 `commands.check` |
| rules / prefix 命令 | 同文件 `commands.rules` / `commands.prefix` |
| 配置写回通道（内核） | `packages/core/src/kernel.ts` 的 `runPluginCommand` → `configStore` |
| 插件声明（manifest） | `package.json` 的 `fxdevkit` 字段 |
| 配置如何注入插件 | `packages/core/src/kernel.ts` |
| 配置如何合并（整体替换语义） | `packages/core/src/config.ts` 的 `deepMerge` / `loadConfig` |

---

> 配套阅读：`../docs/概念词典.md`（术语）→ `../docs/架构设计.md §3`（插件机制）→ `../docs/修改指南.md §1`（怎么加新插件）。
