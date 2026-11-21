window.__ModuleLoader__.load({
  id: 'ST-bridge',
  factory(require) {
    const __modules = {}
    const __cache = {}
    __modules["./theme.js"] = function (module, exports, require) {
const CSS = `
.bbh { display:grid; gap:16px; width:100%; max-width:860px; min-width:0; font-size:13px; line-height:1.55; color:inherit;
  --bbh-accent:#4d6bfe; --bbh-accent-soft:rgba(77,107,254,.08); --bbh-line:rgba(127,127,127,.24);
  --bbh-fill:rgba(127,127,127,.07); --bbh-solid:Canvas; --bbh-danger:#e5484d; --bbh-ok:#1a9f60; }
.bbh * { box-sizing:border-box; }
.bbh-head { display:grid; gap:3px; }
.bbh-title { margin:0; font-size:17px; font-weight:650; }
.bbh-tabs { display:flex; gap:4px; flex-wrap:wrap; border-bottom:1px solid var(--bbh-line); padding-bottom:7px; }
.bbh-tab { appearance:none; font:inherit; color:inherit; background:transparent; border:0; border-radius:7px; padding:6px 10px; cursor:pointer; opacity:.65; }
.bbh-tab:hover { background:var(--bbh-fill); opacity:1; }
.bbh-tab.is-on { background:var(--bbh-accent-soft); color:var(--bbh-accent); opacity:1; font-weight:600; }
.bbh-card { display:grid; gap:12px; padding:14px; border:1px solid var(--bbh-line); border-radius:12px; min-width:0; }
.bbh-card-title { margin:0; font-size:14px; font-weight:600; }
.bbh-box { display:grid; gap:10px; }
.bbh-note { margin:0; font-size:12px; opacity:.58; }
.bbh-grid2 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.bbh-field { display:grid; gap:4px; min-width:0; align-content:start; }
.bbh-field > span { font-size:12px; opacity:.7; }
.bbh-field > small { line-height:1.35; }
.bbh-input, .bbh-textarea, .bbh-select { width:100%; min-height:34px; box-sizing:border-box; font:inherit; color:inherit; background:var(--bbh-fill); border:1px solid var(--bbh-line); border-radius:8px; padding:7px 9px; outline:none; }
.bbh-input:focus, .bbh-textarea:focus, .bbh-select:focus { border-color:var(--bbh-accent); }
.bbh-textarea { min-height:80px; resize:vertical; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
.bbh-check-row { display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
.bbh-check { display:flex; align-items:flex-start; gap:8px; font-size:13px; cursor:pointer; }
.bbh-check input { font:inherit; margin-top:3px; accent-color:var(--bbh-accent); }
.bbh-check span { display:grid; gap:1px; }
.bbh-check small { font-size:12px; opacity:.55; }
.bbh-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.bbh-btn { appearance:none; font:inherit; font-size:13px; color:#fff; background:var(--bbh-accent); border:0; border-radius:8px; padding:6px 14px; cursor:pointer; }
.bbh-btn:hover:not(:disabled) { background:#3d5bf0; }
.bbh-btn:disabled { opacity:.45; cursor:default; }
.bbh-btn.secondary { color:inherit; background:var(--bbh-fill); border:1px solid var(--bbh-line); }
.bbh-btn.secondary:hover:not(:disabled) { background:rgba(127,127,127,.14); }
.bbh-btn.danger { background:var(--bbh-danger); }
.bbh-btn.danger:hover:not(:disabled) { background:#c93b40; }
.bbh-status { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 10px; border-radius:8px; background:var(--bbh-fill); }
.bbh-savebar { position:sticky; top:0; z-index:6; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; padding:8px 10px; border:1px solid var(--bbh-line); border-radius:10px; background:var(--bbh-solid); }
.bbh-savebar-state { font-size:12px; font-weight:550; }
.bbh-dot { width:8px; height:8px; border-radius:50%; background:var(--bbh-ok); flex:none; }
.bbh-dot.off { background:var(--bbh-danger); }
.bbh-status-meta { font-size:12px; opacity:.8; overflow-wrap:anywhere; }
.bbh-error { margin:0; padding:9px 12px; border-radius:9px; color:var(--bbh-danger); background:rgba(229,72,77,.08); white-space:pre-wrap; }
.bbh-notice { margin:0; padding:9px 12px; border-radius:9px; background:var(--bbh-fill); white-space:pre-wrap; overflow-wrap:anywhere; }
.bbh-list { display:grid; gap:8px; }
.bbh-item { display:flex; gap:12px; align-items:flex-start; padding:10px 12px; border:1px solid var(--bbh-line); border-radius:10px; min-width:0; }
.bbh-item-main { flex:1; min-width:0; display:grid; gap:2px; }
.bbh-item-title { font-weight:550; overflow-wrap:anywhere; }
.bbh-item-sub, .bbh-item-meta { margin:0; font-size:12px; opacity:.75; overflow-wrap:anywhere; }
.bbh-item-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.bbh-pre { margin:0; padding:10px 12px; border-radius:9px; background:var(--bbh-fill); max-height:300px; overflow:auto; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
.bbh-kv { display:grid; grid-template-columns:auto minmax(0,1fr); gap:4px 12px; font-size:12px; }
.bbh-kv > span:nth-child(odd) { opacity:.55; }
.bbh-kv > span:nth-child(even) { overflow-wrap:anywhere; }
.bbh-danger-card { border-color:rgba(229,72,77,.35); }
.bbh-danger-card .bbh-card-title { color:var(--bbh-danger); }
.bbh-fold summary { cursor:pointer; opacity:.7; font-size:12px; }
.bbh-fold[open] summary { margin-bottom:8px; }
@media (max-width:640px) { .bbh-grid2 { grid-template-columns:1fr; } .bbh-item { flex-direction:column; } .bbh-item-actions { justify-content:flex-start; } }
`

module.exports = { CSS }

    }
    __modules["./helpers.js"] = function (module, exports, require) {
const React = require('react')
const h = React.createElement

    function failureText(result) {
      if (!result) return 'RPC 失败'
      if (result.error?.message) return String(result.error.message)
      return String(result)
    }

    function shortSession(value) {
      if (!value) return '—'
      const text = String(value)
      return text.length > 22 ? `${text.slice(0, 12)}…${text.slice(-6)}` : text
    }

    function Field(props) {
      return h('label', { className: 'bbh-field' },
        h('span', null, props.label),
        props.children,
        props.hint ? h('small', { className: 'bbh-note' }, props.hint) : null,
      )
    }

    function Check(props) {
      return h('label', { className: 'bbh-check' },
        h('input', { type: 'checkbox', checked: props.checked === true, onChange: event => props.onChange(event.target.checked) }),
        h('span', null, props.label, props.hint ? h('small', null, props.hint) : null),
      )
    }

    function formFrom(status) {
      return {
        host: status?.service?.host ?? '127.0.0.1',
        port: String(status?.service?.port ?? ''),
        requestTimeoutMs: String(status?.service?.requestTimeoutMs ?? 1800000),
        maxBodyBytes: String(status?.service?.maxBodyBytes ?? 33554432),
        authToken: '',
        clearAuthToken: false,
        allowLegacyPlain: status?.service?.allowLegacyPlain === true,
        sessionOnStale: status?.service?.sessionOnStale === 'recreate',
        sessionOnArchived: status?.service?.sessionOnArchived === 'recreate',
        contextOverflow: status?.service?.contextOverflow === 'recreate',
        transientRetry: String(status?.service?.transientRetry ?? 0),
        allowRemote: status?.service?.allowRemote === true,
        allowExtensionOrigins: status?.service?.allowExtensionOrigins !== false,
        allowNullOrigin: status?.service?.allowNullOrigin === true,
        corsText: (status?.service?.corsOrigins ?? []).join('\n'),
        allowedClientsText: (status?.service?.allowedClientIds ?? []).join('\n'),
        clientEndpoints: (status?.service?.clientEndpoints ?? []).map(entry => ({ ...entry })),
        plainCompatEnabled: status?.service?.plainCompat?.enabled === true,
        plainCompatClientId: status?.service?.plainCompat?.clientId ?? 'yuzi-phone',
        plainCompatChatId: status?.service?.plainCompat?.chatId ?? 'yuzi-phone',
        plainCompatTaskId: status?.service?.plainCompat?.taskId ?? 'default',
        plainCompatFixedCount: String(status?.service?.plainCompat?.fixedMessageCount ?? 0),
        plainCompatFixedTypes: (status?.service?.plainCompat?.fixedMessageTypes ?? []).join(','),
        inputCleanupEnabled: status?.service?.inputCleanup?.enabled !== false,
        inputCleanupTags: (status?.service?.inputCleanup?.tags ?? []).join(','),
        defaultInputCleanupTags: status?.service?.defaults?.inputCleanupTags ?? [],
        snapshotEnabled: status?.service?.snapshotDiff?.enabled === true,
        snapshotMode: status?.service?.snapshotDiff?.mode ?? 'auto',
        snapshotMaxBlockChars: String(status?.service?.snapshotDiff?.maxBlockChars ?? 2000),
        snapshotMarker: status?.service?.snapshotDiff?.marker ?? '',
        snapshotClientsText: (status?.service?.snapshotDiff?.clients ?? ['shujuku', 'yuzi-phone']).join(','),
        snapshotDivergence: status?.service?.snapshotDiff?.onDivergence ?? 'full',
        systemSnapshotMode: status?.service?.systemSnapshot?.mode ?? '',
        systemSnapshotModes: status?.service?.systemSnapshot?.modes ?? [],
        appendFormat: status?.service?.appendFormat ?? 'nonce',
        appendNonce: status?.service?.appendNonce ?? '7F3A9C2E',
      }
    }

module.exports = { failureText, shortSession, Field, Check, formFrom }

    }
    __modules["./endpoints.js"] = function (module, exports, require) {
const React = require('react')
const h = React.createElement

function renderEndpoints(c) {
  const {
    Field, Check, status, form, endpointBase, setEndpointBase, setField,
    modelCatalog, workspaceOptions, agentPresetField, setNotice, setError,
  } = c
  return h('div', { className: 'bbh' },
    h('h3', { className: 'bbh-card-title' }, '插件专属接入地址'),
    h('p', { className: 'bbh-note' }, '每个插件使用独立的 API 地址。模型、预设和工作区的变更在新会话中生效。'),
    h(Field, { label: 'API 地址使用的主机', hint: '手机连接请选择局域网地址。127.0.0.1 仅供本机使用。' },
      h('select', { className: 'bbh-select', value: endpointBase || status.network?.urls?.[0] || `http://127.0.0.1:${status.service.port}/v1`, onChange: e => setEndpointBase(e.target.value) },
        [...new Set([...(status.network?.urls ?? []), `http://127.0.0.1:${status.service.port}/v1`])].map(value => h('option', { key: value, value }, value)))),
    ...form.clientEndpoints.map((entry, index) => {
      const update = patch => setField('clientEndpoints', form.clientEndpoints.map((item, i) => i === index ? { ...item, ...patch } : item))
      const origin = (endpointBase || status.network?.urls?.[0] || `http://127.0.0.1:${status.service.port}/v1`).replace(/\/v1\/?$/, '')
      const address = `${origin}/clients/${entry.id}/v1`
      const modelValue = entry.provider && entry.model ? JSON.stringify({ provider: entry.provider, model: entry.model }) : ''
      const knownModel = (modelCatalog?.providers ?? []).some(provider =>
        provider.id === entry.provider && provider.models?.some(model => model.id === entry.model))
      const modelOptions = [
        h('option', { key: 'empty', value: '' }, '跟随 DSH 默认'),
        ...(modelValue && !knownModel
          ? [h('option', { key: 'current', value: modelValue }, `${entry.provider} / ${entry.model}（当前）`)]
          : []),
        ...(modelCatalog?.providers ?? []).map(provider => h('optgroup', {
          key: provider.id,
          label: provider.name || provider.id,
        }, ...(provider.models ?? []).map(model => h('option', {
          key: `${provider.id}/${model.id}`,
          value: JSON.stringify({ provider: provider.id, model: model.id }),
          title: model.description || undefined,
        }, model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id)))),
      ]
      const modelHint = modelCatalog === null
        ? '正在读取 DSH 模型列表…'
        : modelCatalog.available === false
          ? `无法读取 DSH 模型列表：${modelCatalog.error || '未知错误'}`
          : modelCatalog.default
            ? `当前默认模型为 ${modelCatalog.default.provider} / ${modelCatalog.default.model}。`
            : ''
      const knownWorkspace = (workspaceOptions?.workspaces ?? []).some(workspace => workspace.path === entry.cwd)
      const workspaceHint = workspaceOptions === null
        ? '正在读取 DSH 工作区…'
        : workspaceOptions.available === false
          ? `无法读取 DSH 工作区：${workspaceOptions.error || '未知错误'}`
          : '留空使用 DSH 的首个工作区；新会话挂载到所选工作区。'
      return h('div', { className: 'bbh-card', key: index },
        h('div', { className: 'bbh-grid2' },
          h(Field, { label: '显示名称' }, h('input', { className: 'bbh-input', value: entry.label, onChange: e => update({ label: e.target.value }) })),
          h(Field, { label: '唯一插件 ID', hint: '小写字母、数字、下划线或短横线；修改 ID 会使用新的会话范围，旧历史保留。' }, h('input', { className: 'bbh-input', value: entry.id, onChange: e => update({ id: e.target.value }) })),
          h(Field, { label: '固定 chat_id（可选）', hint: '留空则使用酒馆当前聊天 ID；填写后该插件始终使用这个 ID，适合论坛等没有聊天上下文的页面。修改会切换到新的会话范围，旧历史保留。' },
            h('input', { className: 'bbh-input', value: entry.fixedChatId ?? '', onChange: e => update({ fixedChatId: e.target.value }) })),
          h(Field, { label: '专属 Skill（可选）', hint: 'kebab-case 名称；修改后已有会话需重置才能切换。' },
            h('input', { className: 'bbh-input', value: entry.skillId ?? '', onChange: e => update({ skillId: e.target.value.trim() }) }))),
        h('div', { className: 'bbh-grid2' },
          h(Field, { label: '模型', hint: modelHint },
            h('select', {
              className: 'bbh-select',
              value: modelValue,
              onChange: e => {
                if (!e.target.value) return update({ provider: '', model: '' })
                try {
                  const selected = JSON.parse(e.target.value)
                  update({ provider: selected.provider, model: selected.model })
                } catch {
                  update({ provider: '', model: '' })
                }
              },
            }, ...modelOptions)),
          agentPresetField({
            value: entry.agentPreset ?? '',
            onChange: agentPreset => update({ agentPreset }),
          })),
        h('div', { className: 'bbh-grid2' },
          h(Field, { label: '工作区 cwd', hint: workspaceHint },
            h('select', {
              className: 'bbh-select',
              value: entry.cwd ?? '',
              onChange: e => update({ cwd: e.target.value }),
            },
            h('option', { value: '' }, '跟随 DSH 默认'),
            ...(entry.cwd && !knownWorkspace ? [h('option', { key: 'current', value: entry.cwd }, `${entry.cwd}（当前）`)] : []),
            ...(workspaceOptions?.workspaces ?? []).map(workspace => h('option', { key: workspace.path, value: workspace.path }, workspace.name || workspace.path)))),
          h(Field, { label: 'max_tokens', hint: '留空使用模型 / DSH 默认；单次请求携带的 max_tokens 优先。' },
            h('input', { className: 'bbh-input', type: 'number', min: 1, value: entry.maxTokens ?? '', onChange: e => update({ maxTokens: e.target.value }) }))),
        h('div', { className: 'bbh-check-row' },
          h(Check, { label: '启用此接入', checked: entry.enabled, onChange: enabled => update({ enabled }) }),
          h(Check, {
            label: '持续会话',
            checked: entry.persistentSession === true,
            onChange: persistentSession => update({ persistentSession }),
          })),
        h('p', { className: 'bbh-note' }, '持续会话让同一插件的聊天共用 DSH 窗口，快照仍按聊天隔离。最近一次同步的固定规则生效。切换会清除旧绑定，保留 DSH 历史。'),
        h(Field, { label: '插件 API 地址' }, h('input', { className: 'bbh-input', value: address, readOnly: true })),
        h('div', { className: 'bbh-actions' },
          h('button', { type: 'button', className: 'bbh-btn secondary', onClick: async () => {
            try { await navigator.clipboard.writeText(address); setNotice('地址已复制；新增或修改接入后请先保存，再用于插件。') }
            catch { setError('剪贴板不可用，请手动复制上方地址。') }
          } }, '复制 API 地址'),
          h('button', { type: 'button', className: 'bbh-btn secondary', onClick: () => setField('clientEndpoints', form.clientEndpoints.filter((_, i) => i !== index)) }, '删除接入')),
      )
    }),
    h('div', { className: 'bbh-actions' },
      h('button', { type: 'button', className: 'bbh-btn secondary', onClick: () => setField('clientEndpoints', [...form.clientEndpoints, { id: '', label: '', taskId: 'default', fixedChatId: '', skillId: '', enabled: true, persistentSession: false }]) }, '新增插件接入')),
    h('p', { className: 'bbh-note' }, '停用或删除只影响该地址的新请求，不删除 Agent 历史、不取消正在执行的任务。若设置了允许 client_id 列表，还需允许相应插件 ID。'),
  )
}

module.exports = { renderEndpoints }

    }
    __modules["./panel.js"] = function (module, exports, require) {
const React = require('react')
const h = React.createElement
const { CSS } = require('./theme.js')
const { failureText, shortSession, Field, Check, formFrom } = require('./helpers.js')
const { renderEndpoints } = require('./endpoints.js')

function needsRestart(status) {
  if (!status?.active) return false
  const { active, service } = status
  return active.host !== service.host || (service.port !== 0 && active.port !== service.port)
}

    function Panel(props) {
      const rpcRef = React.useRef(props.rpcCall)
      rpcRef.current = props.rpcCall
      const [status, setStatus] = React.useState(null)
      const [form, setForm] = React.useState(formFrom(null))
      const [tab, setTab] = React.useState('general')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [rules, setRules] = React.useState(null)
      const rulesRef = React.useRef(null)
      const [filter, setFilter] = React.useState('')
      const [dangerText, setDangerText] = React.useState('')
      const [rawText, setRawText] = React.useState('')
      const [rawLoaded, setRawLoaded] = React.useState(false)
      const [presets, setPresets] = React.useState(null)
      const [agentPresetOptions, setAgentPresetOptions] = React.useState(null)
      const [modelCatalog, setModelCatalog] = React.useState(null)
      const [workspaceOptions, setWorkspaceOptions] = React.useState(null)
      const [endpointBase, setEndpointBase] = React.useState('')
      const [savedFingerprint, setSavedFingerprint] = React.useState('')

      const rpc = React.useCallback(async (endpoint, payload = {}) => {
        const result = await rpcRef.current(endpoint, payload)
        if (!result || result.ok !== true) throw new Error(failureText(result))
        return result.value
      }, [])

      const load = React.useCallback(async () => {
        try {
          const value = await rpc('status')
          const next = formFrom(value)
          setStatus(value)
          setForm(next)
          setSavedFingerprint(JSON.stringify(next))
          setError('')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }, [rpc])

      React.useEffect(() => { void load() }, [load])

      React.useEffect(() => {
        rulesRef.current?.scrollIntoView({ block: 'nearest' })
      }, [rules, tab])

      React.useEffect(() => {
        if (tab !== 'general' || !status?.pairing?.invite) return
        let cancelled = false
        let timer
        const poll = async () => {
          try {
            const value = await rpc('status')
            if (!cancelled) setStatus(value)
          } catch { /* keep the last known pairing state */ }
          if (!cancelled) timer = setTimeout(poll, 3000)
        }
        timer = setTimeout(poll, 3000)
        return () => { cancelled = true; clearTimeout(timer) }
      }, [tab, status?.pairing?.invite?.code, rpc])

      React.useEffect(() => {
        if (tab !== 'advanced' || rawLoaded) return
        let cancelled = false
        void (async () => {
          try {
            const value = await rpc('raw')
            if (!cancelled) {
              setRawText(JSON.stringify(value.settings, null, 2))
              setRawLoaded(true)
            }
          } catch (err) {
            if (!cancelled) setError(err instanceof Error ? err.message : String(err))
          }
        })()
        return () => { cancelled = true }
      }, [tab, rawLoaded, rpc])

      React.useEffect(() => {
        if (tab !== 'endpoints') return
        let cancelled = false
        void (async () => {
          const [presetResult, catalogResult, workspaceResult] = await Promise.allSettled([
            rpc('agent_presets'),
            rpc('model_catalog'),
            rpc('workspaces'),
          ])
          if (cancelled) return
          setAgentPresetOptions(presetResult.status === 'fulfilled'
            ? presetResult.value
            : { available: false, presets: [], error: failureText({ error: { message: presetResult.reason?.message ?? presetResult.reason } }) })
          setModelCatalog(catalogResult.status === 'fulfilled'
            ? catalogResult.value
            : { available: false, providers: [], default: null, error: catalogResult.reason?.message ?? String(catalogResult.reason ?? '') })
          setWorkspaceOptions(workspaceResult.status === 'fulfilled'
            ? workspaceResult.value
            : { available: false, current: '', workspaces: [], error: workspaceResult.reason?.message ?? String(workspaceResult.reason ?? '') })
        })()
        return () => { cancelled = true }
      }, [tab, rpc])

      const setField = (key, value) => setForm(current => ({ ...current, [key]: value }))

      const run = async (label, operation) => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const message = await operation()
          setNotice(message ?? '')
          await load()
          return true
        } catch (err) {
          setError(`${label}失败：${err instanceof Error ? err.message : String(err)}`)
          return false
        } finally {
          setBusy(false)
        }
      }

      const save = () => run('保存设置', async () => {
        const payload = {
          host: form.host.trim(),
          port: Number(form.port),
          requestTimeoutMs: Number(form.requestTimeoutMs),
          maxBodyBytes: Number(form.maxBodyBytes),
          allowLegacyPlain: form.allowLegacyPlain,
          sessionOnStale: form.sessionOnStale ? 'recreate' : 'error',
          sessionOnArchived: form.sessionOnArchived ? 'recreate' : 'error',
          contextOverflow: form.contextOverflow ? 'recreate' : 'error',
          transientRetry: Number(form.transientRetry) || 0,
          allowRemote: form.allowRemote,
          allowExtensionOrigins: form.allowExtensionOrigins,
          allowNullOrigin: form.allowNullOrigin,
          corsOrigins: form.corsText.split(/[\n,]+/).map(item => item.trim()).filter(Boolean),
          allowedClientIds: form.allowedClientsText.split(/[\n,]+/).map(item => item.trim()).filter(Boolean),
          clientEndpoints: form.clientEndpoints.map(entry => ({
            ...entry,
            provider: String(entry.provider ?? '').trim(),
            model: String(entry.model ?? '').trim(),
            agentPreset: String(entry.agentPreset ?? '').trim(),
            cwd: String(entry.cwd ?? '').trim(),
            maxTokens: entry.maxTokens === '' || entry.maxTokens == null ? null : Number(entry.maxTokens),
          })),
          plainCompat: {
            enabled: form.plainCompatEnabled,
            clientId: form.plainCompatClientId.trim() || 'yuzi-phone',
            chatId: form.plainCompatChatId.trim() || 'yuzi-phone',
            taskId: form.plainCompatTaskId.trim() || 'default',
            fixedMessageCount: Number(form.plainCompatFixedCount) || 0,
            fixedMessageTypes: form.plainCompatFixedTypes.split(/[\n,]+/).map(item => item.trim()).filter(Boolean),
          },
          inputCleanup: {
            enabled: form.inputCleanupEnabled,
            tags: form.inputCleanupTags.split(/[\n,]+/).map(item => item.trim()).filter(Boolean),
          },
          snapshotDiff: {
            enabled: form.snapshotEnabled,
            mode: form.snapshotMode === 'marker' ? 'marker' : 'auto',
            maxBlockChars: Number(form.snapshotMaxBlockChars) || 2000,
            marker: form.snapshotMarker.trim(),
            clients: form.snapshotClientsText.split(/[\n,]+/).map(item => item.trim()).filter(Boolean),
            onDivergence: form.snapshotDivergence === 'branch' ? 'branch' : 'full',
          },
          systemSnapshot: { mode: form.systemSnapshotMode },
          appendFormat: form.appendFormat === 'tagged' ? 'tagged' : 'nonce',
          appendNonce: form.appendNonce.trim(),
        }
        if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) {
          throw new Error('端口必须是 1-65535 的整数')
        }
        if (form.authToken.trim() !== '') payload.authToken = form.authToken.trim()
        if (form.clearAuthToken) payload.clearAuthToken = true
        const result = await rpc('save', { settings: payload })
        setRawLoaded(false)
        return needsRestart(result.status) ? '' : '设置已保存。'
      })

      const action = (name, payload = {}) => run(`操作 ${name}`, async () => {
        await rpc('action', { action: name, ...payload })
        return name === 'restart' ? '桥接已重启。' : '操作完成。'
      })

      const saveAndRestart = async () => {
        const ok = await save()
        if (ok) await action('restart')
      }

      const viewRules = async (chat) => {
        try {
          const value = await rpc('rules', {
            client_id: chat.client_id,
            chat_id: chat.chat_id,
            task_id: chat.task_id,
          })
          setRules({ ...value, tab })
          setError('')
        } catch (err) {
          setError(`读取规则失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }

      const loadPresets = async () => {
        try {
          setPresets(await rpc('presets', {}))
          setError('')
        } catch (err) {
          setError(`读取固定预设失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }

      const rotateSnapshotMarker = () => run('生成快照标记', async () => {
        const value = await rpc('action', { action: 'rotate_snapshot_marker' })
        setForm(current => ({ ...current, snapshotMarker: value.marker, snapshotEnabled: true }))
        return `已生成新标记 ${value.marker}；旧快照已失效，请把它更新到模板。`
      })

      const rotateAppendNonce = () => run('生成追加标记', async () => {
        const value = await rpc('action', { action: 'rotate_append_nonce' })
        setForm(current => ({ ...current, appendNonce: value.nonce }))
        return `已生成新的追加分隔标记 ${value.nonce}。`
      })

      const enableMobile = () => run('启用局域网访问', async () => {
        const value = await rpc('action', { action: 'enable_mobile_access' })
        const urls = (value.urls || []).join('  ')
        return value.token
          ? `已开启并重启。地址：${urls}；令牌：${value.token}（只显示一次，请立即保存）`
          : `已开启并重启。地址：${urls}；沿用现有令牌。`
      })

      const disableMobile = () => run('关闭局域网访问', async () => {
        await rpc('action', { action: 'disable_mobile_access' })
        return '已关闭局域网访问并恢复仅本机监听。'
      })

      const rotateAuthToken = () => run('生成桥接令牌', async () => {
        const value = await rpc('action', { action: 'rotate_auth_token' })
        return `新令牌：${value.token}（只显示一次，请复制到客户端）`
      })

      const startPairing = () => run('生成配对码', async () => {
        await rpc('action', { action: 'pair_start' })
        return '配对码已生成。'
      })

      const approvePairing = pairId => run('批准设备', async () => {
        await rpc('action', { action: 'pair_approve', pairId })
        return '已批准。客户端会自动领取设备令牌。'
      })

      const rejectPairing = pairId => run('拒绝设备', async () => {
        await rpc('action', { action: 'pair_reject', pairId })
        return '已拒绝该配对申请。'
      })

      const revokeDevice = deviceId => run('撤销设备', async () => {
        await rpc('action', { action: 'device_revoke', deviceId })
        return '设备已撤销，设备令牌立即失效。'
      })

      const showLogPath = async () => {
        try {
          const value = await rpc('action', { action: 'open_log' })
          setNotice(`日志路径：${value.path}`)
          setError('')
        } catch (err) {
          setError(`读取日志路径失败：${err instanceof Error ? err.message : String(err)}`)
        }
      }

      const clearRules = async () => {
        if (!rules) return
        const ok = await action('clear_rules', {
          client_id: rules.client_id,
          chat_id: rules.chat_id,
          task_id: rules.task_id,
        })
        if (ok) setRules(null)
      }

      const saveRaw = () => run('保存原始配置', async () => {
        let parsed
        try {
          parsed = JSON.parse(rawText)
        } catch {
          throw new Error('不是合法 JSON')
        }
        const result = await rpc('save_raw', { settings: parsed })
        setRawLoaded(false)
        return needsRestart(result.status) ? '' : '已保存原始配置。'
      })

      const chats = status?.chats ?? []
      const dirty = savedFingerprint !== '' && JSON.stringify(form) !== savedFingerprint
      const restartPending = needsRestart(status)
      const addressChanged = status && (form.host.trim() !== status.service.host || Number(form.port) !== status.service.port)
      const filtered = chats.filter(chat => {
        const needle = filter.trim().toLowerCase()
        if (!needle) return true
        return [chat.client_label, chat.client_id, chat.chat_id, chat.task_id, chat.title, chat.session_id]
          .some(value => String(value ?? '').toLowerCase().includes(needle))
      })

      const agentPresetField = ({ value, onChange, label = 'Agent 预设' }) => {
        const info = agentPresetOptions
        const rows = Array.isArray(info?.presets) ? info.presets : []
        const selected = rows.find(row => row.id === value)
        if (info?.available === false) {
          return h(Field, { label, hint: '无法读取宿主预设列表，可直接填写预设 ID。' },
            h('input', { className: 'bbh-input', value, onChange: e => onChange(e.target.value) }))
        }
        const hint = value === ''
          ? '工具跟随所选预设，执行权限由 DSH 策略决定。'
          : selected?.broken
            ? `当前预设不可用：${selected.broken}`
            : selected?.description || (info === null
                ? '正在读取可用预设…'
                : rows.length === 0
                  ? '宿主没有返回可用预设。'
                  : '工具跟随所选预设，执行权限由 DSH 策略决定。')
        const options = [h('option', { key: 'empty', value: '' }, '跟随 DSH 默认')]
        if (value && !selected) {
          options.push(h('option', { key: 'current', value }, `${value}（当前）`))
        }
        for (const row of rows) {
          const suffix = row.broken ? '（不可用）' : row.id === info?.defaultId ? '（默认）' : ''
          options.push(h('option', {
            key: row.id,
            value: row.id,
            disabled: Boolean(row.broken) && row.id !== value,
            title: row.broken || row.description || undefined,
          }, `${row.name || row.id}${suffix}`))
        }
        return h(Field, { label, hint },
          h('select', { className: 'bbh-select', value, onChange: e => onChange(e.target.value) }, ...options))
      }

      const tabs = [
        ['general', '服务'],
        ['endpoints', '插件接入'],
        ['clients', `会话绑定（${chats.length}）`],
        ['presets', '固定预设'],
        ['advanced', '高级'],
      ]

      return h('section', { className: 'bbh' },
        h('style', null, CSS),
        h('header', { className: 'bbh-head' },
          h('h2', { className: 'bbh-title' }, 'ST-bridge'),
        ),

        status === null
          ? h('div', { className: 'bbh-actions' },
              h('span', { className: 'bbh-note' }, error ? '读取失败，请重试。' : '读取中…'),
              h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void load() }, '重试'),
            )
          : h('div', { className: 'bbh-status' },
              h('span', { className: status.running ? 'bbh-dot' : 'bbh-dot off' }),
              h('strong', null, status.running ? '运行中' : '未运行'),
              h('span', { className: 'bbh-status-meta' }, status.active ? `${status.active.host}:${status.active.port}` : '未监听'),
              h('span', { className: 'bbh-status-meta' }, `v${status.version}`),
              h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void load() }, '刷新'),
            ),

        h('nav', { className: 'bbh-tabs', role: 'tablist' },
          tabs.map(([key, label]) => h('button', {
            key,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === key,
            className: tab === key ? 'bbh-tab is-on' : 'bbh-tab',
            onClick: () => {
              setTab(key)
              if (key === 'presets' && presets === null) void loadPresets()
            },
          }, label)),
        ),

        error ? h('p', { className: 'bbh-error' }, error) : null,
        notice ? h('p', { className: 'bbh-notice' }, notice) : null,

        dirty || restartPending ? h('div', { className: 'bbh-savebar' },
          h('span', { className: 'bbh-savebar-state' }, dirty
            ? '有未保存的修改' : '设置已保存，重启后生效'),
          h('div', { className: 'bbh-actions' },
            dirty ? h('button', { type: 'button', className: 'bbh-btn', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存设置') : null,
            dirty && (addressChanged || restartPending)
              ? h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void saveAndRestart() }, '保存并重启') : null,
            !dirty && restartPending
              ? h('button', { type: 'button', className: 'bbh-btn', disabled: busy, onClick: () => void action('restart') }, '重启桥接') : null,
          ),
        ) : null,

        status === null ? null : tab === 'general' ? h('div', { className: 'bbh-card' },
          h('h3', { className: 'bbh-card-title' }, '服务与安全'),
          status.network?.mobileEnabled ? h('div', null,
            h('p', { className: 'bbh-note' }, `当前局域网地址：${(status.network.urls || []).join('  ') || '未检测到 IPv4 地址'}；令牌${status.network.tokenSet ? '已设置' : '未设置'}。`),
            h('div', { className: 'bbh-actions' },
              h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void disableMobile() }, '关闭局域网访问'),
            ),
          ) : h('div', { className: 'bbh-box' },
            h('p', { className: 'bbh-note' }, '开启局域网访问会重启桥接，并在缺少令牌时生成令牌。手机连接时，请在防火墙放行端口。'),
            h('div', { className: 'bbh-actions' },
              h('button', { type: 'button', className: 'bbh-btn', disabled: busy, onClick: () => void enableMobile() }, '启用局域网访问'),
            ),
          ),
          h('div', { className: 'bbh-box' },
            h('h4', { className: 'bbh-card-title' }, '设备配对'),
            h('p', { className: 'bbh-note' }, '在客户端输入配对码并提交，再回到这里批准。撤销设备后，设备令牌立即失效。'),
            h('div', { className: 'bbh-actions' },
              h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void startPairing() }, '生成配对码'),
            ),
            status.pairing?.invite
              ? h('p', { className: 'bbh-notice' }, `当前配对码：${status.pairing.invite.code}（${new Date(status.pairing.invite.expiresAt).toLocaleTimeString()} 过期）`)
              : null,
            status.pairing?.requests?.length
              ? status.pairing.requests.map(request => h('div', { className: 'bbh-actions', key: request.pairId },
                h('span', null, `${request.deviceName || '未命名设备'}  ${request.ip || ''}  ${new Date(request.createdAt).toLocaleTimeString()}`),
                request.status === 'approved_pending_delivery'
                  ? h('span', { className: 'bbh-note' }, '已批准，等待客户端领取令牌')
                  : h('div', { className: 'bbh-actions' },
                    h('button', { type: 'button', className: 'bbh-btn', disabled: busy, onClick: () => void approvePairing(request.pairId) }, '允许'),
                    h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void rejectPairing(request.pairId) }, '拒绝'),
                  ),
              ))
              : null,
            status.pairing?.devices?.length
              ? status.pairing.devices.map(device => h('div', { className: 'bbh-actions', key: device.id },
                h('span', null, `${device.name}  ${device.ip || ''}  最近 ${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleTimeString() : '未使用'}`),
                h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void revokeDevice(device.id) }, '撤销'),
              ))
              : h('p', { className: 'bbh-note' }, '还没有已配对设备。'),
          ),
          h('div', { className: 'bbh-grid2' },
            h(Field, { label: '监听地址', hint: '默认仅本机可访问。' },
              h('input', { className: 'bbh-input', value: form.host, onChange: e => setField('host', e.target.value) })),
            h(Field, { label: '端口', hint: '修改后请重启桥接并更新客户端的 API 地址。' },
              h('input', { className: 'bbh-input', type: 'number', min: 1, max: 65535, value: form.port, onChange: e => setField('port', e.target.value) })),
          ),
          h(Field, { label: '桥接令牌', hint: form.clearAuthToken ? '保存设置后清除现有令牌。' : '手动填写后保存生效。生成或更换会立即生效，请更新客户端的 API Key。' },
            h('div', { className: 'bbh-actions' },
              h('input', {
                className: 'bbh-input',
                type: 'password',
                placeholder: status.service.authTokenSet ? '已设置，留空不修改' : '可选',
                value: form.authToken,
                onChange: e => setForm(current => ({ ...current, authToken: e.target.value, clearAuthToken: false })),
              }),
              h('button', {
                type: 'button',
                className: 'bbh-btn secondary',
                disabled: busy || (!status.service.authTokenSet && !form.authToken && !form.clearAuthToken),
                onClick: () => setForm(current => ({ ...current, authToken: '', clearAuthToken: true })),
              }, form.clearAuthToken ? '待清除' : '保存后清除'),
              h('button', {
                type: 'button',
                className: 'bbh-btn secondary',
                disabled: busy,
                onClick: () => void rotateAuthToken(),
              }, status.service.authTokenSet ? '更换令牌' : '生成令牌'),
            ),
          ),
          h('div', { className: 'bbh-grid2' },
            h(Field, { label: '请求超时（毫秒）' },
              h('input', { className: 'bbh-input', type: 'number', min: 5000, value: form.requestTimeoutMs, onChange: e => setField('requestTimeoutMs', e.target.value) })),
            h(Field, { label: '请求体上限（字节）' },
              h('input', { className: 'bbh-input', type: 'number', min: 1024, value: form.maxBodyBytes, onChange: e => setField('maxBodyBytes', e.target.value) })),
          ),
          h(Field, { label: 'CORS 额外 Origin', hint: '每行一个，或逗号分隔。默认允许本机页面与浏览器扩展。' },
            h('textarea', { className: 'bbh-textarea', rows: 3, value: form.corsText, onChange: e => setField('corsText', e.target.value) })),
          h(Check, { checked: form.allowLegacyPlain, onChange: value => setField('allowLegacyPlain', value), label: '允许不带 dsh_session 的旧式普通补全', hint: '默认关闭，避免健康检查创建正式会话。' }),
          h(Check, { checked: form.sessionOnStale, onChange: value => setField('sessionOnStale', value), label: '失效 session_id 自动新建会话', hint: '仅在该作用域已无绑定时生效；避免重置后插件仍发旧 ID 导致 410。' }),
          h(Check, { checked: form.sessionOnArchived, onChange: value => setField('sessionOnArchived', value), label: '绑定会话归档后自动新建' }),
          h(Check, { checked: form.contextOverflow, onChange: value => setField('contextOverflow', value), label: '上下文超限重建会话', hint: '收到 413 context_length_exceeded 时清空绑定并新建；仍有单轮正文超限的可能。' }),
          h(Field, { label: '瞬时错误重试次数', hint: '429/5xx/超时，且本轮尚未产生 user 消息时重试；0 关闭。' },
            h('input', { className: 'bbh-input', type: 'number', min: 0, max: 2, value: form.transientRetry, onChange: e => setField('transientRetry', e.target.value) })),
          h(Check, { checked: form.allowRemote, onChange: value => setField('allowRemote', value), label: '允许绑定非本机地址', hint: '仅在设置了桥接令牌且网络隔离时使用。' }),
          h(Check, { checked: form.inputCleanupEnabled, onChange: value => setField('inputCleanupEnabled', value), label: '桥接侧清理完整标签块', hint: '兜底处理绕过浏览器适配的请求；只删完整成对标签，孤立/跨消息保留并记录。' }),
          h(Field, { label: '清理标签', hint: `用逗号分隔。默认 ${form.defaultInputCleanupTags.join(', ') || '由服务端提供'}。` },
            h('input', { className: 'bbh-input', value: form.inputCleanupTags, onChange: e => setField('inputCleanupTags', e.target.value) })),
          h('div', { className: 'bbh-grid2' },
            h(Field, { label: '追加包装格式', hint: 'nonce = 短分隔符；tagged = 原 ST_BRIDGE_MESSAGE。' },
              h('input', { className: 'bbh-input', value: form.appendFormat, onChange: e => setField('appendFormat', e.target.value) })),
            h(Field, { label: '追加分隔 nonce', hint: '8-32 位十六进制，只用于追加包装。' },
              h('div', { className: 'bbh-actions' },
                h('input', { className: 'bbh-input', value: form.appendNonce, onChange: e => setField('appendNonce', e.target.value) }),
                h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void rotateAppendNonce() }, '生成'),
              )),
          ),
          h('details', { className: 'bbh-fold', open: form.systemSnapshotMode !== 'native' },
            h('summary', null, '系统段快照：后续轮次保留世界书'),
            h('p', { className: 'bbh-note' }, 'native 由 DSH 维护系统段，只在发现旧版遗留空节点时补写；filled 每轮写入完整系统段；empty 仅用于诊断。'),
            h(Field, { label: '模式', hint: '默认 native。若新激活的世界书仍不更新，测试 filled。' },
              h('select', { className: 'bbh-input', value: form.systemSnapshotMode, onChange: e => setField('systemSnapshotMode', e.target.value) },
                (form.systemSnapshotModes.length ? form.systemSnapshotModes : [form.systemSnapshotMode]).filter(Boolean).map(mode =>
                  h('option', { value: mode }, mode === 'native' ? 'native（默认，交给 DSH）' : mode === 'filled' ? 'filled（桥接写入完整系统段）' : mode === 'empty' ? 'empty（仅诊断，会清空系统段）' : mode)),
              )),
          ),
          h('details', { className: 'bbh-fold', open: form.snapshotEnabled },
            h('summary', null, '快照差分：删除与上一轮相同的块'),
            h('p', { className: 'bbh-note' }, '只删除开头或结尾完整相同的块。标记未配对时发送整段。'),
            h(Check, { checked: form.snapshotEnabled, onChange: value => setField('snapshotEnabled', value), label: '启用快照差分' }),
            h('div', { className: 'bbh-grid2' },
              h(Field, { label: '切块模式', hint: 'auto = 自动按段落切；marker = 用 B/E 标记包住每段。' },
                h('input', { className: 'bbh-input', value: form.snapshotMode, onChange: e => setField('snapshotMode', e.target.value) })),
              h(Field, { label: '单块上限（字符）', hint: 'auto 模式下长段落每行一块；单行超长才按此上限切。' },
                h('input', { className: 'bbh-input', type: 'number', min: 64, max: 20000, value: form.snapshotMaxBlockChars, onChange: e => setField('snapshotMaxBlockChars', e.target.value) })),
            ),
            h('div', { className: 'bbh-actions' },
              h('input', { className: 'bbh-input', readOnly: true, value: form.snapshotMarker || '（尚未生成）' }),
              h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void rotateSnapshotMarker() }, '生成标记'),
              h('button', {
                type: 'button',
                className: 'bbh-btn secondary',
                disabled: busy || !form.snapshotMarker,
                onClick: () => { if (form.snapshotMarker) void navigator.clipboard?.writeText(`<<<STB-${form.snapshotMarker}:B>>> ... <<<STB-${form.snapshotMarker}:E>>>`) },
              }, '复制标记'),
            ),
            h('p', { className: 'bbh-note' }, '模板写法：每段用 B/E 包起来。标记只在传输层存在，进模型前剥掉。块首写 <<<STB-KEEP>>> 可固定该块；配对的 <<<STB-/KEEP>>> 可把中间所有块一起固定。'),
            h(Field, { label: '适用的 client_id', hint: '逗号分隔；留空表示所有客户端。' },
              h('input', { className: 'bbh-input', value: form.snapshotClientsText, onChange: e => setField('snapshotClientsText', e.target.value) })),
            h(Field, { label: '分歧处理', hint: 'full = 整段发送；branch = 新分支。' },
              h('input', { className: 'bbh-input', value: form.snapshotDivergence, onChange: e => setField('snapshotDivergence', e.target.value) })),
          ),
          h('details', { className: 'bbh-fold', open: form.plainCompatEnabled },
            h('summary', null, '兼容模式：普通 OpenAI 请求归入固定作用域'),
            h('p', { className: 'bbh-note' }, '用于只能填 URL/Key/模型、无法发送 dsh_session 的插件（例如玉子手机）。所有不带 dsh_session 的请求都会归入下面这一个作用域；不同插件不要同时使用。'),
            h(Check, { checked: form.plainCompatEnabled, onChange: value => setField('plainCompatEnabled', value), label: '启用普通请求兼容模式' }),
            h('div', { className: 'bbh-grid2' },
              h(Field, { label: 'client_id' },
                h('input', { className: 'bbh-input', value: form.plainCompatClientId, onChange: e => setField('plainCompatClientId', e.target.value) })),
              h(Field, { label: 'task_id' },
                h('input', { className: 'bbh-input', value: form.plainCompatTaskId, onChange: e => setField('plainCompatTaskId', e.target.value) })),
            ),
            h(Field, { label: 'chat_id', hint: '固定绑定名；所有普通请求共用这一个持久会话。' },
              h('input', { className: 'bbh-input', value: form.plainCompatChatId, onChange: e => setField('plainCompatChatId', e.target.value) })),
            h('div', { className: 'bbh-grid2' },
              h(Field, { label: '固定规则条数', hint: '0=不固定；1=第一条 system 作为固定规则。' },
                h('input', { className: 'bbh-input', type: 'number', min: 0, max: 4, value: form.plainCompatFixedCount, onChange: e => setField('plainCompatFixedCount', e.target.value) })),
              h(Field, { label: '固定规则类型', hint: '与条数逐条对应，用逗号分隔：prefix,spec,contract,check' },
                h('input', { className: 'bbh-input', value: form.plainCompatFixedTypes, onChange: e => setField('plainCompatFixedTypes', e.target.value) })),
            ),
          ),
        ) : null,

        status === null ? null : tab === 'endpoints' ? renderEndpoints({
          Field, Check, status, form, endpointBase, setEndpointBase, setField,
          modelCatalog, workspaceOptions, agentPresetField, setNotice, setError,
        }) : null,

        status === null ? null : tab === 'clients' ? h('div', { className: 'bbh-card' },
          h('h3', { className: 'bbh-card-title' }, '客户端与绑定'),
          h('p', { className: 'bbh-note' }, '默认按插件、聊天和任务绑定。开启持续会话后，同一个插件共用 DSH 窗口。'),
          h(Field, { label: '允许的 client_id', hint: '每行一个，留空允许所有插件；写入后其它 client_id 会返回 403。' },
            h('textarea', { className: 'bbh-textarea', rows: 3, value: form.allowedClientsText, onChange: e => setField('allowedClientsText', e.target.value) })),
          h('input', { className: 'bbh-input', 'aria-label': '筛选会话绑定', placeholder: '按插件、聊天、任务或标题筛选', value: filter, onChange: e => setFilter(e.target.value) }),
          filtered.length === 0
            ? h('p', { className: 'bbh-note' }, chats.length === 0 ? '还没有会话绑定。通过插件发起生成后可在这里查看。' : '没有匹配的绑定。')
            : h('div', { className: 'bbh-list' },
                filtered.map(chat => h('div', { key: `${chat.client_id}\u0000${chat.chat_id}\u0000${chat.task_id}`, className: 'bbh-item' },
                  h('div', { className: 'bbh-item-main' },
                    h('div', { className: 'bbh-item-title' }, chat.title || '未命名聊天'),
                    h('div', { className: 'bbh-item-sub' }, `${chat.client_label} · ${chat.chat_id}${chat.task_id !== 'default' ? ` · ${chat.task_id}` : ''}`),
                    h('div', { className: 'bbh-item-meta' },
                      [`会话 ${shortSession(chat.session_id)}`, chat.fixed_rule_types.length ? `规则 ${chat.fixed_rule_types.join('、')}` : '', chat.updated_at ? new Date(chat.updated_at).toLocaleString() : ''].filter(Boolean).join(' · ')),
                  ),
                  h('div', { className: 'bbh-item-actions' },
                    h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void viewRules(chat) }, '查看规则'),
                    h('button', {
                      type: 'button',
                      className: 'bbh-btn secondary',
                      disabled: busy,
                      onClick: () => {
                        const shared = chat.task_id === 'shared' || String(chat.chat_id).startsWith('shared:')
                        const message = shared
                          ? `该插件开启了持续会话。重置会清除 ${chat.client_label} 的共享窗口，影响该插件所有聊天；DSH 历史会保留。继续？`
                          : `重置 ${chat.client_label} / ${chat.chat_id} 的桥接绑定？DSH 历史会保留。`
                        if (!window.confirm(message)) return
                        void action('reset_binding', { client_id: chat.client_id, chat_id: chat.chat_id, task_id: chat.task_id })
                      },
                    }, '重置绑定'),
                  ),
                )),
              ),
        ) : null,

        status === null ? null : tab === 'presets' ? h('div', { className: 'bbh-card' },
          h('div', { className: 'bbh-actions', style: { justifyContent: 'space-between' } },
            h('h3', { className: 'bbh-card-title' }, '固定预设'),
            h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void loadPresets() }, presets ? '刷新' : '读取'),
          ),
          h('p', { className: 'bbh-note' }, '只对完整且唯一匹配的预设内容去重。其余内容原样保留。配置保存哈希和标记。'),
          presets === null
            ? h('p', { className: 'bbh-note' }, '尚未读取。')
            : [
                h('p', { className: 'bbh-note' }, `已配置 ${presets.presets.length} 条，已安装 ${presets.installs.length} 个作用域。`),
                ...presets.presets.map(item => h('div', { className: 'bbh-item', key: item.id },
                  h('div', null,
                    h('strong', null, item.label),
                    h('div', { className: 'bbh-note' }, `${item.client_id} / ${item.task_id} · ${item.mode} · ${item.hash.slice(0, 12)}`),
                  ),
                )),
                ...presets.installs.map(chat => h('div', { className: 'bbh-item', key: `${chat.client_id}:${chat.chat_id}:${chat.task_id}` },
                  h('div', null,
                    h('strong', null, `${chat.client_label} / ${chat.chat_id}${chat.task_id !== 'default' ? ` / ${chat.task_id}` : ''}`),
                    h('div', { className: 'bbh-note' }, `${chat.last_status ?? '未知'}${chat.last_reason ? ` · ${chat.last_reason}` : ''} · 省 ${chat.deduped_chars ?? 0} / 原 ${chat.original_chars ?? 0} 字符`),
                  ),
                  h('div', { className: 'bbh-item-actions' },
                    h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void viewRules(chat) }, '查看规则'),
                    h('button', {
                      type: 'button',
                      className: 'bbh-btn secondary',
                      disabled: busy,
                      onClick: () => {
                        if (!window.confirm(`清除 ${chat.client_label} / ${chat.chat_id} 的固定预设安装状态？下次生成会重新安装。`)) return
                        void action('reset_preset', { client_id: chat.client_id, chat_id: chat.chat_id, task_id: chat.task_id })
                      },
                    }, '重置安装状态'),
                  ),
                )),
              ],
        ) : null,

        rules?.tab === tab ? h('div', { className: 'bbh-card', ref: rulesRef },
          h('h3', { className: 'bbh-card-title' }, '固定规则'),
          h('p', { className: 'bbh-item-sub' }, `${rules.client_label} / ${rules.chat_id}${rules.task_id !== 'default' ? ` / ${rules.task_id}` : ''}`),
          rules.fixed_rules.length === 0
            ? h('p', { className: 'bbh-note' }, '当前绑定没有固定规则。')
            : h('pre', { className: 'bbh-pre' }, rules.fixed_rules.map(rule => `[${rule.type}] (${rule.role})\n${rule.text}`).join('\n\n')),
          h('div', { className: 'bbh-actions' },
            h('button', {
              type: 'button',
              className: 'bbh-btn danger',
              disabled: busy || rules.fixed_rules.length === 0,
              onClick: () => {
                if (!window.confirm('清除当前绑定的固定规则？下次生成前需要重新同步。')) return
                void clearRules()
              },
            }, '清除规则'),
            h('button', { type: 'button', className: 'bbh-btn secondary', onClick: () => setRules(null) }, '关闭'),
          ),
        ) : null,

        status === null ? null : tab === 'advanced' ? h('div', { className: 'bbh-box' },
          h('h3', { className: 'bbh-card-title' }, '高级'),
          h('details', { className: 'bbh-fold', open: true },
            h('summary', null, '运行诊断'),
            h('div', { className: 'bbh-card' },
              h('div', { className: 'bbh-kv' },
                h('span', null, '版本'), h('span', null, status.version),
                h('span', null, '运行状态'), h('span', null, status.running ? '运行中' : '未运行'),
                h('span', null, '监听'), h('span', null, status.active ? `${status.active.host}:${status.active.port}` : '未监听'),
                h('span', null, '作用域 / 会话'), h('span', null, `${status.counts.scopes} / ${status.counts.sessions}`),
                h('span', null, '设置文件'), h('span', null, status.settings_file),
                h('span', null, '日志'), h('span', null, status.log_file),
              ),
              h('div', { className: 'bbh-actions' },
                h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void showLogPath() }, '显示日志路径'),
              ),
              h('details', { className: 'bbh-fold', open: true },
                h('summary', null, '能力'),
                h('pre', { className: 'bbh-pre' }, JSON.stringify(status.capabilities, null, 2)),
              ),
              h('details', { className: 'bbh-fold' },
                h('summary', null, '最近日志'),
                h('pre', { className: 'bbh-pre' }, status.log_tail?.trim() || '（暂无日志）'),
              ),
            ),
          ),
          h('details', { className: 'bbh-fold' },
            h('summary', null, '危险操作'),
            h('div', { className: 'bbh-card bbh-danger-card' },
              h('p', { className: 'bbh-note' }, '这些操作只影响桥接服务与绑定，不删除 DSH 会话历史。'),
              h('div', { className: 'bbh-actions' },
                h('button', {
                  type: 'button',
                  className: 'bbh-btn secondary',
                  disabled: busy || !status.running,
                  onClick: () => {
                    if (!window.confirm('停止桥接会中断正在进行的请求，但不会删除 DSH 会话。继续？')) return
                    void action('stop')
                  },
                }, '停止桥接'),
                h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy || status.running, onClick: () => void action('start') }, '启动桥接'),
                restartPending ? null : h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void action('restart') }, '重启桥接'),
              ),
              h('div', { className: 'bbh-box' },
                h('h4', { className: 'bbh-card-title' }, '清空全部绑定'),
                h('p', { className: 'bbh-note' }, '移除所有 client/chat/task 的映射。下次请求会重新创建会话。输入 RESET 确认。'),
                h('div', { className: 'bbh-actions' },
                  h('input', { className: 'bbh-input', style: { maxWidth: '220px' }, placeholder: 'RESET', value: dangerText, onChange: e => setDangerText(e.target.value) }),
                  h('button', {
                    type: 'button',
                    className: 'bbh-btn danger',
                    disabled: busy || dangerText !== 'RESET',
                    onClick: () => {
                      void action('clear_bindings', { confirm: dangerText }).then(ok => { if (ok) setDangerText('') })
                    },
                  }, '清空全部绑定'),
                ),
              ),
            ),
          ),
          h('details', { className: 'bbh-fold' },
            h('summary', null, '原始设置 JSON'),
            h('div', { className: 'bbh-card' },
              h('p', { className: 'bbh-note' }, '对应 ~/.dsh/st-bridge/settings.json。authToken 留空表示保持现有值；host/port 修改后需要重启桥接；stateDir 只能在 cordis.patch.yml 中修改。'),
              h('textarea', { className: 'bbh-textarea', style: { minHeight: '300px' }, value: rawText, onChange: e => setRawText(e.target.value), spellCheck: false }),
              h('div', { className: 'bbh-actions' },
                h('button', { type: 'button', className: 'bbh-btn', disabled: busy, onClick: () => void saveRaw() }, busy ? '保存中…' : '保存原始配置'),
                h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => { setRawLoaded(false) } }, '重新读取'),
              ),
            ),
          ),
        ) : null,
      )
    }

module.exports = { Panel }

    }
    __modules["./index.js"] = function (module, exports, require) {
const { Panel } = require('./panel.js')

module.exports = {
  inject: ['slots', 'connection'],
  apply(ctx) {
    const rpcCall = (endpoint, payload) => ctx.connection.rpc.call('/st-bridge', endpoint, payload)
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'st-bridge',
      order: 58,
      label: () => 'ST-bridge',
      inject: () => ({ rpcCall }),
    }, Panel))
  },
}

    }
    function __localRequire(id) {
      if (!__modules[id]) return require(id)
      if (__cache[id]) return __cache[id].exports
      const module = { exports: {} }
      __cache[id] = module
      __modules[id](module, module.exports, __localRequire)
      return module.exports
    }
    return __localRequire('./index.js')
  },
})
