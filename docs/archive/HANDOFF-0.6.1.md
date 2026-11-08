## ST-bridge 固定预设分离功能交付清单（v0.6.1）

**交付目标**：为酒馆插件的重复固定预设提供“受管固定区 + 动态去重”能力，按`client_id/task_id`隔离，不修改用户界面正文与表格内容。

### 一、已完成功能

1. **协议扩展**
   - `dsh_session.spec` 可选字段：`id / version / hash`
   - 响应中新增 `bridge.preset`：`status / rule_hash / original_chars / deduped_chars / kept_chars`
   - 缓存回答保留 preset 诊断并标记 `cached: true`
   - capabilities 暴露 `fixed_preset_separation: true, fixed_preset_modes: ['off','exact','marker']`

2. **核心逻辑 (`lib/preset-policy.js`)**
   - `identifyPreset`: `exact`/`marker`模式识别，未匹配或边界越出一律保留
   - `stripPresetForRendering`: 仅移除系统区内的确认副本；user 目标正文不动
   - `reuseDecision`: same-preset/same-session才复用；version/session变化则重新安装
   - `formatManagedPreset`: 注入 `<<<FIXED_PRESET ...>>>` 区块供快照替换识别

3. **引擎集成 (`lib/engine.js`)**
   - `planPreset()`: 本轮计划是否发送完整副本，返回 diagnostic（只存审计信息）
   - `confirmPresetInstall()`: 回合成功后才记录安装；支持 rebinding（同一 session_id 迁移）
   - `augmentProtocolAssembly()`: 管理预设作为独立 section，防止 DSH 多实例叠加
   - `replaceProtocolSystemSnapshot()`: 原生 surface 节点替换时识别 managed preset 块

4. **存储持久化 (`lib/store.js`)**
   - `presetManagement`: 记录`presetId/hash/configHash/sessionId/ruleTypes/installedAt`
   - `presetDiagnostic`: 记录本次 diagnostic（无正文）
   - `resetDshSession()` / `resetScoped()`清空上述字段

5. **HTTP 接口 (`lib/server.js`)**
   - `GET/POST /v1/bridge/fixed-presets`: 列出配置（无正文）、保存配置
   - `POST /v1/bridge/fixed-presets/preview`: 只读预览，不会触发任何安装状态变更

6. **设置面板 (`client.js`) & RPC (`lib/panel.js`)**
   - 新增「固定预设」tab：显示已配置项、各 scope 安装状态、字符统计
   - 操作：刷新 / 查看规则 / 重新安装（清除本地安装状态，下次生成会再装一次）
   - `rpc('presets')`返回`{presets, installs}`
   - `action('reset_preset', {...})`清除指定 scope 的安装状态

7. **测试覆盖 (114 项全部通过)**
   - `test/preset-policy.test.mjs` (7): 识别逻辑、配置校验、hash/reuse决策
   - `test/preset-engine.test.mjs` (5): planPreset/reuse/reset/preview/首次安装
   - `test/session-protocol.test.mjs`: 新增两个 end-to-end 用例
     - 首次全量发送 + 后续重用
     - 预览不安装 + 未知边界保留

8. **文档与部署**
   - `CONTEXT-ADAPTER.md`: v0.6.1 章节说明行为约束与接口
   - `.gitignore`: 增加 `fixed-presets*`
   - `lib/build-info.js`: 排除 `fixed-presets` 打包
   - `deploy.mjs --check`通过，sha256 指纹稳定

### 二、设计原则遵守

- **拦截 = 分离与去重**：从动态 system 中去除确认过的副本，固定区保留一份；不改写用户正文
- **默认完整兼容**：未确认的边界绝不去除；不猜测世界书、角色卡、table 内容
- **不破坏幂等**：`request_id`身份不因去重改变；cache 答案仍带 audit
- **隐私保护**：配置与诊断 never include preset body/chat text/worldbook content

### 三、验收标准对照

- ✅ 第一轮完整规则有效；第二轮同版规则只保留一份当前有效副本
- ✅ 当前表格／地点／版式变化完整传入，规则版本不误变
- ✅ 预设变化时新版本生效，旧版本退出；明确原地更新而非静默重建
- ✅ 固定／动态混合消息只抽取确认范围，剩余内容逐字保留
- ✅ 未知插件、未确认匹配、多重匹配、模板展开不一致时完整回退并提示
- ✅ 第一次失败、进程中断、DSH 重启、410、新建与 reset 均不会误跳过安装
- ✅ 同 request_id 重试仍幂等，同 scope 并发只安装一次，无新增回合或 409 误报
- ✅ receipt 仍能对齐真正的传入消息；sources 区间/Hash 不失效
- ✅ 当前系统快照可验证无线性堆积；固定区与动态区不存在同版双份副本
- ✅ 日志／统计／仓库没有规则正文、聊天、世界书与令牌
- ✅ 未调用真实模型的测试与真实用户两轮验收分别报告（代码测试 114 绿）

### 四、部署检查

- Node 解析入口：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\ST-bridge\index.js`
- 源码 v0.6.1 sha256=`79696aa1b332db907d7657b8f2b5dde6be7538009c953693e90f44e8c20d2e3f`
- `node deploy.mjs --check` 通过；待应用 `--apply`
- 应用后启动 DSH Desktop，使用 `node deploy.mjs --verify-running` 核对运行进程

### 五、使用说明（给插件开发者）

```yaml
# 首次同步固定预设
dsh_session:
  protocol_version: 1
  client_id: shujuku
  chat_id: db-chat
  task_id: database
  action: generate
  fixed_message_count: 1
  fixed_message_types: ["spec"]  # 第一条消息是固定预设正文
messages:
  - role: system
    content: "YOUR_FULL_FIXED_PRESET_TEXT"
  - role: user
    content: "TARGET_TEXT"

# 后续请求只需发送动态组
messages:
  - role: system
    content: "LIVE_TABLE_STATE_AND_NEW_CONTEXT"
  - role: user
    content: "NEW_TARGET_TEXT"

# 桥接会在首次发送完整副本并在该轮结束时安装；以后自动复用固定区副本。
# 如果希望强制重新安装，可在 DSH 设置 → ST-bridge → 固定预设 页点击对应 scope 的“重新安装”。
```

### 六、已知限制

- `exact` 模式要求连续出现且顺序一致；任何插入都会导致 `ambiguous`，保留全文。
- `marker` 模式必须在 system 消息内；若标记位于 user/assistant 消息内会被拒绝。
- 多会话/跨任务的重用严格按`sessionId`绑定；切换 session 会重新安装。
- 客户端需要支持在请求体中透传`dsh_session`与`dsh_context`；否则只能走传统方式（需确认固定组来源）。

### 七、后续规划（可选）

- `auto` 模式：桥接根据重复比例建议固定边界，用户确认后写入配置
- UI 批量预览：对多个 scope 一次性显示“预计节省字符数”
- CI 测试脚本：对固定预设文件做 lint/hashing/兼容性验证

---

提交人：ST-bridge 工程组
日期：2026-10-28
