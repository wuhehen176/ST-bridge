# 本机上下文适配 · 第一版

这是一套独立酒馆扩展与桥接功能。它只匹配设置中的本机 ST-bridge 地址，
不改变其他 API、酒馆正文、世界书原件或数据库记录。

第一版提供来源标记、保留清单预览和手动规则档位。统一在发送副本剔除历史
`<bbi_image>…</bbi_image>`，其中的旧提示词与 Layout JSON 一并移除；其余材料
仍为 keep-all，不按语义删世界书、不摘要旧正文、不猜测哪些表格无用。
默认完整兼容档不改变规则。

## 固定预设分离（桥接 0.6.1）

酒馆插件每轮都会把整段固定预设重新送来。桥接可以把它识别为**受管固定预设**，
只在固定区保留一份有效副本，动态区不再重复追加。默认关闭，必须手动确认边界。

支持两种确认方式，均按 `client_id + task_id` 绑定：

- `exact`：登记固定预设消息的 sha256（含 role）；请求中必须连续出现且顺序一致。
- `marker`：登记一对起止标记，必须唯一、闭合，且位于 system 消息内。

行为约束：

- 未识别、部分匹配、多重匹配、边界越出动态 system 区、role 不是 system：
  一律**完整保留**并给出诊断，不删除、不改写。
- 首次安装与版本变化的那一轮仍然发送完整副本；只有该轮产生最终回答后才记录
  “已安装”。Hash 或 session 变化会重新安装。
- 只去重动态 system 里的副本；user 目标正文、当前表格、世界书、版式清单不动。
- 配置与诊断只存 Hash、字符数、状态，不存预设正文，也不写进日志。
- `request_id` 幂等身份不因去重改变；缓存回答返回新的收件回执并标记 `cached`。

接口：

```text
GET  /v1/bridge/fixed-presets          列出配置与安装状态（无正文）
POST /v1/bridge/fixed-presets          保存配置
POST /v1/bridge/fixed-presets/preview  只读预览，不安装
```

响应中的 `bridge.preset` 给出 `status`、`rule_hash`、`original_chars`、
`deduped_chars`、`kept_chars`，用于核对“本轮是否真的少发了副本”。

设置面板新增「固定预设」页，可查看已配置项、安装状态与命中统计，并对单个
scope 重新安装。

## 桥接侧兜底清理（0.6.4）

浏览器扩展只在请求带 `dsh_session` 时生效。玉子手机、或任何绕过页面 fetch 的
调用方会让 `<bbi_image>` 原样进入桥接。0.6.4 增加了桥接侧输入投影：

- 只处理**动态组**，固定规则整体保留；
- 只删除完整的同名成对标签 `<tag ...>…</tag>`，支持属性、大小写、嵌套、一条消息内多块；
- 孤立开/闭标签、跨消息、截断、转义文本一律**原样保留**并记录诊断；
- 不执行标签内文本，不猜测 JSON 结尾；
- 原始消息、`dsh_context.sources` 校验和 `request_id` 幂等身份不变；
- 响应 `bridge.input_cleanup` 与收件回执 `bridge_cleanup` 给出
  `removed_blocks / removed_chars / orphan_open / orphan_close / effective_messages_digest`。

默认开启，标签默认 `bbi_image`；可在设置面板「服务」页关闭或改标签：

```json
"inputCleanup": { "enabled": true, "tags": ["bbi_image"] }
```

## 快照差分（0.6.5）

用专属随机标记切块，下一轮只删除与上一轮**开头/结尾完整相同**的块，中间保留。
没有标记时退化为消息级前后缀；任何不确定都整段发送。

标记格式（nonce 在面板生成，可复制）：

```text
<<<STB-9F3C7A1E5B2D:B>>>
这一段
<<<STB-9F3C7A1E5B2D:E>>>
```

模板写法：

```text
<<<STB-...:B>>>固定要求 A<<<STB-...:E>>>
<<<STB-...:B>>>动态正文<<<STB-...:E>>>
<<<STB-...:B>>>固定要求 B<<<STB-...:E>>>
```

行为：

- **auto 模式（默认）**：桥接自动按空行分段；长段落每行一块，单行仍超长时按句末标点/上限切；不需要模板加标记；
- **marker 模式**：按客户端 `B/E` 标记切块；
- 标记只在传输层存在，进模型前剥掉；
- 只删完整、配对、nonce 一致的前后块；
- 孤立/嵌套/块外有正文 → 整条消息不参与，整段发送；
- 快照只存 Hash，不存正文；
- 只在同一 session、上一轮成功、上一条消息仍存在于 DSH 历史时启用；
- 压缩/重启/回退 → `session-compacted`，整段发送；
- 裁剪会移除本轮全部 user 消息 → `no-user-after-trim`，整段发送；
- 分歧默认 `full`，可选 `branch`；
- 响应 `bridge.dynamic_diff` 给出 `status / mode / trimmed_messages / trimmed_blocks / trimmed_chars / kept_chars`。

配置：

```json
"snapshotDiff": {
  "enabled": true,
  "mode": "auto",
  "maxBlockChars": 2000,
  "marker": "9F3C7A1E5B2D",
  "clients": ["shujuku", "yuzi-phone"],
  "onDivergence": "full"
}
```

`mode: "auto"` 时 `marker` 可留空；`mode: "marker"` 时才需要 nonce。

## 安装与启用

先在源码目录运行既有部署脚本；退出、启动 DSH 由你手动操作：

```powershell
cd D:\AIGC\MOSS\ST-bridge
node deploy.mjs --check
# 没有生成任务时，从托盘完全退出 DSH
node deploy.mjs --apply
# 手动启动 DSH 后
node deploy.mjs --verify-running
```

安装酒馆扩展（不修改已有业务插件）：

```powershell
node install-tavern.mjs --extensions-dir "D:\download\SillyTavern-Launcher\SillyTavern\data\default-user\extensions"
# 上一步只读。确认路径后：
node install-tavern.mjs --extensions-dir "D:\download\SillyTavern-Launcher\SillyTavern\data\default-user\extensions" --apply
```

扩展目录为 `ST-Bridge-Context`，加载顺序为 1，早于本机已核对的柏宝绘、玉子和数据库。
更新时备份到用户 extensions 目录的 `.st-bridge-context-backups`；仅复制三个程序文件，
不自动启停酒馆或 DSH。刷新酒馆页面后，在扩展设置中打开 **ST-bridge 本机上下文适配**。

1. 地址填写实际桥接基址，例如 `http://127.0.0.1:43121/v1`。
2. 默认启用适配、使用“完整兼容”。先照常发送一次，查看请求范围与发送预览。
3. 点击“连接并读取规则档位”。令牌可从已观察到的匹配请求中在内存复用；
   如无法取得，可在密码框填写。扩展不会把令牌存入酒馆设置或预览。
4. 选择具体的 `client_id / task_id / chat_id` 范围，再选择并确认规则档位。
5. 新的请求采用所选档位；正在执行的请求和相同 request_id 的重试保持原结果。

`localhost`、`127.0.0.1`、`[::1]` 均可设置，但不互相当作同一目标。
端口、主机和 `/v1` 路径须与设置一致。其他本机服务（例如 8188、8317）不匹配。

## 预览怎么看

- 客户端预览：各条消息的角色、长度、已逐字匹配的世界书区间和拟选档位。
- 桥接确认：校验区间和整条消息 SHA-256，显示有效档位 Hash、规则前后长度及保留清单。
- 字符数按 JavaScript 字符串长度计算，**不是实测 token，也不用于宣称成本下降比例**。
- `adapter_cleanup`/`cleanup` 显示适配侧实际剔除的生图标记区间数、字符数及清理前后长度。
  桥接的 keep-all 是指保留收到的其余材料，不表示未经过适配侧的占位块清理。
- 来源标题来自客户端；服务器只确认区间/Hash，不把它冒充为酒馆的触发原因证明。
- 预览不包含正文、规则正文或密钥；浏览器只保留最近30个请求范围的统计。

扩展监听酒馆的 `WORLD_INFO_ACTIVATED`，只在当前聊天中将条目文本与实际发送文本逐字匹配。
不同条目有相同/重叠文本时不强行归属，仍显示未分类。宏可以展开，EJS 不会为了统计再执行。
某些插件使用 dry-run 激活世界书，不发该事件；渲染后的内容也可能与原条目不完全相同。
**未分类不等于没有世界书；第一版不会删除它。**

业务插件可以显式报告本轮条目对象，不需要改变业务提示词：

```js
window.STBridgeContextAdapter?.reportWorldInfo(entries, currentChatId)
```

报告对象可以包含 `content`、`uid`、`world`、`comment`。只能报告当前酒馆聊天，
内容仍须与实际发送文本逐字匹配。扩展不会重新扫描世界书，不改变递归触发状态。

## 手动规则档位

规则库在桥接 `stateDir/context-profiles.json`。它是本机私人数据，不在发布清单中，
也已加入 Git 忽略规则。第一版不内置或自动生成用户的精简规范。

在扩展设置中粘贴档位 JSON，点击“校验并覆盖桥接档位库”。覆盖前会备份已有文件。
结构如下，尖括号为填写说明，不能作为实际规则正文使用：

```json
{
  "version": 1,
  "profiles": [
    {
      "id": "manga-standard",
      "label": "漫画标准档",
      "client_id": "baibai-image",
      "task_id": "default",
      "replace": {
        "spec": "<你自行确认的完整精简规范正文>",
        "check": "<配套检查指导正文>"
      }
    }
  ]
}
```

可只替换 `spec` 或 `check`。原来的 `prefix`、`contract` 不允许替换，
除统一剔除生图占位块外，规则以外的目标正文、角色资料、世界书和状态表的其余文本保持不变。
替换 **整个** spec 时，必须自行保留适用的版式/槽位白名单等必要内容，
第一版不会猜测地从大段文本里拆出这些约束。

档位严格绑定客户端和任务；扩展的选择另外按聊天隔离。
档位内容改动后需重新读取并确认，旧 Hash 请求会被拒绝，不静默使用新内容。
切回“完整兼容”从原始客户端规则恢复，不从精简规则反向猜测原文。

**数据库/玉子等请求若 fixed_message_count=0 且从未明确提供 spec/check，
第一版只做来源预览和完整兼容。** 选择替换档会明确报错，而不是猜测哪条 system
是格式协议。后续需通过显式规则槽适配才能安全精简这些请求。

## 请求与兼容范围

### 按酒馆聊天自动隔离（扩展 0.3.1）

扩展现在可以在请求发往本机桥接时自动处理 `dsh_session`：

- 请求没有 `dsh_session` → 按配置注入一个，`chat_id = 前缀 + 当前酒馆聊天 ID`；
- 请求已有 `dsh_session`，且 `client_id` 在“覆盖的 client”名单里 → 把常量
  `chat_id` 改写为当前酒馆聊天 ID；
- 不在名单里的 client（例如柏宝绘）保持原样；
- 没有可用的酒馆聊天 ID 时不注入，请求按原样转发。

设置面板：

```text
自动注入 dsh_session / 改写 chat_id  ✔
默认 client_id        yuzi-phone
默认 task_id          default
chat_id 前缀          stb-
覆盖已有 chat_id      ✔
覆盖的 client_id      shujuku,yuzi-phone
固定规则条数          0
固定规则类型
```

效果：

```text
酒馆聊天 A → chat_id=stb-<A> → DSH 会话 A
酒馆聊天 B → chat_id=stb-<B> → DSH 会话 B
数据库 shujuku-db 常量 → 被改写为每个聊天独立
```

注意：

- 改写只对名单里的 client 生效；
- 旧 scope 的绑定和历史仍在，不会被删除；
- 更新扩展后需要刷新酒馆页面；
- 先把 `chat_id` 前缀留空或固定，观察回执确认聊天 ID 稳定后再批量使用。

### 失效 session_id 自动新建（0.7.0）

重置绑定后，插件可能仍保存并发送旧 `session_id`，桥接原本返回
`410 session_gone`。开启：

```json
"sessionOnStale": "recreate"
```

行为：

- 只对 `action=generate` 生效；
- 该 scope **没有任何绑定**：忽略旧 `session_id`，按新会话初始化；
- 旧 `session_id` **已归档**、但该 scope 已有新的有效绑定：使用当前绑定，不再 410；
- 旧 `session_id` 有效但不属于该 scope：仍然 410，不抢占会话。

面板位置：

```text
DSH 设置 → ST-bridge → 服务
  失效 session_id 自动新建会话  ✔
```

### 归档、超限与瞬时错误（0.8.0）

```json
"sessionOnArchived": "recreate",
"contextOverflow": "recreate",
"transientRetry": 1
```

- `sessionOnArchived`：绑定会话已归档时，不返回 409，直接新建；
- `contextOverflow`：收到 413 `context_length_exceeded` 时，清空绑定、新建会话并重发同一请求；单轮正文本身超限仍会失败；
- `transientRetry`：429/5xx/超时，且本轮**尚未产生 user 消息**时自动重试；最大 2 次，默认 0。

安全边界：

- 已有另一个有效绑定时不抢占；
- 一旦 DSH 会话记录了本轮 user 消息，就不再重试，避免重复回合；
- 重试使用同一个 `request_id`，幂等记录保留。

#### 提供方会话阻断（0.9.1）

`qoder: Session blocked, Please clear context try again (406/model_error)` 这类
错误不再被当成 DSH 上下文超限：

- 返回 `502 provider_session_blocked`；
- 不触发 `contextOverflow` 重建；
- 不纳入瞬时错误重试；
- 需要清理提供方会话、切换模型或重启 DSH 才能解除。

真正的上下文超限仍匹配 `context length`、`too many tokens`、`token limit`、
`上下文超限` 等明确措辞。

### 追加包装格式（0.9.0）

多消息追加默认使用短 nonce 分隔，避免与酒馆正文格式相撞：

```text
以下是追加到现有会话的新内容。
角色顺序：assistant、user。
请继续，不要重复已写内容，不要输出分隔标记。

<<<STB-724A02F1>>>
第一条

<<<STB-724A02F1>>>
第二条
```

配置：

```json
"appendFormat": "nonce",
"appendNonce": "724A02F1"
```

- `nonce`：短分隔符，正文几乎不可能自然出现；比 `ST_BRIDGE_MESSAGE` 少约 75% 字符；
- `tagged`：保留原 XML 包装；
- 单条无 name 的 user 仍然原文发送，不加包装；
- `appendNonce` 8–32 位十六进制，可在面板生成。

### TauriTavern 兼容（0.9.2）

TauriTavern 基于 SillyTavern 1.18.0 前端，并支持
`data/default-user/extensions/<folder>` 的第三方前端扩展，因此扩展可以按
SillyTavern 方式安装：

```powershell
node install-tavern.mjs --extensions-dir "<TauriTavern>/data/default-user/extensions" --apply
```

注意：

- TauriTavern 由宿主拦截 `fetch` / `jQuery.ajax`；扩展在宿主拦截器之上再包一层，
  仍能看到并改写 `custom_include_body`；
- 聊天 ID 读取兼容 `getCurrentChatId()`、`context.chatId`、`chatMetadata.chat_id`；
- 桥接接受 `tauri://localhost` 与 `http://tauri.localhost` 的 Origin；
- 若宿主 Rust 网络层禁止访问本机 `127.0.0.1:43121`，扩展会拿不到回执，此时只能用
  桥接 `plainCompat` 的共享会话兜底；
- 安装后刷新 TauriTavern 页面，再查回执是否为 `adapter_state: traced`。

### 手机 / TauriTavern 访问（0.9.6）

面板「服务与安全」新增：

```text
[启用局域网 / 手机访问]
```

点击后：

- 监听地址改为 `0.0.0.0`；
- 开启 `allowRemote`；
- 未设置 token 时自动生成一个；
- 重启桥接；
- 显示本机局域网 IPv4 地址，例如：

```text
http://192.168.1.20:43121/v1
```

手机端扩展填这个地址，并填入生成的 token。

注意：

- Windows 防火墙仍需手动放行 TCP 43121；
- 只建议在局域网或 Tailscale/ZeroTier 等私有网络使用；
- 不要直接暴露到公网；
- 点击「关闭局域网访问」会恢复 `127.0.0.1` 并重启。

### 工作区 cwd 兜底（0.9.4）

DSH Desktop 启动时的 `process.cwd()` 可能是 `...\dsh-desktop\launch-root`，
不等于用户真实工作区路径，导致：

```text
cannot attach session ... to workspace ...:
its cwd resolves to ...\launch-root
```

0.9.4 起：

- 如果配置的 `cwd` 不在 DSH 工作区列表里，自动改用第一个工作区路径；
- 会话创建和挂载都使用该路径；
- 只记录一次：

```text
[bridge] cwd ... 不是 DSH 工作区，改用 ...
```

仍然建议在面板里把「工作区 cwd」设成真实工作区，避免依赖兜底。

### 最终文本选择（0.9.5）

本轮回答按以下顺序取：

1. 从最后一条 assistant 往前找；
2. 取第一条**非空 text 块**；
3. 即使该消息同时带 `tool-call`，也保留可见 text；
4. 整个回合都没有 text 才返回 `empty_answer`。

这样解决：

```text
assistant: text = 本轮正文
assistant: tool-call = tableEdit
```

旧版会只看最后一条并返回空；0.9.5 会返回前一条的正文。

### 世界书与自定义清洗（扩展 0.3.0）

在“世界书与清洗设置”选择当前客户端／聊天／任务的请求范围，勾选启用。
名单默认为空、筛选默认关闭；内置 bbi_image 清理仍然启用。常驻世界书不在本版范围。

- **整本排除**：点击编辑名单，在弹窗中搜索、勾选并保存。
- **条目备注名过滤**：普通文字为不区分大小写的包含匹配；正则须写成 `/^规则/`
  或 `/表达式/i`。仅支持简单表达式，最多一个重复量词，不支持分组、分支和反向引用，
  避免在页面主线程执行失控正则。非法规则会提示而不会保存。
- **绿灯筛选名单**：对所选书中明确 `constant:false` 的条目，仅保留本轮实际激活项；
  蓝灯 `constant:true` 与未知模式保留。整本／备注名排除优先。
  不重新执行扫描或 EJS，也不把未发送的条目补进请求。
  激活结果必须来自当前聊天、当前酒馆生成周期；每次 GENERATION_STARTED 清空旧结果，
  GENERATION_ENDED 或切换聊天后失效。生图插件的 dry-run、数据库或玉子请求可能没有
  可关联的激活事件，此时保留并警告，不能据此声称已完成绿灯精简。
- **自定义清洗标签**：填 `snow` 等标签名（不填尖括号），对应成对块连同内容移除；
  孤立开／闭标签只移除标签本身。支持不同标签嵌套和跨文本片段，不匹配名称相近的标签。
  固定规则组中的示例不清理，sync_rules/reset 原样发送。

世界书目录使用酒馆 `getWorldInfoNames/loadWorldInfo` 读取，只展开普通宏；不修改原书。
默认只加载名单涉及的书，启用备注名规则时读取目录候选，单次上限64本、4096条；
超限或读取失败会在预览里提示。与柏宝绘的配置独立，不自动继承排除名单。

过滤只在固定组之后的动态 system 材料中，按完整条目正文精确匹配；重叠、同文条目、
模板渲染后无法匹配的内容保留。user/assistant 会话正文即便碰巧包含相同文字，也不按
世界书名单删除。此范围是第一版的保真边界，非全局“看见名字就删”。
空白包装文字可能仍留在消息里，系统消息角色、name、数组次序及文本片段元数据保留。

发送前先世界书过滤，再执行标签清洗，最后重新计算来源区间和摘要。
“本次发送预览”的 `worldbook_filter` 给出书名、条目ID、删除原因、字符数及保护／回退提示，
不记录条目正文；展开全文副本可核对 before/after。`cleanup` 单独统计标签清理量。
服务端 `bridge.context` 描述的是收到清理后的材料，不代表客户端原始正文未过滤。

这里只改变发出的副本，酒馆聊天、图片和世界书文件保留。已经写入 DSH 的旧历史不追溯删除。
本功能不需要新增 DSH 接口；收件回执核对仍需桥接0.6.0。

### 发送副本、差异与本次收件回执（桥接 0.6.0 / 扩展 0.2.0）

“请求范围”仍按客户端／聊天／任务保存档位。新增“本范围的发送记录”按每次尝试
分开选择：同一请求重试或同时执行，也各有独立 trace_id；原 request_id 和生成幂等语义不变。

- 展开“本次发送预览”查看消息字符数、来源统计、清理量、request_id 和回执。
- 展开“实际发送副本与清理差异”，查看 before_messages、after_messages、各消息变化区间
  以及 outgoing_body；可点击“复制已脱敏副本”。通过酒馆代理时 outgoing_body 是浏览器
  发给酒馆的封装，包含 custom_include_body；它不是 DSH 合并持久历史、替换规则后的模型输入。
- 密钥字段、显式请求头中的认证值、已识别的 Bearer／API Key 在显示副本里隐藏；
  脱敏不改真实请求。聊天、规则和世界书正文仍是私密内容，分享前应自行核对。
- 全文只在当前页面内存保留最近两份，每份最多 200 万字符；超限只留提示，不截断实际请求。
  统计保留最近 30 次。切换聊天清空全文，刷新页面清空扩展记录；不写设置、日志或磁盘。
- 点击“从桥接核对最近请求”可在生成完成前核对收件；不会触发模型调用。
  桥接内存保留最近 60 条已通过认证且请求体可解析的 completions 收件记录，重启即清空，
  不保留正文、回答、令牌和请求头。认证失败、非法 JSON 或尚未到桥接的请求不在其中。

只有本次 trace_id 对应且消息摘要一致，界面才显示收件已匹配。回执证明 HTTP 桥接收到的
messages 与客户端清理后的消息在文本、角色、name 上一致，不证明模型完全遵守提示词。
摘要按文本片段标准化后计算；不比较 temperature 等其他参数。
规则档位处理、DSH 会话历史和上游提示词缓存均不在这项确认范围。
`bridge.context` 可来自缓存；`bridge.receipt` 每次 HTTP 尝试重新生成，不会借旧审计充当新回执。

收件列表的 adapter_state：`traced` 表示携带新版追踪标记；`untraced-context` 表示有旧版
上下文元数据；`absent` 表示没有适配标记。后两者可能来自旧客户端、缺少 dsh_session、
独立 iframe 或绕过 fetch 入口等，单凭此状态不认定原因。消息摘要不一致会单独显示，
不会为诊断自动重发、切会话或改路由。

新增只读 `GET /v1/bridge/context/receipts`，共用现有认证和 Origin 校验；
支持 trace_id、client_id、chat_id、task_id 查询参数。持久会话 JSON 成功／错误响应
附带 `bridge.receipt`；旧式 legacy SSE 可在收件列表核对，不保证 SSE 自带回执。
运行旧版桥接时，扩展仍能清理与预览，但需部署新版并重启 DSH 才能核对收件。

适配范围：

- 酒馆同源 `POST /api/backends/chat-completions/generate`，custom_url 精确指向配置桥接；
- 直接 `POST <配置桥接>/chat/completions`；
- 都必须已有有效 `dsh_session` v1。缺少协议的请求原样放行，不自动猜身份；
- `sync_rules`、`reset` 原样发送；仅 `generate` 增加 `dsh_context` 元数据。

通过酒馆代理时，先按附加主体参数确定最终 messages，再清理占位块，并同时回填
顶层及附加参数中的 messages，避免旧副本覆盖回流。消息角色、顺序、文本片段结构
及其他正文保留，不修改调用插件持有的消息对象。元数据与原有参数一起写入 `custom_include_body`。
清理不区分客户端名称，数据库、玉子及以后接入的插件只要经过这个发送边界就共用。
明确标记为固定组的前 fixed_message_count 条规则保留格式示例；sync_rules/reset 仍原样发送。
跨文本片段的完整占位块同样可移除；孤立开/闭标记只移除标记本身，不吞掉随后正文。
柏宝绘自己的清理保留，供它走其他 API 时使用；重复清理不会再删其他内容。
已经写入 DSH 会话的旧内容不会因此从历史中消失。
现有 fetch 链继续调用；非目标请求以原 input/init 发送，不改 API 地址、请求头和参数。
如果某插件在本扩展加载前保存了 fetch，或使用 iframe、独立网络库等绕过入口，
它仍可能不被观察到；先刷新页面，再根据实际请求单独适配，不全局劫持所有网络请求。
若酒馆后处理改写了消息，来源 Hash 会拒绝过期标记；应核对该预设的后处理配置。

HTTP 接口使用与桥接相同的认证及 Origin 检查：

- `GET /v1/bridge/context/profiles`：只列档位名称、作用范围、槽和 Hash，不返回规则正文；
- `POST /v1/bridge/context/profiles`：校验并备份覆盖本机库；
- `POST /v1/bridge/context/preview`：使用 messages、dsh_session、dsh_context 返回统计，
  不创建 Agent、会话绑定或模型回合。

送入桥接的消息与实际规则选择用于幂等身份校验；来源元数据只校验区间并用于统计，
补充来源标记本身不会改变请求身份或导致重复生成。派生档位只作用于当前固定规则快照。
已经存下的会话历史不会被修改或截断。预览、换档、重试测试通过不代表已完成
所有实际插件与真实模型的联调，也不代表已经省下某个百分比的 token。
