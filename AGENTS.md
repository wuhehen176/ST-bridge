# ST-bridge agent notes

本文件只写“接手必须知道”的内容；功能说明看 `README.md`，协议细节看 `CONTEXT-ADAPTER.md`，外部工具看 `EXTERNAL-TOOLS.md`。

## 项目边界

- 本仓库是 DSH Host 插件（`package.json`、`cordis.patch.yml`、`index.js`）。
- Tavern 扩展是独立仓库 `ST-bridge-tavern`，不要把它的 `manifest.json` 放到本仓库根目录。
- 运行时状态在 `%USERPROFILE%\.dsh\st-bridge\`：`settings.json`、`state.json`、`devices.json`、`bridge.log`。
- 插件部署在 DSH profile 与 `vendor/ST-bridge` 两处；不要只改其中一处。

## 常用命令

```bash
npm test
npm run build:client
npm run check
node tools/check-file-size.mjs --all
node deploy.mjs --check
node deploy.mjs --apply          # 必须完全退出 DSH 后运行
node deploy.mjs --verify-running
```

`npm test` 是 `node --test test/*.test.mjs`。不要用 `grep -R` 扫仓库根目录：Windows 的 `CON` 设备节点会卡住进程。

## 代码地图

| 路径 | 职责 |
| --- | --- |
| `index.js` | 插件入口、配置归一化、路由注册、面板 RPC |
| `lib/server.js` | HTTP 服务、鉴权、CORS、路径与模型白名单 |
| `lib/engine/` | DSH 会话、回合、固定规则、快照、重试与回退（`index.js` 类壳，`*-methods.js` 分组） |
| `lib/snapshot-diff.js` | 块级快照裁剪、`STB-KEEP` 范围 |
| `lib/system-snapshot.js` | 系统段快照模式（`native`/`filled`/`empty`） |
| `lib/layout-atlas.js` | 版式图册 hash 与前缀注入 |
| `lib/skill-binding.js` | 绑定 Skill 的读取、冻结与校验 |
| `lib/client-endpoints.js` | 每插件端点、模型/预设/工作区/maxtokens 覆盖 |
| `lib/pairing.js` | 配对码、设备 token、审批与吊销 |
| `lib/store.js` | `state.json` 持久化 |
| `client/` | 设置面板源码（`index.js` 入口、`panel.js` 状态、`endpoints.js` 插件页、`helpers.js`、`theme.js`） |
| `client.js` | 由 `npm run build:client` 生成的浏览器 bundle，不要手改 |
| `lib/defaults.js` | 端口、清理标签、系统快照模式的唯一默认值来源 |

## 不可破坏的约束

1. **不要写空系统消息。** 系统段必须带完整渲染文本；`native` 模式只修复旧版本留下的空节点。
2. **固定规则先于生成。** dedicated `generate` 前必须确认协议；缺协议返回 `409 fixed_rules_required`，由客户端重同步，不能无限重试。
3. **`STB-KEEP` 只保护块。** `<<<STB-KEEP>>>` / `<<<STB-/KEEP>>>` 不能阻止消息级裁剪；系统段从完整动态组取，不从裁剪后的 diff 取。
4. **每插件覆盖优先。** 模型、预设、cwd、max_tokens 以 `clientEndpoints` 为准；空值才跟随 DSH 默认，不存在全局模型页。
5. **设备 token 只进聊天路径。** `/health`、`/v1/models`、`/v1/chat/completions`、`/v1/bridge/capabilities` 可用；状态与管理路径必须拒绝。
6. **不要默认启用 `plainCompat`。** 它会把无 `dsh_session` 的请求折叠到同一个 scope。
7. **不要把 `CON` 加回仓库。** 它已写入 `.gitignore`，但仍是设备节点。

## 改动流程

- 改动前先读对应 `lib/*.js` 和现有测试；优先复用 `lib/defaults.js`，不要再散落默认值。
- 新行为必须同时补测试：协议/HTTP 改动放 `test/session-protocol.test.mjs`，引擎回退放 `test/engine-setup.test.mjs`，面板放 `test/panel.test.mjs`。
- 提交前跑全量 `npm test`；发布版本时同步 `package.json`、`README.md` 的版本说明。
- 部署前确认 DSH 已完全退出；运行中只允许 `--check`，不要强推。
- 本地面板改动没有 HMR；改 `client/` 后先 `npm run build:client`，再刷新设置页；改宿主代码后重新部署并重启 DSH。

## 文档

- `README.md`：安装、配置、面板说明（体量大，新增内容优先放专门文档并链接）。
- `CONTEXT-ADAPTER.md`：请求格式、快照、固定规则、`STB-KEEP` 语义。
- `EXTERNAL-TOOLS.md`：外部工具模式与白名单。
- `docs/archive/`：历史交付记录，不再维护。
