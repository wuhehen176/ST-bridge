# 外部工具接入（桥接 0.12.0／酒馆扩展 0.4.4）

数据库把 OpenAI function tools 的定义发给桥接；桥接在当前真实 DSH Agent
作用域注册这些工具。DSH 原生工具执行器等待客户端结果，客户端回填后，原来的
Agent 回合继续。桥接不执行数据库操作，也不从最终正文猜测工具调用。

## 第一版范围

- `stream:false`；`tool_choice` 省略或为 `auto`；`parallel_tool_calls` 省略或为 `false`。
- `tools` 最多 32 个，名称唯一，采用 object 根 JSON Schema，`strict:true` 暂不支持。
  参数仍由 DSH 原生执行器校验；不支持的 schema 关键字可能被 DSH 明确拒绝。
- 每次向客户端返回一个工具调用。原生模型同一步给出多个调用时，DSH 依次执行和回填。
- 客户端负责实际执行、审批和按 `tool_call_id` 去重；桥接的重试缓存不等于数据库写入事务。
- 不加载继承的终端、文件系统或其他 DSH 工具；只有本次客户端定义的函数可见、可执行。
- 暂不支持旧 `functions/function_call`、强制指定函数、`required/none`、严格 JSON
  约束采样或外部工具流式响应。普通文本能力不受影响。

## 数据库设置

使用独立地址 `http://电脑IP:43121/clients/shujuku/v1`，模型 `dsh-default`，
填写该设备的桥接令牌。酒馆扩展继续按当前聊天注入 `dsh_session`、配对认证和
独立范围；选择原生工具模式时关闭流式和并行。若数据库强制发送 `tool_choice:required`
或 `strict:true`，需要数据库一侧调整；桥接会明确报错。

工具模式不进行世界书筛选、自定义标签清洗、固定规则档位替换或消息内容改写，
避免破坏 `assistant.tool_calls` 与 `role:tool` 的关联。动态前置 system 保持快照替换，
完整已确认工具历史的正文前缀不会重复追加。当前状态仍须每轮由客户端提供。

## HTTP 往返

首次请求示例（Authorization 使用桥接设备令牌，不是上游模型的 API Key）：

```json
{
  "model": "dsh-default",
  "stream": false,
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "tools": [{"type":"function","function":{
    "name":"insertRow",
    "description":"Insert a database row",
    "parameters":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false}
  }}],
  "messages": [{"role":"user","content":"Call insertRow with value fixture."}],
  "dsh_session": {
    "protocol_version":1,"client_id":"shujuku","chat_id":"test-chat","task_id":"database",
    "request_id":"request-1","action":"generate","fixed_message_count":0,"fixed_message_types":[]
  }
}
```

DSH 决定调用工具时返回：

```json
{
  "choices":[{"index":0,"message":{"role":"assistant","content":null,
    "tool_calls":[{"id":"actual-call-id","type":"function","function":{"name":"insertRow","arguments":"{\"value\":\"fixture\"}"}}]},
    "finish_reason":"tool_calls"}],
  "dsh_session":{"client_id":"shujuku","chat_id":"test-chat","task_id":"database","session_id":"actual-session-id","request_id":"request-1"}
}
```

客户端校验函数与参数、执行并保存去重结果，然后再次请求。同一范围、同一
`session_id`，使用新的 `request_id`；保留 tools，messages 原文之后追加刚收到的
assistant message，再追加：

```json
{"role":"tool","tool_call_id":"actual-call-id","content":"{\"inserted\":true}"}
```

桥接回填等待中的原生执行器，不再调用第二次 `followup`。下一次响应要么继续返回
一个 `tool_calls`，要么返回最终 `content` 与 `finish_reason:"stop"`。
工具响应阶段不伪造 usage；最终响应中的 usage 汇总整个 Agent 回合。
工具回填期间不能更改定义、ID 或参数。下一轮正文可以换工具定义。

网络重试必须复用该 HTTP 阶段原来的 `request_id` 与相同请求内容。换了结果内容
却沿用旧 request_id 会返回 409；不能把旧结果改一个 ID 再执行。
请求记录沿用现有最多 200 条的保留策略，长期执行去重须由客户端持久保存。
完整工具历史若引用已过期或其他会话的调用，将拒绝并要求核对后重建。

## 中断处理

等待回填的调用及结果接收哈希写入桥接状态文件，但异步等待器位于内存。
**第一版不提供等待期间的进程重启恢复。** 超时、取消、重启后回填返回
`409 tool_continuation_unavailable`；不会伪造成功、自动重发写库操作或创建另一个
Agent 来猜测结果。先核对数据库是否已应用，再显式 reset 或重新组织任务。
待回填期间同范围普通正文和 sync_rules 会被拒绝，避免另一个请求抢占原回合。
不同插件、聊天和 task_id 独立隔离。

## 验收与部署

回归测试：`node --test test/*.test.mjs`。
已安装 DSH 的原生工具运行时可单独验证（不调用模型、不写数据库）：

```powershell
node tools/probe-native-tools.mjs 'C:\Users\你的用户名\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai'
```

部署前确认所有生成和待回填工具已结束：

```powershell
cd D:\AIGC\MOSS\ST-bridge
node deploy.mjs --check
# 先从托盘完全退出 DSH；部署脚本发现进程仍在运行时会拒绝同步
node deploy.mjs --apply
# 重新启动 DSH Desktop
node deploy.mjs --verify-running
```

酒馆扩展也需更新至 0.4.4 并刷新。不要只更新 Host 就认为旧浏览器适配器支持工具消息。
本机安装可使用 `node install-tavern.mjs --extensions-dir <酒馆用户extensions目录> --apply`，
该脚本自动备份原扩展，不修改设置。
更新后可运行 `tools/smoke-external-tools.mjs`；它创建独立测试会话，只回传模拟结果，
不会调用真实数据库。通过后再用数据库插件的测试表验收，不直接在正式表上首次试跑。
