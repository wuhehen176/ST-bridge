# 数据库 / 玉子手机 固定规则配置

这两份配置解决的是同一件事：把“每轮完全重复”的固定预设从动态资料里剥离，
让桥接只在固定区保留一份。区别在于怎样确认边界。

## 两种做法，二选一

| 做法 | 谁负责 | 适合 |
| --- | --- | --- |
| **A. 固定组**（`fixed_message_count`） | 插件在 `dsh_session` 里声明 | 插件能稳定地把固定预设放在 `messages` 开头 |
| **B. 固定预设分离**（`fixed-presets`） | 桥接按 Hash 识别 | 插件不能改分组，但固定正文每轮逐字一致 |

不建议同时开：A 已经把固定组剥离，B 再识别同一段只会重复。

## 先确认消息结构

从酒馆插件里取一份真实请求 JSON（任意能拿到 `messages` 的预览/调试入口），运行：

```powershell
cd D:\AIGC\MOSS\ST-bridge
node tools/fixed-group-preview.mjs request.json
```

输出会列出每条消息的角色、长度、Hash 前缀和候选固定组。只把**每轮完全一样**
的 system 计入固定组；世界书、当前表格、版式清单、当前状态都属于动态。

判定标准：

- 同一段文字在上一轮和这一轮逐字一致 → 可以固定
- 随剧情/表格/世界书变化 → 不能固定
- 不确定 → 不计入，保持动态

## 做法 A：在插件里填固定组

把 `configs/tavern/database.yaml` 或 `configs/tavern/yuzi.yaml` 的内容合并进
插件的「附加主体参数 / custom_include_body」。

保守配置是只固定第 1 条：

```yaml
fixed_message_count: 1
fixed_message_types: ["prefix"]
```

如果确认第 2 条也每轮稳定，可升级为：

```yaml
fixed_message_count: 2
fixed_message_types: ["prefix", "contract"]   # 数据库：第 2 条是 JSON 输出协议
# fixed_message_types: ["prefix", "spec"]     # 玉子：第 2 条是短信格式规范
```

注意：`fixed_message_types` 每种用途只能出现一次，且必须与 `fixed_message_count`
逐条对应；桥接会拒绝重复类型。

首次请求带完整固定组；之后插件的动态组仍然发送，桥接自动沿用已保存的固定规则。
日志里会看到：

```text
[dsh-session] generate shujuku/... fixed=1 dynamic=3
```

`fixed=` 就是本轮从动态资料中剥离的条数。

### 风险

`fixed_message_count` 必须小于总消息数，并且动态组里要留一条 user。如果某轮
世界书缺失导致 `messages` 只剩「预设 + user」两条，而固定组设成 2，就会把 user
当成固定规则，桥接报 `empty_dynamic_group`。所以先保守用 1；确认结构稳定后再加。

## 做法 B：桥接侧固定预设分离

适合插件不能改分组、但固定正文每轮逐字一致的情况。

生成配置：

```powershell
node tools/make-fixed-preset.mjs request.json `
  --client shujuku --task database --id db-preset --label "数据库固定预设" --count 2
```

把输出保存为 `preset.json`，确认后提交：

```powershell
curl.exe -X POST http://127.0.0.1:43121/v1/bridge/fixed-presets `
  -H "content-type: application/json" --data-binary "@preset.json"
```

然后**把插件里的 `fixed_message_count` 改回 0**，让桥接自己识别。

行为：

- 第一次：完整发送，回合成功后记录安装
- 后续同版：动态 system 中的副本被剥离，固定区只留一份
- 预设变化（Hash 不同）：重新安装，旧版本不再并列生效
- 未识别 / 部分匹配 / 多重匹配 / 边界越出 system：**完整保留**并给诊断

响应中的 `bridge.preset` 会给出：

```json
{"status":"reused","rule_hash":"…","original_chars":12345,"deduped_chars":12000,"kept_chars":345}
```

## 验证

```powershell
# 看桥接日志里的 fixed= 与 preset 状态
Get-Content $env:USERPROFILE\.dsh\st-bridge\bridge.log -Tail 30

# 看当前配置与安装状态（不含正文）
curl.exe http://127.0.0.1:43121/v1/bridge/fixed-presets
```

## 清空/关闭

- 做法 A：把插件的 `fixed_message_count` 改回 0。
- 做法 B：`POST /v1/bridge/fixed-presets` 提交 `{"version":1,"presets":[]}`，
  或把某项 `mode` 设为 `off`。
- 单个 scope 重新安装：DSH 设置 → ST-bridge → 固定预设 → 重新安装。

## 玉子手机：没有 API 预设时怎么建

在「API 预设 → 新建 API 预设」里填：

```text
名称:      ST-bridge
API 地址:  http://127.0.0.1:43121/v1
API 密钥:  留空（应用了“方案 A 清除 token”后不需要）
手写模型:  dsh-default
温度:      1.00
最大输出:  4096
```

保存并在玉子手机里选用这个预设。

### 但玉子只会发普通 OpenAI 请求

它的 API 预设没有 `dsh_session` / `custom_include_body` 字段，桥接默认会返回
`400 persistent_protocol_required`。需要打开桥接的普通请求兼容模式：

```text
DSH 设置 → ST-bridge → 服务 → 兼容模式：普通 OpenAI 请求归入固定 scope
  启用           ✔
  client_id      yuzi-phone
  chat_id        yuzi-phone
  task_id        default
  固定规则条数    1
  固定规则类型    prefix
  保存
```

`固定规则条数 = 1` 表示把每条请求的第一条消息当作固定规则（玉子的人设/聊天规范）。
如果玉子的第一条消息不是稳定的 system 预设，把它改成 0；等确认结构后再设置。

之后所有不带 `dsh_session` 的请求都会进入 `yuzi-phone / yuzi-phone / default`
这一个持久会话。日志里会出现：

```text
[http] plain-compat 归入 yuzi-phone/yuzi-phone/default
[dsh-session] generate yuzi-phone/yuzi-phone/default ... fixed=1 dynamic=...
```

`fixed=1` 表示本轮有 1 条固定规则被剥离，不再作为动态资料重复发送。

注意：

- 这个模式是**全局**的，同一时间只适合一个不会发 `dsh_session` 的插件。
- 数据库有能力发 `dsh_session`（用上面的固定组配置），不要和玉子共用兼容模式。
- 兼容模式支持 `stream: true`，会返回 SSE；非流式仍返回普通 JSON。
- 想让玉子换会话：在「客户端」页对 `yuzi-phone` 点「重置绑定」。
