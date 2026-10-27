# ST-bridge

ST-bridge 是供柏宝绘、玉子手机、数据库等酒馆插件调用的本机持久会话桥接：
`http://127.0.0.1:43121/v1`。

> 更新本项目代码后，需要**完全退出并重启 DSH Desktop**才能加载新版本。
> DSH Host 插件不会热替换已经加载的 vendor 代码。
> 重启后 `GET /health` 应显示 `version: "0.4.0"`；若仍是旧版本，说明
> 43121 还是旧进程。

这不是一个直接转发模型 API 的代理，而是一个 **DSH Host 插件**。每个酒馆
`chat_id` 绑定一个真实的 DSH Agent 会话；会话通过 `ctx.agents` 创建，因此会
出现在 DSH 界面中，可以手工打开、继续交流、查看历史。桥接只负责：

- 支持 `dsh_session` v1：固定组/动态组、`generate`/`sync_rules`/`reset`；
- 按 `client_id + chat_id + task_id` 隔离插件、聊天和子任务会话；
- 把首次完整上下文送进新会话；
- 后续只追加新增正文和本轮要求；
- 用 `request_id` 做幂等，避免网络重试重复追加；
- 同一 `chat_id` 的生成请求串行执行；
- 重写旧楼层、swipe、回退剧情时重建分支会话；
- 等 Agent 回合结束，只把最终正文放进 `choices[0].message.content`。

桥接不解析、不包裹、不增加代码围栏，所以柏宝绘的 `images/changes` JSON 会原样返回。

## 目录

| 文件 | 作用 |
| --- | --- |
| `index.js` | DSH 插件入口，读取配置、启动 43121 端口 |
| `lib/engine.js` | 会话创建/恢复、上下文分类、发送、等待、分支、幂等 |
| `lib/context.js` | 消息规范化、前缀 diff、首次/追加/重建提示词 |
| `lib/session-protocol.js` | `dsh_session` 校验、固定规则格式化、稳定 session ID、采样参数 |
| `lib/turn.js` | 从 DSH 事件日志提取最终回答与 usage |
| `lib/store.js` | `chat_id -> session_id` 映射和 `request_id` 记录的持久化 |
| `lib/server.js` | OpenAI 兼容 HTTP/SSE 层 |
| `lib/panel.js` | DSH 设置页 Host RPC、设置持久化、scope/规则/危险操作 |
| `client.js` | DSH 设置页浏览器半边 |
| `install.mjs` | 安装到当前 DSH profile |
| `cordis.patch.yml` | npm/bundle 安装时使用的插件包 patch |
| `cordis.patch.snippet.yml` | 手工安装片段 |
| `assets/preset-persona.txt` | 桥接专用最小系统提示词 |

## 安装

要求：DSH Desktop 已正常运行，Node.js 22.19+。

```bash
cd D:\AIGC\MOSS\ST-bridge
node install.mjs --cwd D:\AIGC\MOSS --port 43121
```

脚本会：

1. 在 `<profile>/node_modules/ST-bridge` 创建指向本目录的链接；
2. 备份并修改 `<profile>/cordis.patch.yml`，追加一个受管配置块；
3. 注册一个只含文本系统提示词的 Agent 预设 `st-bridge`，不加载
   DSH 工具、技能、酒馆人格或运行时上下文。

安装后必须 **完全退出 DSH Desktop**（托盘退出，不是只关窗口），再重新启动。
然后验证：

```bash
curl http://127.0.0.1:43121/health
curl http://127.0.0.1:43121/v1/models
```

预期：

```json
{"object":"list","data":[{"id":"dsh-default","object":"model"}]}
```

卸载：

```bash
node install.mjs --uninstall
```

手工安装可参考 `cordis.patch.snippet.yml`。配置块也可以直接写进
`~/.dsh/profiles/desktop/cordis.patch.yml` 末尾。

## DSH 设置面板

重启后，DSH「设置」里会出现「ST-bridge」页，包含：

- **服务**：启停、host/port、Bearer token、CORS、`allowLegacyPlain`、
  请求超时、请求体上限。host/port 修改后点「保存并重启」。
- **模型**：provider/model（留空跟随 DSH 当前默认；要填就同时填）、Agent 预设、
  cwd、默认 `max_tokens`。修改只影响新创建/重新恢复的会话。`reasoning_effort`
  只在模型支持该档位时传递；不支持会自动忽略，不会让整个回合报错。
- **客户端**：按 `client_id + chat_id + task_id` 列出绑定，支持筛选、允许
  client_id 列表、查看当前固定规则、清除规则、重置绑定。重置不删除 DSH
  会话历史。
- **诊断**：运行状态、scope/会话数、capabilities、日志路径与最近日志。
- **危险操作**：停止/启动/重启桥接、清空全部绑定。清空需要输入 `RESET`；
  停止前会二次确认。
- **高级**：直接编辑 `settings.json` 对应的 JSON；不展示真实 token。

设置保存到 `~/.dsh/st-bridge/settings.json`（权限 0600）。界面里的
token 输入框留空表示保持现有 token；点「清除」才会移除。

## 分发与其他电脑

这是一个 **DSH Host + Client 插件**，不是脱离 DSH 的独立服务。换电脑时整目录复制，
目标机器必须有兼容的 DSH Desktop/Host、Node.js 22.19+、已配置的模型账号。

安装有两种方式，**二选一**：

1. **本地链接安装**（当前 `install.mjs`）：创建 `<profile>/node_modules/ST-bridge`
   链接，并把 preset/plugin 行写进 `<profile>/cordis.patch.yml`。
2. **包/bundle 安装**：把本包加入 profile 的 `dsh.profile.bundles`，或通过
   `dsh plugin --profile <name> add <本包>` 安装；`package.json` 已声明
   `dsh.bundle.patch`，`cordis.patch.yml` 会插入同样的 preset/plugin 行。

两种方式不要同时做，否则会出现重复的 `st-bridge` 行。
`install.mjs` 检测到 profile 已把本包列为 dependency/bundle 时会直接停止，避免重复插入。

换机器时：

```bash
cd <本目录>
node install.mjs --cwd <目标工作区> --port 43121 --profile desktop
```

- Windows 用 junction，macOS/Linux 用符号链接。
- 目标机器需重新配置模型通道/API Key；本仓库不携带任何密钥或聊天内容。
- `state.json` 是本机 `chat_id -> session_id` 映射，不建议跨机直接复用；新机器首次
  请求会返回 410 并重新初始化。
- 默认只监听 `127.0.0.1`。其他电脑要调用，需要在面板开启 `allowRemote`、设置
  token、放行防火墙，并把客户端 Base URL 改成目标机地址。
- 当前按 DSH `0.2.1-rc.2` 的 service/slot API 实现；DSH 大版本升级后若
  `settings.section`、`connection.rpc` 等改名，需要适配。

## 柏宝绘 dsh_session v1（推荐）

请求仍是普通 OpenAI 非流式 JSON，额外在顶层带一个 `dsh_session` 对象。
DSH 用 `fixed_message_count` / `fixed_message_types` 把 `messages` 切成
「固定组」和「动态组」，固定组按用途保存为该会话的最新规则。

```json
{
  "model": "dsh-default",
  "stream": false,
  "temperature": 0.6,
  "max_tokens": 8192,
  "messages": [
    {"role":"system","content":"固定前缀"},
    {"role":"system","content":"生图提示词规范及版式清单"},
    {"role":"system","content":"宿主输出协议"},
    {"role":"system","content":"输出前检查指导"},
    {"role":"user","content":"本次角色库、上下文、目标正文与任务"}
  ],
  "dsh_session": {
    "protocol_version": 1,
    "client_id": "baibai-image",
    "chat_id": "opaque-plugin-chat-identity",
    "task_id": "default",
    "request_id": "9d55d2dfce15d5210fd95890c973c039a",
    "action": "generate",
    "fixed_message_count": 4,
    "fixed_message_types": ["prefix","spec","contract","check"],
    "target": {"floor":12,"swipe_id":0,"revision":"opaque-target-revision"}
  }
}
```

### 字段

| 字段 | 含义 |
| --- | --- |
| `protocol_version` | 固定整数 `1` |
| `client_id` | 可选插件身份，例如 `baibai-image`、`yuzi-phone`、`shujuku`；缺省按旧柏宝绘处理 |
| `chat_id` | 插件生成的不透明聊天标识；不能只用角色显示名 |
| `task_id` | 可选子任务标识，缺省 `default`；不是每轮随机 ID |
| `session_id` | 首次没有；后续由桥接返回并携带 |
| `request_id` | 单次操作 ID；网络重试必须复用，桥接做幂等 |
| `action` | `generate` / `sync_rules` / `reset` |
| `fixed_message_count` | `messages` 开头多少条属于固定组 |
| `fixed_message_types` | 与固定组逐条对应：`prefix`、`spec`、`contract`、`check` |
| `target` | 仅生成时携带的元数据；桥接只记录，不放进正文 |

如果客户端只能填静态 YAML body、无法生成 `request_id`，可以省略它；桥接会用
`chat_id + action + messages` 的 SHA-256 自动生成 `auto-...`。相同 body 重试仍然
幂等，适合数据库这类固定预设：

```yaml
dsh_session:
  protocol_version: 1
  client_id: shujuku
  chat_id: shujuku-db
  task_id: database
  action: generate
  fixed_message_count: 0
  fixed_message_types: []
```

注意：`chat_id` 写死意味着所有数据库调用共用一个持久会话。需要按酒馆聊天隔离时，
必须让客户端把 `chat_id` 换成动态值，而不是写死。

同一 `chat_id` 的后续请求即使不传 `session_id`，也会复用已绑定的会话；只有固定组
内容变化，或旧会话返回 410 时，才会重建。这样静态 YAML 预设不会每次调用都新开
一个 DSH 聊天。

`client_id` / `task_id` 也可放在顶层 `body.client_id` / `body.task_id` 或
`x-client-id` / `x-task-id` 头；`chat_id` / `request_id` 仍支持顶层与请求头
兼容写法。

`fixed_message_count` 可以为 0；未配置某类规则时，固定组可以少于四条，
`fixed_message_types` 必须与固定组一一对应。动态组可以包含多条 `system`
（角色卡、世界书）和多条 `user`（角色库、记忆、上下文、目标正文）。

### 多插件与子任务隔离

会话索引是 `(client_id, chat_id, task_id)` 的组合（服务端用 SHA-256 规范化，
不把组合键截断后当唯一身份）。不同插件或不同 `task_id` 即使 `chat_id`
相同，也会得到不同 DSH 会话；`generate` / `sync_rules` / `reset` 都只作用于
当前范围。

- `client_id` 缺省：按旧柏宝绘的 `chat_id` 绑定查找，旧 `session_id` 继续有效。
- 显式 `client_id: "baibai-image"` + `task_id: "default"`：同样复用旧绑定。
- 其它 `client_id` 或非默认 `task_id`：使用独立的新范围，不会静默迁移旧会话。
- 界面标题使用可读插件名（柏宝绘 / 玉子手机 / 数据库）与聊天名；非默认
  `task_id` 也会出现在标题里。

已知客户端标识：`baibai-image`、`yuzi-phone`、`shujuku`；其它稳定标识也接受。
`chat_id` / `task_id` 只作为不透明数据，不作为磁盘路径。

客户端接入要点：

- **柏宝绘**：`client_id: "baibai-image"`，继续使用固定组；
  旧请求不带 `client_id` 时仍命中旧绑定。
- **玉子手机**：`client_id: "yuzi-phone"`，建议用 `task_id` 区分 QQ 私聊/
  群聊/主动周期；手动与主动请求都要带同一个聊天身份。
- **数据库**：`client_id: "shujuku"`，数据库自身身份独立。
- **玉子手机借用数据库 callAI**：出口仍须保持 `yuzi-phone`，不能到 transport
  再改身份。
- **新插件**：使用稳定 `client_id`；无法判断固定规则用途时用
  `fixed_message_count: 0`，每轮发送完整任务材料。
- 浏览器侧需通过酒馆 `custom source` 的 `custom_include_body` 透传
  `dsh_session`；普通 `openai` source 可能在代理层丢掉扩展字段。

### 三种 action

**generate（首次）**

没有 `session_id`：创建独立、可在 DSH 中查看的 Agent 会话，保存固定组，
并用本次动态组执行一次生成。返回 `dsh_session.session_id`。

**generate（后续）**

携带 `session_id`，`fixed_message_count: 0`、`fixed_message_types: []`，
`messages` 只有动态组。桥接在同一会话内继续执行，固定规则由该会话的
系统段自动注入，不需要插件重复传输。

固定组不会作为可见 user 消息重复塞进会话；DSH 把它保存为当前会话的
「最新确认版固定规则」系统段，每次生成自动带上。这样既减少重复传输，
也保证后续轮次继续生效。

动态组开头的 `system` 消息（角色卡、世界书等）同样作为「本轮动态系统资料」
注入 system 段，不挤进 user 正文；动态组其余消息保持原顺序和 role 标记。

**sync_rules**

`messages` 只有固定组，`fixed_message_count === messages.length`。
有 `session_id` 就更新该会话；没有就创建并绑定一个空会话。
该操作**不执行模型生成**，返回 `choices: []`，也不发回上一轮图片规划。
固定规则按 type 整组替换，不会让旧规范和新规范并列生效。

**reset**

`messages` 为空，`fixed_message_count: 0`，`fixed_message_types: []`。
创建新的空 Agent 会话并返回新的 `session_id`；旧会话保留在 DSH 历史中。
下次 `generate` 携带固定组和动态组重新初始化。

### 响应

生成成功：

```json
{
  "id":"chatcmpl-example",
  "object":"chat.completion",
  "choices":[{"index":0,"message":{"role":"assistant","content":"Agent 最终回复字符串"},"finish_reason":"stop"}],
  "dsh_session":{
    "client_id":"baibai-image",
    "chat_id":"stable-tavern-chat-identity",
    "task_id":"default",
    "session_id":"session-st-..."
  },
  "bridge":{"client_id":"baibai-image","chat_id":"stable-tavern-chat-identity","task_id":"default","session_id":"session-st-..."},
  "usage":{"prompt_tokens":10000,"completion_tokens":1200,"prompt_tokens_details":{"cached_tokens":8000}}
}
```

控制操作成功：

```json
{
  "choices":[],
  "dsh_session":{"client_id":"baibai-image","chat_id":"...","task_id":"default","session_id":"session-st-..."}
}
```

`sync_rules` 和 `reset` 只有在会话状态真正落实后才返回成功。`usage` 只在
真实模型调用产生时出现；控制操作没有 usage。

### 文本能力与工具模式

首版只支持纯文本、JSON 字符串和填表文本指令。以下输入明确返回
`400 unsupported_tool_mode`，不会静默删除或伪装成功：

- 非空 `tools` / `functions`；
- `role: "tool"` 或 `role: "function"` 的消息；
- 消息里的非空 `tool_calls` / `function_call`；
- 要求实际工具调用的 `tool_choice` / `function_call` 参数。

`response_format: {"type":"json_schema",...}` 这种严格结构约束返回
`400 unsupported_response_format`；`json_object` 可以按普通文本处理，但桥接
不承诺严格 schema 采样。DSH Agent 内部自用工具与调用端 OpenAI 工具协议不是
同一件事。

### 能力探测

```http
GET /v1/bridge/capabilities
```

返回协议版本、范围键、控制操作、文本/工具/严格 JSON/流式能力，不创建会话。
连接测试不应调用 `generate`，避免留下正式任务会话。

```json
{
  "object": "bridge.capabilities",
  "protocol_versions": [1],
  "scope_keys": ["client_id", "chat_id", "task_id"],
  "control_actions": ["generate", "sync_rules", "reset"],
  "input_modes": ["text", "json", "form_text"],
  "tool_calls": false,
  "strict_json": false,
  "streaming": false
}
```

### 重试、隔离与 410

- 同一范围下的同一 `request_id` 只执行/追加一次；重复请求返回同一结果。
- 首次生成、`sync_rules` 创建、`reset` 使用由
  `client_id + chat_id + task_id + request_id` 派生的稳定 session ID；
  进程崩溃后重试会续用同一会话，而不是再建一个。
- 不同范围（插件 / 聊天 / 子任务）严格隔离；`session_id` 不属于当前范围时
  返回 `410 session_gone`。
- 未知/失效的 `session_id` 也返回 `410`；插件清除本地绑定后重新发送固定组。
- 同一范围的请求串行处理；跨标签页并发也会排队。
- `stream: true` 在本协议下被忽略，始终返回非流式 JSON。
- `target` 只作为元数据保存，不作为正文、画面内容或提示词注入。

## 普通 OpenAI 兼容模式（旧版/备用，默认关闭）

不传 `dsh_session` 时，默认返回 `400 persistent_protocol_required`，避免一次
健康检查/测试请求在 DSH 里创建一个正式持久会话。确实需要旧模式时，在桥接
配置中显式设置 `allowLegacyPlain: true`；启用后按普通 OpenAI 消息模式处理，
每次生成请求必须带两个稳定标识：

| 字段 | 含义 | 可放位置 |
| --- | --- | --- |
| `chat_id` | 酒馆聊天 ID，稳定不变 | `body.chat_id`、`body.chatId`、`body.metadata.chat_id`、`x-chat-id` |
| `request_id` | 本轮请求 ID，重试时不变 | `body.request_id`、`body.requestId`、`body.metadata.request_id`、`x-request-id`、`Idempotency-Key` |

同一 `chat_id` 的请求会串行处理。不同 `chat_id` 可以并行，互不串台。

### 首次请求

把完整规范、角色资料、世界书、已有上下文和目标正文按顺序放进 `messages`：

```bash
curl -s http://127.0.0.1:43121/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "dsh-default",
    "chat_id": "tavern-chat-001",
    "request_id": "turn-0001",
    "messages": [
      {"role": "system", "content": "完整规范/世界书/角色资料"},
      {"role": "user", "content": "已有剧情上下文"},
      {"role": "assistant", "content": "上一段正文"},
      {"role": "user", "content": "本轮目标正文"}
    ],
    "temperature": 0.6,
    "max_tokens": 8192,
    "stream": false
  }'
```

桥接会创建 DSH 会话，发送完整上下文，并在成功后把最终回答写入
`choices[0].message.content`。

### 后续请求

推荐继续发送 **完整 messages 历史**（OpenAI 常见做法），桥接会自动只追加
上次已发送内容之后的新增部分：

```json
{
  "chat_id": "tavern-chat-001",
  "request_id": "turn-0002",
  "messages": [
    {"role": "system", "content": "完整规范/世界书/角色资料"},
    {"role": "user", "content": "已有剧情上下文"},
    {"role": "assistant", "content": "上一段正文"},
    {"role": "user", "content": "本轮目标正文"},
    {"role": "assistant", "content": "桥接上一轮返回的正文"},
    {"role": "user", "content": "本轮新增正文"}
  ]
}
```

也可以只发送新增内容，桥接会把无 `system` 的 messages 当作增量：

```json
{
  "chat_id": "tavern-chat-001",
  "request_id": "turn-0003",
  "messages": [{"role": "user", "content": "只发本轮新增正文"}]
}
```

如果只发增量，建议显式加 `"context_mode": "delta"`，避免客户端某些特殊格式被误判。

### 调参

- `temperature`、`top_p` 等采样参数当前版本不会透传到 DSH Agent（安全忽略）。
- `max_tokens` 会作为 `agentOptions.maxTokens` 传给新会话/恢复的会话。
- `stream: true` 会返回 OpenAI 风格 SSE，但内容在 Agent 完成整轮后一次性发出；
  不是逐 token 流。
- 其他未知字段安全忽略。

## API

### `GET /v1/models`

固定返回：

```json
{
  "object": "list",
  "data": [{"id": "dsh-default", "object": "model"}]
}
```

`dsh-default` 映射到 DSH 当前选择的模型通道；如果桥接配置里写了
`provider`/`model`，则使用配置值。

### `POST /v1/chat/completions`

请求体：

```json
{
  "model": "dsh-default",
  "chat_id": "tavern-chat-001",
  "request_id": "turn-0001",
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ],
  "context_mode": "auto",
  "max_tokens": 8192,
  "stream": false
}
```

`context_mode`：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 完整历史做前缀 diff；无 `system` 的列表优先按增量处理 |
| `full` | 强制按完整历史 diff；重写/回退会触发重建 |
| `delta` | 强制把 messages 全部当新增内容追加 |
| `branch` | 强制重建分支会话，用本次 messages 作为新分支完整上下文 |

成功响应：

```json
{
  "id": "chatcmpl-turn-0001",
  "object": "chat.completion",
  "created": 1793054822,
  "model": "dsh-default",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "最终正文或 images/changes JSON"},
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 1234,
    "completion_tokens": 567,
    "prompt_cache_hit_tokens": 100
  },
  "bridge": {
    "chat_id": "tavern-chat-001",
    "session_id": "session-...",
    "turn": 12,
    "idempotent": false,
    "branch": false
  }
}
```

`usage` 只在 DSH/上游真实提供时出现。缺失的字段直接省略，不伪造成 0。
缓存命中可能是 `prompt_cache_hit_tokens`，也可能是
`prompt_tokens_details.cached_tokens`，两者都按上游原样透传。

流式响应：

```bash
curl -N http://127.0.0.1:43121/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "chat_id": "c1",
    "request_id": "r1",
    "stream": true,
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

返回标准 `data: {...}` 分片，最后 `data: [DONE]`。若
`stream_options.include_usage` 为 true，会在结束前发一个 usage 分片。

### `POST /v1/bridge/reset`

重置某个聊天的绑定。旧 DSH 会话保留在历史里，不会被删除；下一次请求创建新会话。

```bash
curl -s http://127.0.0.1:43121/v1/bridge/reset \
  -H 'content-type: application/json' \
  -d '{"chat_id":"tavern-chat-001"}'
```

当前聊天还有请求未结束时返回 `409 chat_busy`。

### `GET /v1/bridge/status?chat_id=...`

查看绑定、会话 ID、模型、预设、已记录消息数、历史分支。

### `GET /health`

健康检查，返回服务名、版本、端口、启动时长。

## 行为细节

### 首次 vs 后续

- 首次请求：`messages` 全部进入新会话。最后一条是 `user` 时，它被放到
  `<st_bridge_current_request>`；其他消息按原顺序放进
  `<st_bridge_context>`。
- 后续请求：如果完整历史是已记录历史的严格扩展，只把新增的
  `user`/`system` 消息发进同一会话；已发送过的内容不会重复追加。
- 单条新增 `user` 消息会原样发送，不加包装，尽量保持柏宝绘的原文和格式。

### request_id 幂等

- 同一 `chat_id` + 同一 `request_id` + 相同 messages：直接返回上一次结果，
  不新增消息、不重复调用模型。
- 同一 `request_id` 但 messages 不同：`409 request_id_conflict`。
- 同一 `request_id` 正在处理：等待同一个 Promise；跨进程重启用会话日志尝试恢复。
- 失败请求会缓存错误；如需重试，请换新的 `request_id`。

### 分支/重建

以下情况会创建 **新的 DSH 会话**，旧会话保留：

- 旧楼层被改写（messages 与已记录历史在中间分叉）；
- 回退剧情（messages 变短）；
- swipe/重新生成（相同或截断的上下文，没有新增用户内容）；
- 固定规范、世界书、角色资料变化；
- 原会话无法恢复且本次带完整上下文。

新会话会重新接收完整上下文，避免旧场景污染新分支。分支关系记录在
`previous_sessions` 中。当前版本采用“重建”而不是 DSH 原生 fork；这满足
“从对应位置分支或重建会话”的要求，也最容易保证干净。

### 串行

同一 `chat_id` 的请求进入单条 Promise 队列；上一轮完成后才开始下一轮。
不同 `chat_id` 各自独立队列。

### 最终回答

只取本轮最后一条不含 `tool-call` 的 `assistant/message`。工具调用步骤、进度
提示、内部思考不会混进最终回答。回答原样返回，不解析 JSON，不加代码围栏。

### DSH 界面继续交流

会话是普通 DSH 会话，会挂到 `cwd` 对应的 MOSS 工作区。你可以在 DSH 里打开
它继续聊天。桥接的增量 diff 只跟踪柏宝绘发来的消息，不跟踪你在 DSH 界面
手工输入的消息；但那些消息已经在同一个会话里，后续桥接追加时 Agent 仍能
看到它们。只有在触发分支/重建时，才会只使用柏宝绘提供的上下文。

## 配置

安装脚本写入的配置块：

```yaml
- id: st-bridge
  name: ST-bridge
  config:
    host: '127.0.0.1'
    port: 43121
    cwd: 'D:\AIGC\MOSS'
    agentPreset: st-bridge
    requestTimeoutMs: 1800000
    maxBodyBytes: 33554432
```

可选字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `provider` / `model` | 空 | 空表示使用 DSH 当前默认模型选择 |
| `maxTokens` | 空 | 默认输出上限；请求里的 `max_tokens` 优先 |
| `agentPreset` | `st-bridge` | Agent 预设 ID |
| `authToken` | 空 | 设置后要求 `Authorization: Bearer` 或 `x-api-key` |
| `corsOrigins` | 未设置 | 额外允许的 Origin；默认允许本机与浏览器扩展 |
| `allowRemote` | false | 允许绑定非 127.0.0.1 地址，不建议 |
| `allowLegacyPlain` | false | 允许不带 `dsh_session` 的旧式普通补全；会创建持久会话 |
| `allowedClientIds` | `[]` | 非空时只允许列表中的 `client_id`；留空允许所有 |
| `stateDir` | `~/.dsh/st-bridge` | 映射和日志目录 |

状态文件：`~/.dsh/st-bridge/state.json`。日志：
`~/.dsh/st-bridge/bridge.log`。

## 错误

所有错误都是：

```json
{"error":{"message":"具体原因"}}
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `missing_chat_id` / `missing_request_id` | 缺少稳定标识 |
| 400 | `model_not_found` | 只支持 `dsh-default`（或配置的模型 ID） |
| 400 | `unsupported_content` | 消息含非文本片段，拒绝静默丢弃 |
| 400 | `persistent_protocol_required` | 未带 `dsh_session` 且未开启旧模式 |
| 400 | `invalid_client_id` / `invalid_task_id` | 插件身份或子任务标识不合法 |
| 400 | `unsupported_tool_mode` | 调用了原生工具协议 |
| 400 | `unsupported_response_format` | 请求了严格 JSON schema 约束 |
| 400 | `unsupported_reasoning_effort` | 模型不支持该思考强度；桥接会按模型能力过滤 |
| 400 | `invalid_fixed_count` / `fixed_types_mismatch` / `invalid_fixed_type` | 固定组字段不合法 |
| 400 | `reset_messages_not_empty` / `empty_dynamic_group` / `missing_user_message` | action 与 messages 不匹配 |
| 401 | `unauthorized` | 配置了 token 但请求未带/带错 |
| 403 | `origin_forbidden` | 浏览器 Origin 不在白名单 |
| 403 | `client_not_allowed` | `client_id` 不在面板允许列表中 |
| 409 | `request_id_conflict` | 同一 ID 对应不同请求内容 |
| 409 | `request_in_progress` | 该 ID 仍在处理，且无法从日志恢复 |
| 409 | `duplicate_context` | 没有新增内容 |
| 409 | `session_unavailable` | 会话恢复失败且本次只有增量 |
| 410 | `session_gone` | 会话未知、失效或不属于该 chat_id；插件应清绑定并重新初始化 |
| 413 | `context_length_exceeded` | 上下文超出模型限制 |
| 413 | `body_too_large` | 请求体超过上限 |
| 502 | `agent_turn_error` | Agent 回合失败 |
| 502 | `upstream_account_error` | 账号/额度异常 |
| 502 | `empty_answer` | 回合结束但没有最终正文 |
| 504 | `timeout` | 超过 `requestTimeoutMs` |

## 安全

- 默认只绑定 `127.0.0.1`。
- 默认允许本机页面和浏览器扩展 Origin；其他网页 Origin 返回 403。
- 如果本机还有其他用户或不可信页面，请设置 `authToken`。
- 桥接会让本机调用方使用你的 DSH 模型账号并可能产生费用。

## 发布到 GitHub

本目录已经初始化为本地 Git 仓库，当前分支 `main`，**未配置 remote**，也没有执行推送。
创建好 GitHub 仓库后：

```bash
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
git push --tags
```

当前首次提交的作者是占位身份 `ST-bridge`。如需改成你自己的身份：

```bash
git config user.name "Your Name"
git config user.email "you@example.com"
git commit --amend --reset-author
```

仓库里不要提交 `settings.json`、`state.json`、`*.log`；`.gitignore` 已排除。

## 测试

```bash
cd D:\AIGC\MOSS\ST-bridge
npm test
```

测试覆盖：`dsh_session` 的 generate/sync_rules/reset、固定组注入、多插件/子任务
scope 隔离、旧绑定兼容、工具模式拒绝、capabilities、410、request_id 幂等、
串行、usage 透传；设置面板的设置校验、持久化、token 不回显、危险操作确认；
以及旧模式的 messages 顺序、多 system、前缀 diff、增量/分支/回退、SSE、
工具调用过滤。
