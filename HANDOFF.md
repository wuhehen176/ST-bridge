# ST-bridge 项目交接单

- 日期：2026-10-30
- 项目：DSH Host 插件 + Tavern 扩展 + 手机局域网配对
- 运行环境：Windows + DSH Desktop + TauriTavern/SillyTavern

---

## 1. 项目概览

ST-bridge 让酒馆/TauriTavern 通过 OpenAI 兼容接口调用 DSH Agent，并把酒馆聊天映射成持久 DSH 会话。

组成：

```text
DSH Host 插件
  HTTP 服务 0.0.0.0:43121
  OpenAI 兼容 /v1/chat/completions
  面板：服务、规则、上下文、配对

Tavern 扩展 ST-Bridge Context
  fetch 适配器
  注入/改写 dsh_session
  上下文与生图占位清理
  手机配对 UI
```

两个仓库：

| 仓库 | 用途 | 本地 |
| --- | --- | --- |
| `wuhehen176/ST-bridge` | DSH 插件 | `D:\AIGC\MOSS\ST-bridge` |
| `wuhehen176/ST-bridge-tavern` | 酒馆扩展 | `D:\AIGC\MOSS\ST-bridge-tavern` |

必须分开的原因：

- DSH 插件要求根目录 `package.json` / `cordis.patch.yml`；
- 酒馆扩展要求根目录 `manifest.json`。

---

## 2. 当前版本

| 部分 | 版本 | 提交 |
| --- | --- | --- |
| ST-bridge 仓库 | `0.11.0` | `4a9bd24` |
| 实际运行桥接 | `0.11.0` | 已验证 |
| Tavern 扩展 | `0.4.0` | `bccd825` |
| 测试 | 176 项通过 | — |

注意：桥接运行版本已确认是 0.11.0；扩展本地已安装 0.4.0。

---

## 3. 架构

```text
TauriTavern / SillyTavern
   │  OpenAI 兼容请求
   ▼
ST-Bridge Context 扩展
   │  注入 dsh_session / 清理 bbi_image / 设备 token
   ▼
ST-bridge HTTP 43121
   │  scope: client_id + chat_id + task_id
   ▼
DSH Agent 会话
```

手机访问：

```text
手机 Wi-Fi 192.168.3.x
   → 电脑 WLAN 192.168.3.47:43121
```

ComfyUI 是独立服务：

```text
ComfyUI 8188
ST-bridge 43121
```

---

## 4. 当前完成度

| 阶段 | 状态 | 内容 |
| --- | --- | --- |
| P0 手机连通性 | ✅ | `/health`、JSON POST、Authorization、CORS、SSE 自检通过 |
| P1 配对状态机 | ✅ | invite/request/device、单次占用、批准/拒绝 |
| P2 token 交付 | ✅ | 重试领取、ACK、撤销、原子写、重启失效 |
| P3 面板配对 UI | ✅ | 生成配对码、待批准、设备列表、撤销 |
| P4 扩展手动配对 | ✅ | 输入配对码、轮询、保存设备 token、ACK |
| 插件专属接入 | ✅ | `/clients/<id>/v1`、面板登记、身份冲突拒绝 |
| P5 二维码/扫码 | ⬜ | 未实现 |
| P6 防火墙 UAC | ⬜ | 未实现 |

已实现的手动流程：

```text
电脑面板生成配对码
→ 手机扩展输入配对码
→ 电脑面板允许
→ 扩展轮询领取 token
→ ACK 保存
→ 设备 active
```

---

## 5. 关键文件

### 桥接

| 文件 | 作用 |
| --- | --- |
| `index.js` | 插件生命周期、服务启停、PairingService 装配 |
| `lib/server.js` | HTTP 路由、CORS、认证、selftest、配对接口 |
| `lib/pairing.js` | 配对状态机、设备 token 哈希、devices.json |
| `lib/panel.js` | 面板状态与 RPC action |
| `client.js` | DSH 设置面板 UI |
| `lib/engine.js` | DSH Agent 回合、会话、上下文、fallback |
| `lib/store.js` | state.json 会话绑定 |
| `lib/context-policy.js` | 上下文/世界书/清洗策略 |

### 扩展

| 文件 | 作用 |
| --- | --- |
| `tavern-extension/index.js` | 酒馆设置 UI、配对 UI、自检、事件 |
| `tavern-extension/core.js` | fetch 适配器、dsh_session、设备 token 注入 |
| `tavern-extension/manifest.json` | 扩展清单与版本 |

### 工具

| 文件 | 作用 |
| --- | --- |
| `deploy.mjs` | 部署插件到 DSH profile |
| `install-tavern.mjs` | 安装扩展到酒馆目录 |
| `tools/sync-tavern-repo.mjs` | 同步扩展到独立仓库并提交/推送 |

---

## 6. 运行时与配置

### 桥接设置

`%USERPROFILE%\.dsh\st-bridge\settings.json`

关键字段：

```json
{
  "host": "0.0.0.0",
  "port": 43121,
  "allowRemote": true,
  "authToken": "<共享 token>"
}
```

### 设备文件

`%USERPROFILE%\.dsh\st-bridge\devices.json`

- 只保存设备 token 的 SHA-256 哈希；
- 不保存明文 token；
- 文件损坏时设备 token 全部拒绝（fail closed）；
- 写临时文件 + rename，失败回退直接写。

### 当前网络

| 设备 | IP |
| --- | --- |
| 电脑以太网 | `192.168.3.48` |
| 电脑 WLAN | `192.168.3.47` |
| 手机（历史） | `192.168.3.76` |

推荐手机与插件统一使用：

```text
http://192.168.3.47:43121/v1
```

不要使用 `192.168.3.76`（那通常是手机自己）。

### 本地安装路径

```text
DSH 插件：
C:\Users\52229\.dsh\profiles\desktop\node_modules\ST-bridge

酒馆扩展：
D:\download\SillyTavern-Launcher\SillyTavern\data\default-user\extensions\ST-Bridge-Context
```

---

## 7. HTTP 接口

### 业务

| 方法 | 路径 | 认证 |
| --- | --- | --- |
| GET | `/health` | 需要 |
| GET | `/v1/models` | 需要 |
| POST | `/v1/chat/completions` | 需要 |
| GET | `/v1/bridge/capabilities` | 需要 |
| GET | `/v1/bridge/status` | 需要，设备 token 禁止 |
| GET | `/v1/bridge/context/receipts` | 需要，设备 token 禁止 |

### 自检（无需认证）

```text
GET  /v1/bridge/selftest
POST /v1/bridge/selftest
GET  /v1/bridge/selftest/stream
```

只返回元信息，不返回聊天内容。

### 配对

```text
POST /v1/bridge/pair/request
GET  /v1/bridge/pair/status
POST /v1/bridge/pair/ack
```

请求头：

```text
X-STB-Pair-Request: <pairId>
X-STB-Poll-Token: <pollToken>
```

配对接口不需要共享 token，但需要有效配对码或 pollToken。

### 面板 RPC

```text
pair_start
pair_list
pair_approve
pair_reject
device_revoke
device_clear
rotate_auth_token
enable_mobile_access
disable_mobile_access
```

管理操作只通过 DSH 本机面板 RPC，不提供 HTTP 管理接口。

---

## 8. 配对状态机

```text
invite:  active / consumed / expired / cancelled
request: pending / approved_pending_delivery / delivered / rejected / expired
device:  pending_delivery / active / revoked
```

规则：

1. 一个 invite 只允许一个申请，先到先占；
2. 重复提交返回 `invite_consumed`；
3. 批准后设备为 `pending_delivery`；
4. 同一 pollToken 可重复领取同一个 token；
5. ACK 后设备才 `active`；
6. 未 ACK 时桥接重启，pending 设备丢弃；
7. 配对码和 token 明文只在内存短期存在；
8. 设备 token 只调用业务接口，不能管理；
9. 撤销后新请求立即 401；
10. 已建立连接/任务的关闭/取消尚不完整。

---

## 9. 安全边界

### 已有

- 设备 token 独立撤销；
- 只存哈希；
- 配对码单次占用；
- 批准界面显示声明名称/IP；
- 设备 token 路径白名单；
- 管理只走本机面板；
- `devices.json` 损坏 fail closed。

### 未提供

- 传输保密（HTTP 明文）；
- 客户端身份强绑定；
- 防中间人；
- 设备名/IP/UA 真实性验证；
- 配对码失败限流；
- HTTPS；
- 公网安全。

定位：

```text
可信家庭局域网
```

不要把 43121 暴露到公网。

### 遗留风险

- 共享 `authToken` 仍保留；
- 没有共享 token 时 `identifyAuth` 返回 open（历史行为）；
- 设备 token 通过 `custom_include_headers` / 直连 Authorization 转发，真实插件链路仍需验证；
- 面板批准后设备要等手机 ACK，期间显示为 pending；
- 面板不会自动轮询刷新。

---

## 10. 部署

### 桥接

退出 DSH Desktop 后：

```powershell
cd D:\AIGC\MOSS\ST-bridge
node deploy.mjs --check
node deploy.mjs --apply
```

启动后验证：

```powershell
$t = (Get-Content "$env:USERPROFILE\.dsh\st-bridge\settings.json" -Raw | ConvertFrom-Json).authToken
curl.exe http://127.0.0.1:43121/health -H "Authorization: Bearer $t"
```

### 扩展

```powershell
node install-tavern.mjs --extensions-dir "D:/download/SillyTavern-Launcher/SillyTavern/data/default-user/extensions" --apply
```

或从独立仓库安装：

```text
https://github.com/wuhehen176/ST-bridge-tavern
```

### 同步扩展仓库

```powershell
node tools/sync-tavern-repo.mjs
node tools/sync-tavern-repo.mjs --apply
```

---

## 11. 测试

```powershell
node --check client.js
node --check lib/pairing.js
node --check lib/server.js
node --test test/*.test.mjs
```

当前：

```text
176 tests / 176 pass
```

注意：全量测试偶发超时/并发 flaky，重跑通常通过。

---

## 12. 已知问题

1. 面板配对/设备列表不自动刷新，需重开设置或刷新页面。
2. 0.10.3 只改善“已批准，等待手机领取”的显示，没有自动轮询。
3. 配对码没有按 IP/次数限流。
4. 未 ACK 的 pending 设备 5 分钟后清理；重启立即失效。
5. 手机修改桥接地址会清空设备 token，需要重新配对。
6. 扩展全局只有一个默认 `client_id`/`task_id`，无法自动区分插件。
7. 玉子手机借用数据库 API 时，可能带数据库的 `dsh_session`，导致同 scope。
8. `/health` 需要 token；`401` 不代表网络失败。
9. 手机 5G/不同 Wi-Fi/VPN 无法访问 `192.168.3.47`。
10. ComfyUI 是独立 8188 端口，默认只监听 `127.0.0.1`。
11. 402 订阅错误通常来自上游供应商或插件回退端点，不是桥接本地错误。
12. `dsh_session.session_id` 缺失通常是上游请求失败导致没有建立会话。

---

## 13. 下一步

### P5 二维码/扫码

- 服务端生成二维码（内置 MIT 编码库，避免运行时依赖）；
- `/pair?v=1&code=...` 页面；
- 扩展拍照/相册扫码；
- 保留手动输入兜底；
- 二维码只放地址 + 一次性码，不放 token。

### P6 防火墙

- 检查规则端口/协议/方向/Profile/远端范围；
- 首次缺失规则时 UAC 提权创建；
- 规则存在则跳过；
- 失败回退手动命令。

### 体验

- 面板配对期间自动刷新；
- 配对码倒计时；
- 设备最后使用时间；
- 设备撤销关闭活动连接。

### 隔离

- 扩展增加“按聊天自动隔离”；
- 增加按插件/聊天映射 client_id；
- 或要求插件发送自己的 dsh_session。

### 安全

- 配对码失败限流；
- 设备 token 轮换/过期；
- 共享 authToken 可禁用；
- 端到端验证设备 token 在 Tavern 代理链路中生效。

---

## 14. 快速排查

```text
手机打不开 /health
  → Wi-Fi/5G、VPN、防火墙、IP 错

/health 返回 401
  → 网络通，token 没带或不对

/v1/models 401
  → 插件 API 密钥为空

extension selftest OK，插件失败
  → 插件走 Tauri 后端，和 WebView fetch 不同

配对后设备不显示
  → 面板未刷新；先看 devices.json state

devices.json pending_delivery
  → 电脑已批准，手机未领取/未 ACK

devices.json active
  → 配对成功

ComfyUI /system_stats 失败
  → ComfyUI 未开 --listen 0.0.0.0 或 8188 未放行

两个插件混会话
  → client_id + chat_id + task_id 相同
```

---

## 15. 交接检查清单

- [ ] 确认运行版本已部署到 0.11.0
- [ ] 备份 `settings.json` 与 `devices.json`
- [ ] 确认 43121 仅局域网访问
- [ ] 确认手机与电脑同一 Wi-Fi
- [ ] 确认扩展为 0.4.0
- [ ] 重新配对并验证设备 active
- [ ] 验证一条真实聊天
- [ ] 验证撤销设备后 401
- [ ] 记录当前插件 API 预设
- [ ] 决定是否继续 P5/P6
