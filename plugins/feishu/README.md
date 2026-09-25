# plugin-feishu

把「群里 @ 机器人」变成「本机插件能力的一次调用」，再把结果送回原来的群。

> **归属**：[fxDevKit](../../README.md)（[English](../../README_EN.md)）的插件，遵循 MIT 许可。

**当前是 M1**：只负责把链路跑通——长连接、@ 判定、调用者白名单、回复、审计。
内置能力是硬编码的三个（`ping` / `logs` / `help`），能力注册表与 AI 选能力属于 M2。

---

## 一、飞书侧配置（做一次）

> ⚠️ 群里右键添加的「自定义机器人」（webhook 那种）**只能往群里发消息，收不到任何人 @ 它**。
> 要「@ 机器人 → 本机收到」，建的是**企业自建应用**，并且事件接收方式必须选**长连接**。

1. 打开 <https://open.feishu.cn/app> → **创建企业自建应用**
   - 开放平台以「企业 / 团队」为主体。个人试验可以先在飞书里建一个只有你自己的团队，你就是管理员，能自助审批；如果账号已归属某企业，直接用企业的即可（但发布需要管理员审批）。
2. **凭证与基础信息** → 复制 **App ID** 与 **App Secret**
3. **添加应用能力** → 勾选**机器人**
4. **权限管理** → 勾选以下权限：
   - `im:message`（发消息）
   - `im:message:readonly`、`im:message.group_at_msg:readonly`（收到群内 @）
   - `contact:user.base:readonly`（知道是谁在问；不给的话只能拿到一串 open_id）
5. **事件与回调** → 添加事件 **`im.message.receive_v1`**
   - 接收方式选 **「使用长连接接收事件」**。长连接不需要公网 IP，也不用内网穿透——这是「本地监听」能成立的前提。
   - 只切接收方式、不添加事件＝没订阅，一样收不到。两样都要做。
6. **版本管理与发布** → 创建版本 → 申请发布（自己的团队自己就能审批）
   - 权限和事件的改动**保存后不生效，发布之后才生效**。没发布过版本 = 事件不会推，现象就是群里 @ 了、本地毫无动静。

---

## 二、本机配置

### 1. 凭据

**不用手写配置。** 第一次 `fxdevkit feishu serve` 时它会先检查环境变量，没有就带你一步步填。

节奏是**一次只问一件事**：先给 App ID，拿到并校验通过后才讲 App Secret。

```
需要飞书自建应用的凭据。分两步，先拿 App ID。

  1. 打开 → https://open.feishu.cn/app
  2. 点「创建企业自建应用」，随便起个名字（比如 fxdevkit）
  3. 进去后点左侧「凭证与基础信息」
  4. 页面上有个 App ID，右边有复制按钮 → 复制它

把 App ID 粘到这里，回车（直接回车＝放弃）
> cli_a1b2c3d4e5f6g7h8

App ID 记下了：cli_a1b2c3d4e5f6g7h8

再拿 App Secret，就在同一个页面、App ID 下面那一格。
它默认是隐藏的，点「显示」或直接点右边的复制按钮。

把 App Secret 粘到这里，回车（直接回车＝放弃）
> s3cr3t-value

两个都齐了，已存到 C:\Users\you\.fxdevkit\config.yaml
```

抄错会当场纠正，而且**不把脏数据写进配置**：

```
> app_secret_value
这串不像 App ID：app_secret_value
App ID 一定以 cli_ 开头。常见的抄错是复制成了应用名字，
或者复制成了下面那一格 App Secret。回去再看看第 4 步。
```

填完直接连飞书。**连上之后**它才告诉你还需要去开放平台做三件事（权限、事件订阅、发布版本）——
这些属于「启动成功之后」的话题，不该堵在填字段前面。

凭据存进用户配置（跟人走，跨升级保留）。

取值优先级：**环境变量 > 用户配置 > 引导填写**。想要更干净可以用环境变量，跳过引导：

```powershell
$env:FEISHU_APP_ID = 'cli_xxxxxxxx'
$env:FEISHU_APP_SECRET = 'xxxxxxxx'
```

Lark 国际版额外加一句 `$env:FEISHU_DOMAIN = 'lark'`。

改错了想重填：`fxdevkit feishu serve --reset`（或在非交互环境下手改 `~/.fxdevkit/config.yaml`）。

> App Secret 存在配置文件里是**明文**，且上述交互方式会进终端历史。这是本机自用的权衡——介意的话改用环境变量，并到开放平台重置一次 Secret。

### 2. 白名单（`~/.fxdevkit/config.yaml`）

```yaml
plugins:
  plugin-feishu:
    allowOpenIds:
      - ou_xxxxxxxx          # 只有这些人能唤起你的本机
    allowChats: []           # 空 = 不限制群
    ack: true                # 执行前先回一条「收到，正在查…」
    defaultLogLines: 10      # logs 默认条数
```

**强烈建议配 `allowOpenIds`。** 不配的话，任何能把机器人拉进群的人都能唤起你的本机——哪怕他只是 @ 了一句「ping」。

不知道自己的 open_id：先留空启动，给机器人发一条消息，再执行
`fxdevkit logs --plugin plugin-feishu`，日志里会打印调用者的 open_id（被拒绝时也会记）。

---

## 三、启动与停止

```bash
fxdevkit feishu serve            # 前台常驻，Ctrl+C 停止（缺凭据会自动引导填写）
fxdevkit feishu serve --reset    # 重新填一次凭据
```

飞书的长连接是**集群模式、不广播**：同一应用开多个客户端，消息只会随机落到其中一个。
所以插件用 pid 锁保证单实例，重复启动会被拦下并提示旧实例的 pid。

### 看日志

启动后终端会**实时**打印：连接状态、白名单摘要、每条消息的「收到 / 已回复」、每 10 分钟一次的在线心跳。

```bash
fxdevkit logs --plugin plugin-feishu     # 回看历史（落盘在 ~/.fxdevkit/logs/YYYY-MM-DD.log）
FXDEVKIT_DEBUG=1 fxdevkit feishu serve   # 额外打印被忽略的消息（群里 @ 的不是它之类）
```

---

## 四、内置能力（M1）

| 输入 | 返回 |
|---|---|
| `ping` | pong + 插件版本 + 在线时长 + 主机名 |
| `logs [n]` | 最近 n 条调度日志（默认 10，上限 50），跨天回溯 |
| `help` | 能力说明 |
| **其它任意问题** | **转发给本机 codex 回答**（默认 model `gpt-5.6-luna` / 思考 `high`） |

codex 问答的安全设定：`read-only` 沙箱（不改文件）、`--ephemeral`（不留会话）、默认 5 分钟超时、答案超 3500 字截断并注明。
前提是本机 `codex --version` 能跑通（cc switch 配好即可，插件直接找它的 rust 真身 exe 调用）。

codex 相关配置（`~/.fxdevkit/config.yaml`）：

```yaml
plugins:
  plugin-feishu:
    codex:
      model: gpt-5.6-luna   # 想换模型改这里
      effort: high          # minimal / low / medium / high
      timeoutMs: 300000     # 10 秒 ~ 10 分钟
      cwd: ""               # codex 的工作目录，空 = 用户主目录
      systemPrompt: |       # 系统指令；设成空串 = 完全不传
        你是 LA-Bot，飞书群里的助手。
        回答简洁直接，用中文。
```

系统指令走 codex 的 `model_instructions_file`（它**追加**在 codex 自带指令之上，不是替换），
启动时落到 `~/.fxdevkit/plugins/plugin-feishu/codex-instructions.md`。
默认值已经处理了一个坑：不点名的话模型会在群里自称 Codex。改完配置**重启 serve** 生效。

群里要 **@ 机器人** 才会响应；单聊（直接给机器人发消息）不需要 @。

---

## 五、安全边界

- **codex 只读沙箱**：问答走 `read-only`，不改文件；要让它改代码是以后的事，需显式配置
- **不经过 shell**：直接 spawn codex 的 rust exe（Windows 上 .cmd shim 有注入面，绕开）
- **默认只读**：本插件本身不写任何仓库文件；执行外部命令已显式声明 `proc:exec` 权限
- **调用者白名单** + **群白名单**，不在名单内的直接忽略，且不回复（避免被探测）
- **凭据不进仓库**：存在 `~/.fxdevkit/config.yaml`（跟人走），或走环境变量
- **不引入任何写操作**：内核已限定插件的文件访问范围，且本插件没有申请仓库写权限
- 每一次「收到 / 回复 / 拒绝 / 回复失败」都落事件流，可查：`fxdevkit report`、`fxdevkit logs --plugin plugin-feishu`
- **失败不会被当成成功**：没发出去的消息不打「已回复」，而是发 `feishu.reply_failed`——报告里看得见「有人问了但没回应」

---

## 六、已知限制（M1 范围内）

- **必须前台开着**：终端关掉、机器休眠或关机，机器人就离线了。后台运行与开机自启不在 M1 内。
- 只处理**文本消息**，图片 / 文件 / 卡片交互暂不支持。
- 群内靠机器人自身的 open_id 判断「@ 的是不是我」。若启动时没拿到 open_id（权限或网络问题），会降级为「有人被 @ 就响应」——**此时必须有调用者白名单**，否则插件拒绝处理群消息。
- **codex 问答无上下文**：每句话都是一次独立的 `codex exec`，不带群聊历史、不带系统提示词——它不知道之前聊过什么。要上下文是后续的事。
- 收到消息后**立即确认**再异步处理（否则飞书会因确认超时而重推），重推靠 `message_id` 去重兜住（10 分钟窗口）。代价：进程恰好在你提问瞬间崩溃，那条消息会丢——再 @ 一次即可。

---

## 七、排错

| 现象 | 看这里 |
|---|---|
| 启动时问你要 App ID / Secret | 正常——首次用会引导填一次，填完存进 `~/.fxdevkit/config.yaml`，之后不再问 |
| 报「不是交互终端」 | 在真实终端里跑（不是管道 / CI），或改用环境变量提供凭据 |
| 启动报「已有实例在运行」 | 停掉旧实例；确认已退出后删 `~/.fxdevkit/plugins/plugin-feishu/serve.lock` |
| 群里 @ 了没反应 | ① 权限 ② 事件订阅选的是不是长连接 ③ 应用是否已发布 ④ 机器人是否被拉进群 ⑤ 是否真的 @ 了它 ⑥ 调用者是否在白名单 |
| 本地有「收到」但群里没回复 | 缺**发**消息权限（`im:message:send_as_bot`）。终端会给出一键开通链接，开通后要发一版 |
| 权限的坑在哪 | 收消息和发消息在飞书里是**两套权限**，各开各的。收消息缺权 = 事件完全不推（本地零日志，飞书静默过滤，最难排查）；发消息缺权 = 收到不回 |
| 问 codex 的问题一直没回 | 看 `codex --version` 是否可用；超时（默认 5 分钟）会在群里回一句。慢是 reasoning=high 的正常代价，嫌慢把 `codex.effort` 调成 `medium` |
| 想看原始日志 | `fxdevkit logs --plugin plugin-feishu --level debug`（或 `FXDEVKIT_DEBUG=1` 启动） |
