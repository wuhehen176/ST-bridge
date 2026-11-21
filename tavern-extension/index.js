import { yaml } from '/lib.js'
import { installAdapter, localBase, PreviewCopies, scopeKey, validateMaterialsPolicy, mergeMaterialsPolicies } from './core.js?v=0.4.7'

const KEY = 'st_bridge_context_v1'
const ctx = () => window.SillyTavern.getContext()
const initial = ctx()
const settings = initial.extensionSettings[KEY] ||= { enabled: true, base: 'http://127.0.0.1:43121/v1', selections: {} }
settings.selections ||= {}
settings.materials ||= {}
settings.globalMaterials ||= {}
settings.autoInject ||= {
  enabled: true,
  clientId: 'yuzi-phone',
  taskId: 'default',
  prefix: 'stb-',
  overrideChatId: true,
  clients: ['shujuku', 'yuzi-phone'],
  fixedMessageCount: 0,
  fixedMessageTypes: [],
}
settings.deviceToken ||= ''
settings.pairDeviceName ||= 'TauriTavern'
const parseObject = text => JSON.parse(JSON.stringify(yaml.parse(text) ?? {}))
let entries = [], entriesChat = '', token = settings.deviceToken || '', profiles = [], lastScope = '', lastTrace = '', bridgeReceipts = [], render = () => {}
const previews = new Map()
const copies = new PreviewCopies()
const chatId = () => {
  const context = ctx()
  return String(context.getCurrentChatId?.() || context.chatId || context.chatMetadata?.chat_id || '')
}
const save = () => ctx().saveSettingsDebounced()
const serviceBase = () => `${new URL(localBase(settings.base)).origin}/v1`

async function readEndpoints(base = serviceBase(), authorization = token ? `Bearer ${token}` : '') {
  const response = await window.fetch(`${base}/bridge/capabilities`, {
    headers: authorization ? { authorization } : {}, cache: 'no-store', signal: AbortSignal.timeout(8000),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message || `读取插件接入清单失败（HTTP ${response.status}）`)
  if (!Array.isArray(data.client_endpoints)) throw new Error('桥接尚不支持插件专属地址，请先部署新版桥接')
  return data.client_endpoints
}

function reportWorldInfo(values, currentChat = chatId()) {
  if (!Array.isArray(values) || currentChat !== chatId()) return
  entries = values.filter(e => e && typeof e.content === 'string').map(e => {
    let content = e.content
    // Only ordinary macros; do not execute EJS or rescan lorebooks as a side effect.
    try { content = ctx().substituteParams?.(content) ?? content } catch { /* unknown source stays unclassified */ }
    return { content, uid: e.uid, world: e.world, comment: e.comment, constant: e.constant, disable: e.disable }
  }).slice(0, 4096)
  entriesChat = currentChat
}

const worldNames = () => [...new Set(ctx().getWorldInfoNames?.() || [...document.querySelectorAll('#world_editor_select option')].filter(o => o.value).map(o => o.textContent))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh'))
const expandEntry = (e, world, uid) => {
  let content = e.content
  try { content = ctx().substituteParams?.(content) ?? content } catch { /* Keep raw; uncertain macros will not match. */ }
  return { content, world, uid: e.uid ?? uid, comment: e.comment, constant: e.constant, disable: e.disable }
}
async function materials(session) {
  const selected = settings.materials[scopeKey(session)]
  const scopePolicy = selected?.enabled === true ? selected : {}
  const globalPolicy = settings.globalMaterials.enabled === true ? settings.globalMaterials : {}
  const policy = mergeMaterialsPolicies(globalPolicy, scopePolicy), currentChat = chatId()
  const activeEntries = entriesChat === currentChat ? entries : []
  const names = [...new Set([...policy.excluded, ...(policy.patterns.length ? worldNames() : [])])]
  const catalog = [], warnings = []
  if (names.length > 64) warnings.push('本次只读取前64本世界书，未读取内容保留；请缩小名单。')
  for (const name of names.slice(0, 64)) {
    try {
      const book = await ctx().loadWorldInfo?.(name)
      if (!book?.entries) { warnings.push(`无法读取世界书：${name}；未确认来源的内容保留。`); continue }
      for (const [uid, entry] of Object.entries(book.entries)) if (typeof entry.content === 'string' && entry.content.trim()) {
        if (catalog.length >= 4096) break
        catalog.push(expandEntry(entry, name, uid))
      }
    } catch { warnings.push(`读取世界书失败：${name}；相关内容保留。`) }
  }
  if (catalog.length >= 4096) warnings.push('条目读取达到4096条上限；未识别内容保留。')
  if (chatId() !== currentChat) throw new Error('读取材料期间聊天发生切换，已停止该请求，请在目标聊天重新发送')
  return { policy: scopePolicy, globalPolicy, catalog, entries: activeEntries, warnings }
}

const dispose = installAdapter(window, {
  enabled: () => settings.enabled,
  base: () => settings.base,
  selections: () => settings.selections,
  entries: () => entriesChat === chatId() ? entries : [],
  materials,
  autoInject: () => settings.autoInject,
  chatId: () => chatId(),
  deviceToken: () => settings.deviceToken,
  resolveEndpoint: async (id, { base, authorization }) => (await readEndpoints(base, authorization)).find(entry => entry.id === id),
  parseObject,
  onPreview(preview, body, detail) {
    lastScope = preview.scope
    lastTrace = preview.trace_id
    previews.set(lastTrace, { ...preview, verified: false })
    copies.set(lastTrace, detail)
    if (previews.size > 30) previews.delete(previews.keys().next().value)
    // Reuse a token only from the matching local bridge request, in memory only.
    try {
      const headers = typeof body.custom_include_headers === 'string' ? parseObject(body.custom_include_headers) : {}
      const auth = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
      if (typeof auth === 'string' && auth.startsWith('Bearer ')) token = auth.slice(7)
    } catch { /* the original transport still owns headers */ }
    render()
  },
  onResult(trace, audit, responseStatus, error, receipt, requestId) {
    if (previews.has(trace)) {
      const previous = previews.get(trace)
      previews.set(trace, { ...previous, ...(audit ? { audit } : {}), receipt,
        verified: receipt?.trace_id === trace && receipt?.messages_match === true && receipt?.messages_digest === previous.messages_digest,
        request_id: requestId || receipt?.request_id || previous.request_id, responseStatus, ...(error ? { error } : {}) })
    }
    render()
  },
})

const onActivated = values => reportWorldInfo(values)
const onChat = () => { entries = []; entriesChat = ''; lastScope = ''; lastTrace = ''; copies.clear(); render() }
initial.eventSource.on(initial.eventTypes.GENERATION_STARTED, () => { entries = []; entriesChat = '' })
initial.eventSource.on(initial.eventTypes.WORLD_INFO_ACTIVATED, onActivated)
initial.eventSource.on(initial.eventTypes.CHAT_CHANGED, onChat)
window.STBridgeContextAdapter = { reportWorldInfo, dispose, previews: () => structuredClone([...previews.values()]) }

async function api(path, body) {
  const response = await window.fetch(`${serviceBase()}/bridge/context/${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`)
  return result
}

function mount() {
  const parent = document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2')
  if (!parent || document.querySelector('#st-bridge-context-settings')) return
  const panel = document.createElement('div')
  panel.id = 'st-bridge-context-settings'
  panel.innerHTML = `<style>
    #st-bridge-context-settings {width:100%;min-width:0;box-sizing:border-box}
    #st-bridge-context-settings .inline-drawer-header {border:1px solid var(--SmartThemeBorderColor);border-radius:8px;padding:7px 9px;gap:8px}
    #st-bridge-context-settings .inline-drawer-header b {min-width:0;overflow-wrap:break-word}
    #st-bridge-context-settings .inline-drawer-icon {flex-shrink:0}
    #st-bridge-context-settings .stbc-body {display:flex;flex-direction:column;gap:8px;padding:10px 0;min-width:0}
    #st-bridge-context-settings .stbc-field {display:flex;flex-direction:column;gap:4px;min-width:0}
    #st-bridge-context-settings .stbc-check {display:flex;align-items:center;gap:8px}
    #st-bridge-context-settings .stbc-check input {flex-shrink:0;margin:0}
    #st-bridge-context-settings .text_pole {width:100%;min-width:0;max-width:100%;box-sizing:border-box;margin:0}
    #st-bridge-context-settings .menu_button {width:100%;max-width:100%;min-width:0;box-sizing:border-box;align-self:stretch;flex:none;margin:3px 0;padding:7px 10px;writing-mode:horizontal-tb;white-space:normal;word-break:normal;overflow-wrap:break-word}
    #st-bridge-context-settings details {min-width:0;width:100%}
    #st-bridge-context-settings pre {max-width:100%;min-width:0;box-sizing:border-box}
    #st-bridge-context-settings pre:empty {display:none}
    #st-bridge-context-settings .stbc-chip {display:inline-flex;align-items:center;gap:5px;border:1px solid var(--SmartThemeBorderColor);border-radius:16px;padding:4px 8px;margin:3px;background:transparent;color:inherit;max-width:100%;overflow-wrap:anywhere}
    #st-bridge-context-settings .stbc-box {border:1px solid var(--SmartThemeBorderColor);border-radius:8px;padding:10px;margin:6px 0}
    #st-bridge-context-settings details > summary {overflow-wrap:anywhere}
    #st-bridge-context-settings details[open] > summary {margin-bottom:8px}
    #st-bridge-context-settings .stbc-group {margin-top:12px}
    #st-bridge-context-settings .stbc-hint {display:block;line-height:1.45}
    #st-bridge-context-settings .stbc-feedback {font:inherit;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
    #st-bridge-context-settings .stbc-feedback:empty, #st-bridge-context-settings small:empty {display:none}
    #st-bridge-context-settings [hidden] {display:none}
    #st-bridge-context-settings dialog {width:min(90vw,650px);max-height:80vh;overflow:auto;background:var(--SmartThemeBlurTintColor,#202936);color:var(--SmartThemeBodyColor,#ddd);border:1px solid var(--SmartThemeBorderColor);border-radius:10px;padding:16px}
    #st-bridge-context-settings dialog::backdrop {background:#0009}
    #st-bridge-context-settings .stbc-books {max-height:45vh;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:8px 0}
    </style>
    <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>ST-bridge 本机上下文适配</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content"><div class="stbc-body">
    <label class="stbc-check"><input type="checkbox" data-id="enabled"><span>仅适配此桥接地址</span></label>
    <label class="stbc-field">桥接地址<input class="text_pole" data-id="base" placeholder="http://127.0.0.1:43121/v1" aria-describedby="stbc-address-error"></label>
    <p class="stbc-feedback" id="stbc-address-error" data-id="address-error" role="alert"></p>
    <button type="button" class="menu_button" data-id="load-endpoints">读取插件 API 地址</button>
    <pre data-id="endpoint-list" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre>
    <button type="button" class="menu_button" data-id="selftest">检查桥接连接</button>
    <pre data-id="selftest-status" style="white-space:pre-wrap;max-height:200px;overflow:auto"></pre>
    <details class="stbc-box"><summary>输入配对码</summary>
    <label class="stbc-field">设备名<input class="text_pole" data-id="pair-device" placeholder="TauriTavern / iPhone"></label>
    <label class="stbc-field">配对码<input class="text_pole" data-id="pair-code" placeholder="A7K9-2M4Q7X"></label>
    <button type="button" class="menu_button" data-id="pair-submit">提交配对</button>
    <button type="button" class="menu_button" data-id="pair-cancel">取消等待</button>
    <pre data-id="pair-status" style="white-space:pre-wrap;max-height:160px;overflow:auto"></pre>
    <small>在电脑的 ST-bridge 面板生成配对码。提交后回到电脑批准，设备令牌会自动保存。</small></details>
    <details class="stbc-box"><summary>按酒馆聊天自动隔离 DSH 会话</summary>
    <label class="stbc-check"><input type="checkbox" data-id="auto-enabled"><span>自动注入 dsh_session / 改写 chat_id</span></label>
    <small>插件专属地址自带插件身份。下方的默认 client_id 用于未提供 dsh_session 的通用 /v1 请求。</small>
    <label class="stbc-field">通用地址的默认 client_id<input class="text_pole" data-id="auto-client" placeholder="yuzi-phone"></label>
    <label class="stbc-field">默认 task_id<input class="text_pole" data-id="auto-task" placeholder="default"></label>
    <label class="stbc-field">chat_id 前缀<input class="text_pole" data-id="auto-prefix" placeholder="stb-"></label>
    <label class="stbc-check"><input type="checkbox" data-id="auto-override"><span>覆盖已有 chat_id（仅列出的 client）</span></label>
    <label class="stbc-field">覆盖的 client_id（逗号分隔）<input class="text_pole" data-id="auto-clients" placeholder="shujuku,yuzi-phone"></label>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <label class="stbc-field" style="flex:1;min-width:120px">固定规则条数<input class="text_pole" type="number" min="0" max="4" data-id="auto-fixed-count"></label>
      <label class="stbc-field" style="flex:1;min-width:120px">固定规则类型<input class="text_pole" data-id="auto-fixed-types" placeholder="prefix"></label>
    </div>
    <small>chat_id = 前缀 + 当前酒馆聊天 ID。空 chat_id 或宏未展开时不会注入。改写只对列出的 client 生效，柏宝绘不受影响。</small></details>
    <label class="stbc-field">桥接令牌<input class="text_pole" type="password" autocomplete="off" data-id="token" aria-describedby="stbc-token-help"></label>
    <small class="stbc-hint" id="stbc-token-help">配对后自动使用设备令牌。手动填写仅在当前页面有效。</small>
    <label class="stbc-field">请求范围<select class="text_pole" data-id="scope"></select></label>
    <label class="stbc-field">规则档位<select class="text_pole" data-id="profile"></select></label>
    <button type="button" class="menu_button" data-id="load">读取规则档位</button>
    <button type="button" class="menu_button" data-id="confirm-profile" hidden>更新所选档位</button>
    <p class="stbc-feedback" data-id="profile-status" role="status"></p>
    <details class="stbc-box"><summary>全局世界书排除</summary>
    <label class="stbc-check"><input type="checkbox" data-id="global-material-enabled"><span>启用全局排除</span></label>
    <small>适用于此桥接的所有插件和聊天，与当前范围的名单叠加。世界书触发沿用酒馆规则。名单保存在当前设备。</small>
    <button type="button" class="menu_button" data-id="global-edit-excluded">编辑全局整本排除名单</button><div data-id="global-excluded-chips"></div>
    <label class="stbc-field">全局按条目备注名过滤<input class="text_pole" data-id="global-pattern-draft" placeholder="普通文字包含匹配，简单正则如 /^规则/"></label>
    <button type="button" class="menu_button" data-id="global-add-pattern">添加全局条目名规则</button><div data-id="global-pattern-chips"></div>
    <small>只清理发送副本中可准确识别的动态 system 世界书条目；不拦截其它 API 地址，不修改原书。</small>
    <pre data-id="global-material-status" style="white-space:pre-wrap"></pre></details>
    <details class="stbc-box"><summary>当前范围的世界书与清洗</summary>
    <small data-id="material-scope"></small>
    <label class="stbc-check"><input type="checkbox" data-id="material-enabled"><span>启用当前范围的筛选与清洗</span></label>
    <div class="stbc-group"><b>世界书排除</b>
    <button type="button" class="menu_button" data-id="edit-excluded">编辑整本排除名单</button><div data-id="excluded-chips"></div>
    <label class="stbc-field">按条目备注名过滤<input class="text_pole" data-id="pattern-draft" placeholder="普通文字包含匹配，简单正则如 /^规则/"></label>
    <button type="button" class="menu_button" data-id="add-pattern">添加条目名规则</button><div data-id="pattern-chips"></div></div>
    <div class="stbc-group"><b>自定义清洗标签</b>
    <label class="stbc-field">标签名<input class="text_pole" data-id="tag-draft" placeholder="例如 snow，不填尖括号"></label>
    <button type="button" class="menu_button" data-id="add-tag">添加清洗标签</button><div data-id="tag-chips"></div>
    <small>发送副本移除成对标签及内容；孤立标签只移除标签本身。bbi_image 内置启用。</small></div>
    <small>只排除完整且唯一匹配的动态世界书条目。固定规则、聊天正文和原世界书都保留。</small>
    <pre data-id="material-status" style="white-space:pre-wrap"></pre></details>
    <details><summary>发送预览</summary>
    <label class="stbc-field">发送记录<select class="text_pole" data-id="attempt"></select></label>
    <p class="stbc-feedback" data-id="status" role="status"></p>
    <pre data-id="preview" style="white-space:pre-wrap;max-height:400px;overflow:auto"></pre></details>
    <details data-id="copy-details"><summary>发送副本与清理差异</summary>
    <small>副本记录浏览器发出的内容。历史和规则由 DSH 桥接继续处理。最多保留最近两份，每份上限 200 万字符，刷新后清空。</small>
    <textarea class="text_pole" rows="16" readonly data-id="actual-body" aria-label="发送副本与清理差异" hidden></textarea>
    <small class="stbc-hint" data-id="copy-help" hidden>已隐藏可识别的密钥，副本仍含聊天正文。分享前请检查。</small>
    <button type="button" class="menu_button" data-id="copy-body" hidden>复制发送副本</button>
    <p class="stbc-feedback" data-id="copy-status" role="status"></p></details>
    <details><summary>桥接收件记录</summary>
    <small>读取最近 60 条，含未携带适配标记的请求。读取记录不调用模型。</small>
    <button type="button" class="menu_button" data-id="receipts">读取收件记录</button>
    <p class="stbc-feedback" data-id="receipt-status" role="status"></p>
    <pre data-id="receipt-list" style="white-space:pre-wrap;max-height:400px;overflow:auto"></pre></details>
    <details><summary>导入规则档位</summary>
    <small>保存到桥接的档位库，不写入聊天。</small>
    <textarea class="text_pole" rows="8" data-id="import" placeholder='{"version":1,"profiles":[]}'></textarea>
    <button type="button" class="menu_button" data-id="save">校验并覆盖桥接档位库</button>
    <p class="stbc-feedback" data-id="import-status" role="status"></p>
    <small>仅允许替换明确的 spec/check 固定槽；prefix、contract 保留。正文/数据库没有这些槽时只能用完整兼容档，不猜测替换。</small></details>
    <dialog data-id="book-picker"><b data-id="picker-title"></b>
    <input class="text_pole" data-id="book-search" placeholder="搜索世界书名称">
    <div class="stbc-books" data-id="book-list"></div>
    <button type="button" class="menu_button" data-id="picker-cancel">取消</button>
    <button type="button" class="menu_button" data-id="picker-save">保存名单</button></dialog>
    </div></div></div>`
  parent.append(panel)
  const field = id => panel.querySelector(`[data-id="${id}"]`)
  const feedback = (id, text) => { field(id).textContent = text }
  const status = text => feedback('status', text)
  field('enabled').checked = settings.enabled
  field('base').value = settings.base
  field('enabled').onchange = event => { settings.enabled = event.target.checked; save() }
  field('base').onchange = event => {
    try {
      settings.base = localBase(event.target.value.trim())
      event.target.value = settings.base
      settings.deviceToken = ''; token = ''; profiles = []; previews.clear(); copies.clear(); bridgeReceipts = []; lastScope = ''; lastTrace = ''
      field('token').value = ''
      for (const id of ['address-error', 'profile-status', 'copy-status', 'receipt-status', 'import-status', 'status']) feedback(id, '')
      save(); render()
    } catch (error) {
      event.target.value = settings.base
      feedback('address-error', `${error.message}。已恢复上一次地址。`)
    }
  }
  field('token').oninput = event => { token = event.target.value }
  field('load-endpoints').onclick = async () => {
    try {
      const endpoints = await readEndpoints()
      const origin = new URL(serviceBase()).origin
      field('endpoint-list').textContent = endpoints.map(entry => `${entry.label}（${entry.enabled === false ? '已停用' : entry.taskId}）\n${origin}/clients/${entry.id}/v1`).join('\n\n') || '尚未登记插件，请在电脑ST-bridge面板“插件接入”中新增。'
    } catch (error) { field('endpoint-list').textContent = error.message }
  }
  field('selftest').onclick = async () => {
    const output = field('selftest-status')
    const lines = []
    const write = text => { output.textContent = [...lines, text].join('\n') }
    let base
    try {
      base = serviceBase()
    } catch (error) {
      output.textContent = `桥接地址无效：${error.message}`
      return
    }
    const origin = new URL(base).origin
    const headers = token ? { authorization: `Bearer ${token}` } : {}
    const timed = async (label, operation) => {
      const started = performance.now()
      try {
        const detail = await operation()
        lines.push(`${label}: OK  ${Math.round(performance.now() - started)}ms  ${detail}`)
      } catch (error) {
        lines.push(`${label}: FAIL  ${Math.round(performance.now() - started)}ms  ${error instanceof Error ? error.message : String(error)}`)
      }
      write('测试中…')
    }
    output.textContent = '测试中…'
    await timed('GET /health', async () => {
      const response = await fetch(`${origin}/health`, { cache: 'no-store', headers })
      return `HTTP ${response.status}`
    })
    await timed('POST /v1/bridge/selftest', async () => {
      const response = await fetch(`${base}/bridge/selftest`, {
        method: 'POST',
        cache: 'no-store',
        headers: { ...headers, 'content-type': 'application/json', 'x-stb-selftest': '1' },
        body: JSON.stringify({ ping: 1 }),
      })
      const data = await response.json().catch(() => ({}))
      return `HTTP ${response.status} auth_ok=${data.auth_ok} header=${data.test_header}`
    })
    await timed('GET /v1/bridge/selftest/stream', async () => {
      const response = await fetch(`${base}/bridge/selftest/stream`, {
        cache: 'no-store',
        headers: { ...headers, accept: 'text/event-stream' },
      })
      const text = await response.text()
      return `HTTP ${response.status} sse=${text.includes('data:')}`
    })
    write('完成')
  }
  {
    field('pair-device').value = settings.pairDeviceName
    field('pair-device').onchange = event => { settings.pairDeviceName = event.target.value.trim() || 'TauriTavern'; save() }
    let pairTimer = null
    let pairState = null
    const pairStatus = text => { field('pair-status').textContent = text }
    const stopPair = () => {
      if (pairTimer) clearTimeout(pairTimer)
      pairTimer = null
      pairState = null
    }
    const ackHeaders = state => ({
      'x-stb-pair-request': state.pairId,
      'x-stb-poll-token': state.pollToken,
    })
    const pollPair = async () => {
      pairTimer = null
      if (!pairState) return
      try {
        const response = await fetch(`${pairState.base}/bridge/pair/status`, {
          cache: 'no-store',
          headers: ackHeaders(pairState),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          pairStatus(`配对失败：${data.error?.message ?? response.status}`)
          stopPair()
          return
        }
        if (data.status === 'pending') {
          pairStatus('等待电脑批准…')
          pairTimer = setTimeout(pollPair, 1500)
          return
        }
        if (data.status === 'approved_pending_delivery' && data.deviceToken) {
          settings.deviceToken = data.deviceToken
          token = data.deviceToken
          save()
          try {
            await fetch(`${pairState.base}/bridge/pair/ack`, { method: 'POST', headers: ackHeaders(pairState) })
            pairStatus('已配对，设备令牌已保存。')
          } catch {
            pairStatus('设备令牌已保存，可以使用。配对回执发送失败。')
          }
          stopPair()
          return
        }
        pairStatus(`配对状态：${data.status}`)
        stopPair()
      } catch (error) {
        pairStatus(`配对失败：${error instanceof Error ? error.message : String(error)}`)
        stopPair()
      }
    }
    field('pair-submit').onclick = async () => {
      stopPair()
      let base
      try {
        base = serviceBase()
      } catch (error) {
        pairStatus(`桥接地址无效：${error.message}`)
        return
      }
      const code = field('pair-code').value.trim()
      if (!code) {
        pairStatus('请先输入配对码。')
        return
      }
      pairStatus('提交配对请求…')
      try {
        const response = await fetch(`${base}/bridge/pair/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code, device_name: settings.pairDeviceName }),
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          pairStatus(`配对失败：${data.error?.message ?? response.status}`)
          return
        }
        pairState = { base, pairId: data.pairId, pollToken: data.pollToken }
        pairStatus('已提交，等待电脑批准…')
        pairTimer = setTimeout(pollPair, 1000)
      } catch (error) {
        pairStatus(`提交失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    field('pair-cancel').onclick = () => {
      stopPair()
      pairStatus('已取消等待。')
    }
  }
  {
    const auto = settings.autoInject
    const set = (key, value) => { auto[key] = value; save() }
    field('auto-enabled').checked = auto.enabled === true
    field('auto-client').value = auto.clientId || 'yuzi-phone'
    field('auto-task').value = auto.taskId || 'default'
    field('auto-prefix').value = auto.prefix ?? 'stb-'
    field('auto-override').checked = auto.overrideChatId === true
    field('auto-clients').value = (auto.clients || ['shujuku', 'yuzi-phone']).join(',')
    field('auto-fixed-count').value = String(auto.fixedMessageCount ?? 0)
    field('auto-fixed-types').value = (auto.fixedMessageTypes || []).join(',')
    field('auto-enabled').onchange = event => set('enabled', event.target.checked)
    field('auto-client').onchange = event => set('clientId', event.target.value.trim() || 'yuzi-phone')
    field('auto-task').onchange = event => set('taskId', event.target.value.trim() || 'default')
    field('auto-prefix').onchange = event => set('prefix', event.target.value)
    field('auto-override').onchange = event => set('overrideChatId', event.target.checked)
    field('auto-clients').onchange = event => set('clients', event.target.value.split(/[\s,]+/).map(item => item.trim()).filter(Boolean))
    field('auto-fixed-count').onchange = event => set('fixedMessageCount', Math.max(0, Math.min(4, Number(event.target.value) || 0)))
    field('auto-fixed-types').onchange = event => set('fixedMessageTypes', event.target.value.split(/[\s,]+/).map(item => item.trim()).filter(Boolean))
  }
  function choices(select, values, selected) {
    select.replaceChildren(...values.map(([id, label]) => { const option = document.createElement('option'); option.value = id; option.textContent = label; return option }))
    select.value = selected
  }
  const materialStatus = (text, area = 'scope') => { field(area === 'global' ? 'global-material-status' : 'material-status').textContent = text }
  const policyNow = (area = 'scope') => validateMaterialsPolicy(area === 'global' ? settings.globalMaterials : settings.materials[lastScope])
  const saveMaterials = (key, values, area = 'scope') => {
    if (area !== 'global' && !lastScope) return
    try {
      const previous = (area === 'global' ? settings.globalMaterials : settings.materials[lastScope]) || {}
      const next = validateMaterialsPolicy({ ...previous, [key]: values })
      const updated = { ...next, enabled: previous.enabled === true }
      if (area === 'global') settings.globalMaterials = updated
      else settings.materials[lastScope] = updated
      save(); render(); materialStatus(`已保存${area === 'global' ? '全局' : '本范围'}名单；${updated.enabled ? '下一次请求生效' : '勾选启用后生效'}。可在发送预览里核对处理结果。`, area)
    } catch (error) { materialStatus(error.message, area) }
  }
  const chips = (id, key, items, area = 'scope') => {
    field(id).replaceChildren(...items.map(item => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'stbc-chip'
      button.textContent = item + ' ×'; button.title = '移除此项'; button.disabled = area !== 'global' && !lastScope
      button.onclick = () => saveMaterials(key, policyNow(area)[key].filter(value => value !== item), area)
      return button
    }))
  }
  let pickerArea = 'scope', pickerScope = '', pickerDraft = new Set(), pickerNames = []
  const renderBooks = () => {
    const query = field('book-search').value.trim().toLowerCase()
    const visible = pickerNames.filter(name => name.toLowerCase().includes(query))
    field('book-list').replaceChildren(...visible.map(name => {
      const row = document.createElement('label'); row.className = 'stbc-check'
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = pickerDraft.has(name)
      input.onchange = () => input.checked ? pickerDraft.add(name) : pickerDraft.delete(name)
      row.append(input, document.createTextNode(name)); return row
    }))
    if (!visible.length) field('book-list').textContent = '没有匹配的世界书。'
  }
  const openPicker = (area = 'scope') => {
    if (area !== 'global' && !lastScope) return
    pickerArea = area; pickerScope = lastScope; pickerDraft = new Set(policyNow(area).excluded); pickerNames = [...new Set([...worldNames(), ...pickerDraft])]
    field('picker-title').textContent = area === 'global' ? '编辑全局整本排除名单' : '编辑本范围整本排除名单'
    field('book-search').value = ''; renderBooks(); field('book-picker').showModal()
  }
  field('edit-excluded').onclick = () => openPicker()
  field('global-edit-excluded').onclick = () => openPicker('global')
  field('book-search').oninput = renderBooks
  field('picker-cancel').onclick = () => field('book-picker').close()
  field('picker-save').onclick = () => {
    if (pickerArea !== 'global' && lastScope !== pickerScope) { materialStatus('请求范围已切换，请重新打开名单编辑。'); field('book-picker').close(); return }
    saveMaterials('excluded', [...pickerDraft], pickerArea); field('book-picker').close()
  }
  field('global-material-enabled').onchange = event => {
    settings.globalMaterials = { ...policyNow('global'), enabled: event.target.checked }; save(); render()
  }
  field('material-enabled').onchange = event => {
    if (!lastScope) return
    settings.materials[lastScope] = { ...policyNow(), enabled: event.target.checked }; save(); render()
  }
  for (const [button, draft, key, area] of [['add-pattern', 'pattern-draft', 'patterns', 'scope'], ['add-tag', 'tag-draft', 'tags', 'scope'], ['global-add-pattern', 'global-pattern-draft', 'patterns', 'global']]) {
    field(button).onclick = () => {
      const value = field(draft).value.trim()
      if ((area !== 'global' && !lastScope) || !value) return
      try { validateMaterialsPolicy({ ...policyNow(area), [key]: [...policyNow(area)[key], value] }) }
      catch (error) { materialStatus(error.message, area); return }
      saveMaterials(key, [...policyNow(area)[key], value], area); field(draft).value = ''
    }
  }
  render = () => {
    const scopes = new Map([...previews.values()].map(p => [p.scope, `${p.client_id} / ${p.task_id} / ${p.chat_id}`]))
    for (const key of Object.keys(settings.materials)) {
      try { const [client, chat, task] = JSON.parse(key); if (!scopes.has(key)) scopes.set(key, `${client} / ${task} / ${chat}`) } catch { /* Ignore malformed old scope IDs. */ }
    }
    if (!lastScope && scopes.size) lastScope = scopes.keys().next().value
    choices(field('scope'), scopes.size ? [...scopes] : [['', '发送请求后可选']], lastScope)
    field('scope').disabled = scopes.size === 0
    const policy = policyNow(), globalPolicy = policyNow('global')
    field('global-material-enabled').checked = settings.globalMaterials.enabled === true
    chips('global-excluded-chips', 'excluded', globalPolicy.excluded, 'global'); chips('global-pattern-chips', 'patterns', globalPolicy.patterns, 'global')
    field('material-scope').textContent = lastScope ? `当前范围：${scopes.get(lastScope)}` : '先通过此桥接发送一次请求，即可选择范围并设置。'
    field('material-enabled').checked = settings.materials[lastScope]?.enabled === true
    for (const id of ['material-enabled', 'edit-excluded', 'add-pattern', 'add-tag', 'pattern-draft', 'tag-draft']) field(id).disabled = !lastScope
    chips('excluded-chips', 'excluded', policy.excluded); chips('pattern-chips', 'patterns', policy.patterns); chips('tag-chips', 'tags', policy.tags)
    const attempts = [...previews.values()].filter(p => p.scope === lastScope).reverse()
    if (!attempts.some(p => p.trace_id === lastTrace)) lastTrace = attempts[0]?.trace_id || ''
    const current = previews.get(lastTrace)
    choices(field('attempt'), attempts.length
      ? attempts.map(p => [p.trace_id, `${p.sent_at.slice(11, 19)} · ${p.request_id || p.trace_id} · ${p.responseStatus || '等待中'}`])
      : [['', '暂无发送记录']], lastTrace)
    field('attempt').disabled = attempts.length === 0
    field('receipt-list').textContent = bridgeReceipts.length ? JSON.stringify(bridgeReceipts, null, 2) : ''
    const showCopy = () => {
      const text = copies.get(lastTrace)
      field('actual-body').value = text || ''
      for (const id of ['actual-body', 'copy-help', 'copy-body']) field(id).hidden = !text
      feedback('copy-status', text ? '' : current ? '这次请求的副本已过期或未保留。' : '暂无发送副本。')
    }
    field('copy-details').ontoggle = () => { if (field('copy-details').open) showCopy(); else field('actual-body').value = '' }
    if (field('copy-details').open) showCopy()
    const available = profiles.filter(p => p.client_id === current?.client_id && p.task_id === current?.task_id)
    const selection = settings.selections[lastScope]
    const selected = typeof selection === 'string' ? selection : selection?.id || 'original'
    const selectedProfile = available.find(p => p.id === selected)
    const values = [['original', '完整兼容（原始规则）'], ...available.map(p => [p.id, p.label])]
    if (selected !== 'original' && !available.some(p => p.id === selected)) values.push([selected, `${selected}（请连接桥接核对）`])
    choices(field('profile'), values, selected)
    field('profile').disabled = !current
    field('confirm-profile').hidden = !current || !selectedProfile || selectedProfile.hash === selection?.hash
    if (!current) {
      status('')
      field('preview').textContent = '暂无此桥接的生成记录。通过插件发起生成后可查看。'
      return
    }
    field('preview').textContent = JSON.stringify(current, null, 2)
    const cleaned = (current.cleanup?.removed_chars > 0 ? `已清理 ${current.cleanup.removed_regions} 处标签／块，减少 ${current.cleanup.removed_chars} 字符；` : '') + (current.worldbook_filter?.removed_chars > 0 ? `世界书过滤减少 ${current.worldbook_filter.removed_chars} 字符；` : '')
    status(current.error ? `本次未完成：${current.error}` : current.verified ? `${cleaned}桥接本次收件回执已匹配：trace 与 messages 摘要一致。${current.receipt.status === 'received' ? '生成仍在处理中。' : ''}` : current.receipt?.messages_match === false ? `${cleaned}桥接已收到，但消息摘要不同；请核对代理后处理，不能据客户端预览确认最终消息。` : current.responseStatus ? `${cleaned}尚无本次匹配回执；桥接可能未升级或代理未透传字段，可读取桥接收件记录核对。` : `${cleaned}已记录客户端发送副本；可读取收件记录，无需等生成完成。`)
  }
  field('scope').onchange = event => { lastScope = event.target.value; feedback('profile-status', ''); render() }
  field('attempt').onchange = event => { lastTrace = event.target.value; render() }
  field('copy-body').onclick = async () => {
    const text = copies.get(lastTrace)
    if (!text) { feedback('copy-status', '这次请求的副本已过期或未保留。'); return }
    try { await navigator.clipboard.writeText(text); feedback('copy-status', '已复制发送副本。') }
    catch { field('actual-body').focus(); field('actual-body').select(); feedback('copy-status', '剪贴板不可用，可手动复制。') }
  }
  field('receipts').onclick = async () => {
    const button = field('receipts')
    button.disabled = true
    feedback('receipt-status', '正在读取收件记录…')
    try {
      bridgeReceipts = (await api('receipts')).receipts
      for (const receipt of bridgeReceipts) {
        const previous = previews.get(receipt.trace_id)
        if (previous) previews.set(receipt.trace_id, { ...previous, receipt, request_id: receipt.request_id || previous.request_id,
          verified: receipt.messages_match === true && receipt.messages_digest === previous.messages_digest })
      }
      render()
      feedback('receipt-status', bridgeReceipts.length ? `已读取 ${bridgeReceipts.length} 条收件记录。` : '桥接暂无收件记录。')
    } catch (error) { feedback('receipt-status', `读取收件记录失败：${error.message}`) }
    finally { button.disabled = false }
  }
  const selectProfile = () => {
    if (field('profile').disabled) return
    const id = field('profile').value
    const profile = profiles.find(p => p.id === id)
    if (id !== 'original' && !profile) { feedback('profile-status', '请先读取当前规则档位。'); return }
    settings.selections[lastScope] = id === 'original' ? 'original' : { id, hash: profile.hash }
    save(); render(); feedback('profile-status', '已保存当前范围的档位，下次请求生效。')
  }
  field('profile').onchange = selectProfile
  field('confirm-profile').onclick = selectProfile
  field('load').onclick = async () => {
    try {
      profiles = (await api('profiles')).profiles
      render()
      feedback('profile-status', field('confirm-profile').hidden ? `已读取 ${profiles.length} 个档位。` : '所选档位有更新。确认后，下次请求使用新版。')
    } catch (error) { feedback('profile-status', `读取档位失败：${error.message}。请核对桥接地址和令牌。`) }
  }
  field('save').onclick = async () => {
    try {
      const body = JSON.parse(field('import').value)
      if (!window.confirm('覆盖本机桥接规则档位库？已有文件会备份；不修改聊天或世界书。')) return
      profiles = (await api('profiles', body)).profiles
      field('import').value = ''; render(); feedback('import-status', '已保存档位库。请选择请求范围和档位，下次请求生效。')
    } catch (error) { feedback('import-status', `未保存：${error.message}`) }
  }
  render()
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
else mount()
