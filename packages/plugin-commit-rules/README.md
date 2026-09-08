# commit-rules 插件：工作原理与使用

> 第一个插件。挂在 `git commit` 背后，按**可配置规则**自动改写或校验提交信息。
> 对应源码：`src/index.ts`
> 最后更新：2026-09-08

> **本文档定位**：面向 fxDevKit 的**使用者与贡献者**，讲解插件的工作原理、默认规则与自定义方法。它**不是**本包发布到 npm 时的对外说明（对外 API 文档届时另写）。

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
  "id": "commit-rules",
  "name": "commit",
  "hooks": ["commit-msg"],        // ← 监听这个 hook
  "commands": ["check"],          // ← 提供 fxdevkit commit check 命令
  "permissions": ["events:write", "git:read", "fs:repo", "proc:exec"]
}
```

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
  - name: ai-explicit
    pattern: '^(AI|ai)[:\s]'              # 已带 AI/ai 前缀 → 跳过（幂等）
    action: skip
  - name: no-ai
    pattern: '^(chore|docs|merge|revert)[:\s]'   # 这四类 → 跳过
    action: skip
  - name: default
    action: prefix                          # 兜底 → 加 "AI " 前缀
    value: 'AI '
branches:
  - '*'                                    # 全部分支生效
dryRun: false                              # 真正改写
```

效果对照：

| 你输入的 message | 入库后 |
|---|---|
| `fix: 修复登录` | `AI fix: 修复登录` |
| `feat: 新增导出` | `AI feat: 新增导出` |
| `AI fix: 已经带了` | `AI fix: 已经带了`（不重复加） |
| `chore: 调配置` | `chore: 调配置`（命中 no-ai，跳过） |
| `docs: 改文档` | `docs: 改文档`（命中 no-ai，跳过） |

> ⚠️ **注意**：`docs:` / `chore:` 不加 `AI ` 前缀是**默认规则的预期行为**（`no-ai` 那条），不是 bug。要不要保留这个默认，见第六节「整体替换语义」。

**merge / rebase / cherry-pick / amend 的提交一律不改写**——这是流程守卫（步骤①），与规则无关，目的是避免污染「AI 参与」的统计口径。

---

## 四、使用

### 4.1 开箱即用

插件装好后，什么都不配，直接提交就会按默认规则加 `AI ` 前缀：

```bash
git commit -m "fix: 修复登录超时"     # 入库后变成 "AI fix: 修复登录超时"
```

验证它确实生效：

```bash
fxdevkit logs --plugin commit-rules --last 10   # 看插件的执行日志
fxdevkit report                                  # 看 commit.rewritten 事件
```

### 4.2 自定义规则（重点）

配置写在**两处之一**（内核自动合并，仓库覆盖全局）：

| 位置 | 文件 | 生效范围 |
|---|---|---|
| 全局 | `~/.fxdevkit/config.yaml` | 所有仓库 |
| 仓库 | `<仓库>/.fxdevkit.yaml` | 仅该仓库 |

配置结构如下（完整版）：

```yaml
plugins:
  commit-rules:
    rules:              # ← 规则数组
      - name: ai-explicit
        pattern: '^(AI|ai)[:\s]'
        action: skip
      - name: no-ai
        pattern: '^(chore|docs|merge|revert)[:\s]'
        action: skip
      - name: default
        action: prefix
        value: 'AI '
    branches:           # ← 生效分支
      - '*'
    dryRun: false       # ← true = 只预览不改写
```

改完**无需重启**，下次提交立即生效（配置是每次 hook 触发时重新读的）。

---

## 五、自定义示例（照着改）

### 示例 1：换个前缀，改成 🤖

```yaml
plugins:
  commit-rules:
    rules:
      - name: ai-explicit
        pattern: '^(🤖|AI|ai)'        # 必须把新前缀也纳入幂等匹配
        action: skip
      - name: no-ai
        pattern: '^(chore|docs|merge|revert)[:\s]'
        action: skip
      - name: default
        action: prefix
        value: '🤖 '
```

> ⚠️ 关键：改 `value` 后，**必须**同步改 `ai-explicit` 的 `pattern` 让它能匹配新前缀。否则插件会报「注入的『🤖』无法被任何 skip 规则匹配，会导致重复注入」并拒绝加载（这是幂等守卫在保护你，见 §7）。

### 示例 2：多跳过一个类型（perf 也不加）

```yaml
plugins:
  commit-rules:
    rules:
      - name: ai-explicit
        pattern: '^(AI|ai)[:\s]'
        action: skip
      - name: no-ai
        pattern: '^(chore|docs|merge|revert|perf)[:\s]'   # 加了个 perf
        action: skip
      - name: default
        action: prefix
        value: 'AI '
```

### 示例 3：改成加后缀

```yaml
plugins:
  commit-rules:
    rules:
      - name: ai-explicit
        pattern: '(AI)$'               # 末尾带 AI 的跳过
        action: skip
      - name: no-ai
        pattern: '^(chore|docs|merge|revert)[:\s]'
        action: skip
      - name: default
        action: suffix
        value: ' [AI]'                 # 第一行末尾加 " [AI]"
```

### 示例 4：套模板

```yaml
plugins:
  commit-rules:
    rules:
      - name: ai-explicit
        pattern: '^\[AI\]'
        action: skip
      - name: default
        action: template
        value: '[AI] {message}'        # {message} = 原文
```

### 示例 5：只预览，不改写（dryRun）

```yaml
plugins:
  commit-rules:
    dryRun: true
```

效果：提交不会被改写，但日志会打出 `[dry-run] 将改写为：AI xxx`，方便先看看规则对不对。

### 示例 6：只在特定分支生效

```yaml
plugins:
  commit-rules:
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

### 6.2 幂等守卫：改了注入值，必须同步改 skip 匹配

插件在加载时（`validateConfig`）会做一道**幂等交叉校验**（源码 `assertIdempotent`）：

> 兜底规则注入的 value，必须能被某条 skip 规则的正则匹配到，否则同一条 message 会被二次处理成 `AI AI xxx`。

不满足就**报错并拒绝加载**，错误信息会直接告诉你该怎么补。这是防呆设计，不是 bug。

---

## 七、验证方法

| 你想确认 | 命令 |
|---|---|
| 规则是否生效 | `git commit -m "test: xxx"` 后看 message 是否被改写 |
| 只看不改 | 配置 `dryRun: true`，看日志 `[dry-run]` |
| 插件执行日志 | `fxdevkit logs --plugin commit-rules --last 20` |
| 事件流水 | `fxdevkit report`（看 `commit.rewritten` / `commit.passed` / `commit.guarded`） |
| 校验格式（CI 用） | `fxdevkit commit check --sha HEAD`（不改任何东西，违规返回 1） |
| 配置是否被读到 | `fxdevkit doctor` + `fxdevkit logs --core` |

---

## 八、常见问题

**Q1：`docs:` 提交怎么没加 `AI ` 前缀？**
A：默认规则 `no-ai` 跳过了 `chore|docs|merge|revert`。想让它加，就把 `docs` 从那条 pattern 里删掉（或整体自定义 rules）。

**Q2：我改了 `value` 后插件报错「会导致重复注入」？**
A：幂等守卫在保护你。改 `value` 时同步改 `ai-explicit` 的 pattern 覆盖新值即可（见示例 1）。

**Q3：merge / rebase 的提交会被改吗？**
A：不会。流程守卫（§2.2 步骤①）直接放行，与规则无关。

**Q4：配置改了要重启吗？**
A：不用。配置是每次 hook 触发时重新读的，下次提交即生效。

**Q5：我只想改某一个仓库的规则，不影响其他仓库？**
A：把配置写进**那个仓库的** `<仓库>/.fxdevkit.yaml`（仓库配置覆盖全局）。

---

## 九、代码位置索引

| 你想找 | 位置 |
|---|---|
| 插件全部逻辑 | `src/index.ts` |
| 默认规则 | 同文件 `DEFAULT_CONFIG` |
| 规则校验 + 幂等守卫 | 同文件 `normalizeRules` / `assertIdempotent` |
| commit-msg 处理流程 | 同文件 `hooks['commit-msg']` |
| check 命令 | 同文件 `commands.check` |
| 插件声明（manifest） | `package.json` 的 `fxdevkit` 字段 |
| 配置如何注入插件 | `packages/core/src/kernel.ts` |
| 配置如何合并（整体替换语义） | `packages/core/src/config.ts` 的 `deepMerge` / `loadConfig` |

---

> 配套阅读：`../docs/概念词典.md`（术语）→ `../docs/架构设计.md §3`（插件机制）→ `../docs/修改指南.md §1`（怎么加新插件）。
