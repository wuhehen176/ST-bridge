/**
 * ST-bridge bridge — settings panel (browser half).
 *
 * One settings.section page: service, model, scope/session management,
 * diagnostics, danger zone, and raw settings. All file/DSH work stays in the
 * Host half; this page only calls the RPC channel.
 */
window.__ModuleLoader__.load({
  id: 'ST-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const CHANNEL = '/st-bridge'

    const CSS = `
.bbh { display:grid; gap:16px; width:100%; max-width:860px; min-width:0; font-size:13px; line-height:1.55; color:inherit;
  --bbh-accent:#4d6bfe; --bbh-accent-soft:rgba(77,107,254,.08); --bbh-line:rgba(127,127,127,.24);
  --bbh-fill:rgba(127,127,127,.07); --bbh-danger:#e5484d; --bbh-ok:#1a9f60; }
.bbh * { box-sizing:border-box; }
.bbh-head { display:grid; gap:3px; }
.bbh-title { margin:0; font-size:17px; font-weight:650; }
.bbh-sub { margin:0; opacity:.6; }
.bbh-tabs { display:flex; gap:4px; flex-wrap:wrap; border-bottom:1px solid var(--bbh-line); padding-bottom:7px; }
.bbh-tab { appearance:none; font:inherit; color:inherit; background:transparent; border:0; border-radius:7px; padding:6px 10px; cursor:pointer; opacity:.65; }
.bbh-tab:hover { background:var(--bbh-fill); opacity:1; }
.bbh-tab.is-on { background:var(--bbh-accent-soft); color:var(--bbh-accent); opacity:1; font-weight:600; }
.bbh-card { display:grid; gap:12px; padding:14px; border:1px solid var(--bbh-line); border-radius:12px; min-width:0; }
.bbh-card-title { margin:0; font-size:14px; font-weight:600; }
.bbh-note { margin:0; font-size:12px; opacity:.58; }
.bbh-grid2 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.bbh-field { display:grid; gap:4px; min-width:0; }
.bbh-field > span { font-size:12px; opacity:.7; }
.bbh-input, .bbh-textarea, .bbh-select { width:100%; font:inherit; color:inherit; background:var(--bbh-fill); border:1px solid var(--bbh-line); border-radius:8px; padding:7px 9px; outline:none; }
.bbh-input:focus, .bbh-textarea:focus, .bbh-select:focus { border-color:var(--bbh-accent); }
.bbh-textarea { min-height:80px; resize:vertical; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
.bbh-check { display:flex; align-items:flex-start; gap:8px; font-size:13px; cursor:pointer; }
.bbh-check input { margin-top:3px; accent-color:var(--bbh-accent); }
.bbh-check span { display:grid; gap:1px; }
.bbh-check small { font-size:11px; opacity:.55; }
.bbh-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.bbh-btn { appearance:none; font:inherit; font-size:13px; color:#fff; background:var(--bbh-accent); border:0; border-radius:8px; padding:6px 14px; cursor:pointer; }
.bbh-btn:hover:not(:disabled) { background:#3d5bf0; }
.bbh-btn:disabled { opacity:.45; cursor:default; }
.bbh-btn.secondary { color:inherit; background:var(--bbh-fill); border:1px solid var(--bbh-line); }
.bbh-btn.secondary:hover:not(:disabled) { background:rgba(127,127,127,.14); }
.bbh-btn.danger { background:var(--bbh-danger); }
.bbh-btn.danger:hover:not(:disabled) { background:#c93b40; }
.bbh-status { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 12px; border-radius:10px; background:var(--bbh-accent-soft); }
.bbh-dot { width:8px; height:8px; border-radius:50%; background:var(--bbh-ok); flex:none; }
.bbh-dot.off { background:var(--bbh-danger); }
.bbh-pill { font-size:11px; padding:1px 7px; border-radius:999px; background:var(--bbh-fill); opacity:.8; }
.bbh-error { margin:0; padding:9px 12px; border-radius:9px; color:var(--bbh-danger); background:rgba(229,72,77,.08); white-space:pre-wrap; }
.bbh-notice { margin:0; padding:9px 12px; border-radius:9px; color:var(--bbh-ok); background:rgba(26,159,96,.08); white-space:pre-wrap; }
.bbh-list { display:grid; gap:8px; }
.bbh-item { display:flex; gap:12px; align-items:flex-start; padding:10px 12px; border:1px solid var(--bbh-line); border-radius:10px; min-width:0; }
.bbh-item-main { flex:1; min-width:0; display:grid; gap:2px; }
.bbh-item-title { font-weight:550; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bbh-item-sub { font-size:12px; opacity:.65; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bbh-item-meta { font-size:11px; opacity:.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bbh-item-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.bbh-pre { margin:0; padding:10px 12px; border-radius:9px; background:var(--bbh-fill); max-height:300px; overflow:auto; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
.bbh-kv { display:grid; grid-template-columns:auto minmax(0,1fr); gap:4px 12px; font-size:12px; }
.bbh-kv > span:nth-child(odd) { opacity:.55; }
.bbh-kv > span:nth-child(even) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bbh-danger-card { border-color:rgba(229,72,77,.35); }
.bbh-danger-card .bbh-card-title { color:var(--bbh-danger); }
.bbh-fold summary { cursor:pointer; opacity:.7; font-size:12px; }
.bbh-fold[open] summary { margin-bottom:8px; }
@media (max-width:640px) { .bbh-grid2 { grid-template-columns:1fr; } .bbh-item { flex-direction:column; } .bbh-item-actions { justify-content:flex-start; } }
`

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
        port: String(status?.service?.port ?? 43121),
        provider: status?.model?.provider ?? '',
        model: status?.model?.model ?? '',
        agentPreset: status?.model?.agentPreset ?? '',
        cwd: status?.model?.cwd ?? '',
        maxTokens: status?.model?.maxTokens == null ? '' : String(status.model.maxTokens),
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
        plainCompatEnabled: status?.service?.plainCompat?.enabled === true,
        plainCompatClientId: status?.service?.plainCompat?.clientId ?? 'yuzi-phone',
        plainCompatChatId: status?.service?.plainCompat?.chatId ?? 'yuzi-phone',
        plainCompatTaskId: status?.service?.plainCompat?.taskId ?? 'default',
        plainCompatFixedCount: String(status?.service?.plainCompat?.fixedMessageCount ?? 0),
        plainCompatFixedTypes: (status?.service?.plainCompat?.fixedMessageTypes ?? []).join(','),
        inputCleanupEnabled: status?.service?.inputCleanup?.enabled !== false,
        inputCleanupTags: (status?.service?.inputCleanup?.tags ?? ['bbi_image']).join(','),
        snapshotEnabled: status?.service?.snapshotDiff?.enabled === true,
        snapshotMode: status?.service?.snapshotDiff?.mode ?? 'auto',
        snapshotMaxBlockChars: String(status?.service?.snapshotDiff?.maxBlockChars ?? 2000),
        snapshotMarker: status?.service?.snapshotDiff?.marker ?? '',
        snapshotClientsText: (status?.service?.snapshotDiff?.clients ?? ['shujuku', 'yuzi-phone']).join(','),
        snapshotDivergence: status?.service?.snapshotDiff?.onDivergence ?? 'full',
        appendFormat: status?.service?.appendFormat ?? 'nonce',
        appendNonce: status?.service?.appendNonce ?? '7F3A9C2E',
      }
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
      const [filter, setFilter] = React.useState('')
      const [dangerText, setDangerText] = React.useState('')
      const [rawText, setRawText] = React.useState('')
      const [rawLoaded, setRawLoaded] = React.useState(false)
      const [presets, setPresets] = React.useState(null)

      const rpc = React.useCallback(async (endpoint, payload = {}) => {
        const result = await rpcRef.current(endpoint, payload)
        if (!result || result.ok !== true) throw new Error(failureText(result))
        return result.value
      }, [])

      const load = React.useCallback(async () => {
        try {
          const value = await rpc('status')
          setStatus(value)
          setForm(formFrom(value))
          setError('')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }, [rpc])

      React.useEffect(() => { void load() }, [load])

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

      const setField = (key, value) => setForm(current => ({ ...current, [key]: value }))

      const run = async (label, operation) => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const message = await operation()
          setNotice(message || '已完成')
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
          provider: form.provider.trim(),
          model: form.model.trim(),
          agentPreset: form.agentPreset.trim(),
          cwd: form.cwd.trim(),
          maxTokens: form.maxTokens === '' ? null : Number(form.maxTokens),
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
          appendFormat: form.appendFormat === 'tagged' ? 'tagged' : 'nonce',
          appendNonce: form.appendNonce.trim(),
        }
        if (!Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) {
          throw new Error('端口必须是 1-65535 的整数')
        }
        if (form.authToken.trim() !== '') payload.authToken = form.authToken.trim()
        if (form.clearAuthToken) payload.clearAuthToken = true
        const value = await rpc('save', { settings: payload })
        setRawLoaded(false)
        return value.restart_required
          ? '设置已保存。host/port 已改变，请点击「重启桥接」后生效。'
          : '设置已保存并即时生效。'
      })

      const action = (name, payload = {}) => run(`操作 ${name}`, async () => {
        await rpc('action', { action: name, ...payload })
        return '操作完成。'
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
          setRules(value)
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
        return `新令牌：${value.token}（只显示一次，请复制到手机扩展）`
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
        const value = await rpc('save_raw', { settings: parsed })
        setRawLoaded(false)
        return value.restart_required ? '已保存；host/port 需要重启桥接后生效。' : '原始配置已保存。'
      })

      const chats = status?.chats ?? []
      const filtered = chats.filter(chat => {
        const needle = filter.trim().toLowerCase()
        if (!needle) return true
        return [chat.client_label, chat.client_id, chat.chat_id, chat.task_id, chat.title, chat.session_id]
          .some(value => String(value ?? '').toLowerCase().includes(needle))
      })

      const tabs = [
        ['general', '服务'],
        ['model', '模型'],
        ['clients', `客户端 (${chats.length})`],
        ['presets', '固定预设'],
        ['diagnostics', '诊断'],
        ['danger', '危险操作'],
        ['advanced', '高级'],
      ]

      return h('section', { className: 'bbh' },
        h('style', null, CSS),
        h('header', { className: 'bbh-head' },
          h('h2', { className: 'bbh-title' }, 'ST-bridge'),
          h('p', { className: 'bbh-sub' }, 'DSH Host 插件 ST-bridge 的服务、模型、scope 与会话管理。'),
        ),

        status === null
          ? h('div', { className: 'bbh-actions' },
              h('span', { className: 'bbh-note' }, error ? '读取失败，请重试。' : '读取中…'),
              h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void load() }, '重试'),
            )
          : h('div', { className: 'bbh-status' },
              h('span', { className: status.running ? 'bbh-dot' : 'bbh-dot off' }),
              h('strong', null, status.running ? '运行中' : '未运行'),
              h('span', { className: 'bbh-pill' }, `v${status.version}`),
              h('span', { className: 'bbh-pill' }, status.active ? `${status.active.host}:${status.active.port}` : '未监听'),
              h('span', { className: 'bbh-pill' }, `${status.counts.scopes} scopes · ${status.counts.sessions} sessions`),
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

        status === null ? null : tab === 'general' ? h('div', { className: 'bbh-card' },
          h('h3', { className: 'bbh-card-title' }, '服务与安全'),
          h('p', { className: 'bbh-note' }, '手机 / TauriTavern 访问：开启后监听 0.0.0.0 并自动生成令牌；需在防火墙放行端口，且只建议在局域网或私有网络使用。'),
          status.network?.mobileEnabled ? h('div', null,
            h('p', { className: 'bbh-note' }, `当前局域网地址：${(status.network.urls || []).join('  ') || '未检测到 IPv4 地址'}；令牌${status.network.tokenSet ? '已设置' : '未设置'}。`),
            h('div', { className: 'bbh-actions' },
              h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void disableMobile() }, '关闭局域网访问'),
            ),
          ) : h('div', { className: 'bbh-actions' },
            h('button', { type: 'button', className: 'bbh-btn', disabled: busy, onClick: () => void enableMobile() }, '启用局域网 / 手机访问'),
          ),
          h('div', { className: 'bbh-grid2' },
            h(Field, { label: '监听地址', hint: '默认仅 127.0.0.1；局域网需开启 allowRemote 并设置 token。' },
              h('input', { className: 'bbh-input', value: form.host, onChange: e => setField('host', e.target.value) })),
            h(Field, { label: '端口', hint: '修改后需要重启桥接服务，并同步更新各客户端的 Base URL。' },
              h('input', { className: 'bbh-input', type: 'number', min: 1, max: 65535, value: form.port, onChange: e => setField('port', e.target.value) })),
          ),
          h(Field, { label: 'Bearer token', hint: status.service.authTokenSet ? '已设置。留空不修改；点击清除可移除。修改后需同步客户端 API Key。' : '未设置。填写后所有 API 请求必须带 Authorization，并同步客户端 API Key。' },
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
              }, form.clearAuthToken ? '将清除' : '清除'),
              h('button', {
                type: 'button',
                className: 'bbh-btn secondary',
                disabled: busy,
                onClick: () => void rotateAuthToken(),
              }, '生成'),
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
          h(Check, { checked: form.sessionOnStale, onChange: value => setField('sessionOnStale', value), label: '失效 session_id 自动新建会话', hint: '仅在该 scope 已无绑定时生效；避免重置后插件仍发旧 ID 导致 410。' }),
          h(Check, { checked: form.sessionOnArchived, onChange: value => setField('sessionOnArchived', value), label: '归档会话自动新建', hint: '绑定会话被归档时忽略旧会话，直接新建。' }),
          h(Check, { checked: form.contextOverflow, onChange: value => setField('contextOverflow', value), label: '上下文超限重建会话', hint: '收到 413 context_length_exceeded 时清空绑定并新建；仍有单轮正文超限的可能。' }),
          h(Field, { label: '瞬时错误重试次数', hint: '429/5xx/超时，且本轮尚未产生 user 消息时重试；0 关闭。' },
            h('input', { className: 'bbh-input', type: 'number', min: 0, max: 2, value: form.transientRetry, onChange: e => setField('transientRetry', e.target.value) })),
          h(Check, { checked: form.allowRemote, onChange: value => setField('allowRemote', value), label: '允许绑定非本机地址', hint: '高风险，仅在已有 token 与网络隔离时使用。' }),
          h(Check, { checked: form.inputCleanupEnabled, onChange: value => setField('inputCleanupEnabled', value), label: '桥接侧清理 bbi_image 完整块', hint: '兜底处理绕过浏览器适配的请求；只删完整成对标签，孤立/跨消息保留并记录。' }),
          h(Field, { label: '清理标签', hint: '逗号分隔，默认 bbi_image。' },
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
          h('details', { className: 'bbh-fold', open: form.snapshotEnabled },
            h('summary', null, '快照差分：删除与上一轮相同的块'),
            h('p', { className: 'bbh-note' }, '用专属随机标记切块，只删开头/结尾完整相同块；没有标记或标记不配对时整段发送。'),
            h(Check, { checked: form.snapshotEnabled, onChange: value => setField('snapshotEnabled', value), label: '启用快照差分' }),
            h('div', { className: 'bbh-grid2' },
              h(Field, { label: '切块模式', hint: 'auto = 自动按段落切；marker = 模板 B/E 标记。' },
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
            h('p', { className: 'bbh-note' }, '模板写法：每段用 B/E 包起来。标记只在传输层存在，进模型前剥掉。'),
            h(Field, { label: '适用的 client_id', hint: '逗号分隔；留空表示所有客户端。' },
              h('input', { className: 'bbh-input', value: form.snapshotClientsText, onChange: e => setField('snapshotClientsText', e.target.value) })),
            h(Field, { label: '分歧处理', hint: 'full = 整段发送；branch = 新分支。' },
              h('input', { className: 'bbh-input', value: form.snapshotDivergence, onChange: e => setField('snapshotDivergence', e.target.value) })),
          ),
          h('details', { className: 'bbh-fold', open: form.plainCompatEnabled },
            h('summary', null, '兼容模式：普通 OpenAI 请求归入固定 scope'),
            h('p', { className: 'bbh-note' }, '用于只能填 URL/Key/模型、无法发送 dsh_session 的插件（例如玉子手机）。所有不带 dsh_session 的请求都会归入下面这一个 scope；不同插件不要同时使用。'),
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
          h('div', { className: 'bbh-actions' },
            h('button', { type: 'button', className: 'bbh-btn', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存设置'),
            h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void saveAndRestart() }, '保存并重启'),
          ),
        ) : null,

        status === null ? null : tab === 'model' ? h('div', { className: 'bbh-card' },
          h('h3', { className: 'bbh-card-title' }, '模型与运行参数'),
          h('p', { className: 'bbh-note' }, 'provider/model 留空表示跟随 DSH 当前默认模型。修改只影响新创建或重新恢复的会话；已有活动会话保持原模型，除非重置绑定或重建会话。'),
          h('div', { className: 'bbh-grid2' },
            h(Field, { label: 'Provider', hint: '例如 lunaroute；留空跟随 DSH。' },
              h('input', { className: 'bbh-input', value: form.provider, onChange: e => setField('provider', e.target.value) })),
            h(Field, { label: 'Model', hint: '例如 deepseek-4.1-flash；留空跟随 DSH。' },
              h('input', { className: 'bbh-input', value: form.model, onChange: e => setField('model', e.target.value) })),
          ),
          h('div', { className: 'bbh-grid2' },
            h(Field, { label: 'Agent 预设', hint: '默认 ST-bridge 专用预设。' },
              h('input', { className: 'bbh-input', value: form.agentPreset, onChange: e => setField('agentPreset', e.target.value) })),
            h(Field, { label: '工作区 cwd', hint: '新会话挂载到该目录对应的工作区。' },
              h('input', { className: 'bbh-input', value: form.cwd, onChange: e => setField('cwd', e.target.value) })),
          ),
          h(Field, { label: '默认 max_tokens', hint: '留空使用模型/DSH 默认；请求里的 max_tokens 优先。' },
            h('input', { className: 'bbh-input', type: 'number', min: 1, value: form.maxTokens, onChange: e => setField('maxTokens', e.target.value) })),
          h('div', { className: 'bbh-actions' },
            h('button', { type: 'button', className: 'bbh-btn', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存模型设置'),
          ),
        ) : null,

        status === null ? null : tab === 'clients' ? h('div', { className: 'bbh-card' },
          h('h3', { className: 'bbh-card-title' }, '客户端与绑定'),
          h('p', { className: 'bbh-note' }, '按 client_id + chat_id + task_id 隔离。重置只解除桥接绑定，不删除 DSH 会话历史；下次生成会新建会话。'),
          h(Field, { label: '允许的 client_id', hint: '每行一个，留空允许所有插件；写入后其它 client_id 会返回 403。' },
            h('textarea', { className: 'bbh-textarea', rows: 3, value: form.allowedClientsText, onChange: e => setField('allowedClientsText', e.target.value) })),
          h('div', { className: 'bbh-actions' },
            h('button', { type: 'button', className: 'bbh-btn', disabled: busy, onClick: () => void save() }, busy ? '保存中…' : '保存允许列表'),
          ),
          h('div', { className: 'bbh-actions' },
            h('input', { className: 'bbh-input', style: { maxWidth: '320px' }, placeholder: '筛选 client / chat / task / 标题', value: filter, onChange: e => setFilter(e.target.value) }),
            h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void load() }, '刷新'),
          ),
          filtered.length === 0
            ? h('p', { className: 'bbh-note' }, chats.length === 0 ? '还没有绑定。客户端首次 generate 后会出现在这里。' : '没有匹配项。')
            : h('div', { className: 'bbh-list' },
                filtered.map(chat => h('div', { key: `${chat.client_id}\u0000${chat.chat_id}\u0000${chat.task_id}`, className: 'bbh-item' },
                  h('div', { className: 'bbh-item-main' },
                    h('div', { className: 'bbh-item-title' }, `${chat.client_label} · ${chat.chat_id}${chat.task_id !== 'default' ? ` · ${chat.task_id}` : ''}`),
                    h('div', { className: 'bbh-item-sub' }, chat.title || '(无标题)'),
                    h('div', { className: 'bbh-item-meta' },
                      `session ${shortSession(chat.session_id)} · rules ${chat.fixed_rule_types.length ? chat.fixed_rule_types.join(',') : 'none'} · ${chat.updated_at ?? ''}`),
                  ),
                  h('div', { className: 'bbh-item-actions' },
                    h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void viewRules(chat) }, '规则'),
                    h('button', {
                      type: 'button',
                      className: 'bbh-btn secondary',
                      disabled: busy,
                      onClick: () => {
                        if (!window.confirm(`重置 ${chat.client_label} / ${chat.chat_id} 的桥接绑定？DSH 历史会保留。`)) return
                        void action('reset_binding', { client_id: chat.client_id, chat_id: chat.chat_id, task_id: chat.task_id })
                      },
                    }, '重置绑定'),
                  ),
                )),
              ),
          rules ? h('div', { className: 'bbh-card' },
            h('div', { className: 'bbh-actions', style: { justifyContent: 'space-between' } },
              h('h3', { className: 'bbh-card-title' }, `固定规则 · ${rules.client_label} / ${rules.chat_id}${rules.task_id !== 'default' ? ` / ${rules.task_id}` : ''}`),
              h('div', { className: 'bbh-actions' },
                h('button', {
                  type: 'button',
                  className: 'bbh-btn danger',
                  disabled: busy || rules.fixed_rules.length === 0,
                  onClick: () => {
                    if (!window.confirm('清除当前 scope 的固定规则？下次生成前需要重新同步。')) return
                    void clearRules()
                  },
                }, '清除规则'),
                h('button', { type: 'button', className: 'bbh-btn secondary', onClick: () => setRules(null) }, '关闭'),
              ),
            ),
            rules.fixed_rules.length === 0
              ? h('p', { className: 'bbh-note' }, '当前 scope 没有固定规则。')
              : h('pre', { className: 'bbh-pre' }, rules.fixed_rules.map(rule => `[${rule.type}] (${rule.role})\n${rule.text}`).join('\n\n')),
          ) : null,
        ) : null,

        status === null ? null : tab === 'presets' ? h('div', { className: 'bbh-card' },
          h('div', { className: 'bbh-actions', style: { justifyContent: 'space-between' } },
            h('h3', { className: 'bbh-card-title' }, '固定预设分离'),
            h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void loadPresets() }, presets ? '刷新' : '读取'),
          ),
          h('p', { className: 'bbh-note' }, '只对已确认的边界去重。未识别、部分匹配、多重匹配一律完整保留；配置只存 Hash，不存预设正文。'),
          presets === null
            ? h('p', { className: 'bbh-note' }, '尚未读取。')
            : [
                h('p', { className: 'bbh-note' }, `已配置 ${presets.presets.length} 条，已安装 ${presets.installs.length} 个 scope。`),
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
                    h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void viewRules(chat) }, '规则'),
                    h('button', {
                      type: 'button',
                      className: 'bbh-btn secondary',
                      disabled: busy,
                      onClick: () => {
                        if (!window.confirm(`清除 ${chat.client_label} / ${chat.chat_id} 的固定预设安装状态？下次生成会重新安装。`)) return
                        void action('reset_preset', { client_id: chat.client_id, chat_id: chat.chat_id, task_id: chat.task_id })
                      },
                    }, '重新安装'),
                  ),
                )),
              ],
        ) : null,

        status === null ? null : tab === 'diagnostics' ? h('div', { className: 'bbh-card' },
          h('h3', { className: 'bbh-card-title' }, '诊断'),
          h('div', { className: 'bbh-kv' },
            h('span', null, '版本'), h('span', null, status.version),
            h('span', null, '运行状态'), h('span', null, status.running ? '运行中' : '未运行'),
            h('span', null, '监听'), h('span', null, status.active ? `${status.active.host}:${status.active.port}` : '未监听'),
            h('span', null, '作用域 / 会话'), h('span', null, `${status.counts.scopes} / ${status.counts.sessions}`),
            h('span', null, '状态文件'), h('span', null, status.settings_file),
            h('span', null, '日志'), h('span', null, status.log_file),
          ),
          h('div', { className: 'bbh-actions' },
            h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void load() }, '刷新状态'),
            h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void showLogPath() }, '显示日志路径'),
          ),
          h('details', { className: 'bbh-fold', open: true },
            h('summary', null, 'Capabilities'),
            h('pre', { className: 'bbh-pre' }, JSON.stringify(status.capabilities, null, 2)),
          ),
          h('details', { className: 'bbh-fold' },
            h('summary', null, '最近日志'),
            h('pre', { className: 'bbh-pre' }, status.log_tail?.trim() || '（暂无日志）'),
          ),
        ) : null,

        status === null ? null : tab === 'danger' ? h('div', { className: 'bbh-card bbh-danger-card' },
          h('h3', { className: 'bbh-card-title' }, '危险操作'),
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
            h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => void action('restart') }, '重启桥接'),
          ),
          h('div', { className: 'bbh-card' },
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
        ) : null,

        status === null ? null : tab === 'advanced' ? h('div', { className: 'bbh-card' },
          h('h3', { className: 'bbh-card-title' }, '原始设置 JSON'),
          h('p', { className: 'bbh-note' }, '对应 ~/.dsh/st-bridge/settings.json。authToken 留空表示保持现有值；host/port 修改后需要重启桥接；stateDir 只能在 cordis.patch.yml 中修改。'),
          h('textarea', { className: 'bbh-textarea', style: { minHeight: '300px' }, value: rawText, onChange: e => setRawText(e.target.value), spellCheck: false }),
          h('div', { className: 'bbh-actions' },
            h('button', { type: 'button', className: 'bbh-btn', disabled: busy, onClick: () => void saveRaw() }, busy ? '保存中…' : '保存原始配置'),
            h('button', { type: 'button', className: 'bbh-btn secondary', disabled: busy, onClick: () => { setRawLoaded(false) } }, '重新读取'),
          ),
        ) : null,
      )
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        const rpcCall = (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, payload)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'st-bridge',
          order: 58,
          label: () => 'ST-bridge',
          inject: () => ({ rpcCall }),
        }, Panel))
      },
    }
  },
})
