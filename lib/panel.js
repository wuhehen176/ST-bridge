import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { badRequest, conflict } from './errors.js'
import { clientLabel, normalizeClientId, normalizeTaskId, resolveScope } from './session-protocol.js'
import { normalizeSnapshotMarker } from './snapshot-diff.js'
import { clampInteger, ensureDir, isPlainObject, readJsonFile, writeJsonAtomic } from './util.js'

const SETTINGS_FILE = 'settings.json'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const EDITABLE_KEYS = [
  'host',
  'port',
  'provider',
  'model',
  'agentPreset',
  'cwd',
  'maxTokens',
  'requestTimeoutMs',
  'maxBodyBytes',
  'authToken',
  'allowLegacyPlain',
  'sessionOnStale',
  'sessionOnArchived',
  'contextOverflow',
  'transientRetry',
  'appendFormat',
  'appendNonce',
  'allowExtensionOrigins',
  'allowNullOrigin',
  'allowRemote',
  'corsOrigins',
  'allowedClientIds',
  'plainCompat',
  'inputCleanup',
  'snapshotDiff',
]

function optionalString(value, name, maxLength = 1024) {
  if (value === undefined) return undefined
  if (value === null) return ''
  if (typeof value !== 'string') throw badRequest(`${name} 必须是字符串`, 'invalid_settings')
  if (value.length > maxLength) throw badRequest(`${name} 过长`, 'invalid_settings')
  return value.trim()
}

function optionalBoolean(value, name) {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw badRequest(`${name} 必须是布尔值`, 'invalid_settings')
  return value
}

function optionalInteger(value, name, min, max, allowNull = false) {
  if (value === undefined) return undefined
  if (value === null && allowNull) return null
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${name} 必须是 ${min}-${max} 之间的整数`, 'invalid_settings')
  }
  return value
}

function parseOrigins(value) {
  if (value === undefined) return undefined
  if (value === null || value === '') return []
  if (Array.isArray(value)) {
    if (!value.every(item => typeof item === 'string')) throw badRequest('corsOrigins 必须是字符串数组', 'invalid_settings')
    return value.map(item => item.trim()).filter(Boolean)
  }
  if (typeof value === 'string') return value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean)
  throw badRequest('corsOrigins 必须是数组或逗号/换行分隔的字符串', 'invalid_settings')
}

/**
 * Validate and normalize panel-editable settings against the current config.
 * Only safe, known keys are accepted; stateDir is deliberately not editable.
 */
export function sanitizeSettings(input, current) {
  if (!isPlainObject(input)) throw badRequest('设置必须是 JSON 对象', 'invalid_settings')
  const allowRemote = optionalBoolean(input.allowRemote, 'allowRemote') ?? current.allowRemote === true
  const next = {}

  if (input.host !== undefined) {
    const host = optionalString(input.host, 'host', 255)
    if (!LOCAL_HOSTS.has(host) && !allowRemote) {
      throw badRequest('host 只允许 127.0.0.1 / localhost / ::1；需要局域网时请同时开启 allowRemote', 'invalid_settings')
    }
    next.host = host
  }
  {
    const effectiveHost = next.host ?? current.host ?? '127.0.0.1'
    if (!LOCAL_HOSTS.has(effectiveHost) && !allowRemote) {
      throw badRequest('当前 host 不是本机地址，但 allowRemote 未开启', 'invalid_settings')
    }
  }
  if (input.port !== undefined) next.port = optionalInteger(input.port, 'port', 0, 65535)
  if (input.provider !== undefined) next.provider = optionalString(input.provider, 'provider', 128)
  if (input.model !== undefined) next.model = optionalString(input.model, 'model', 256)
  {
    const provider = next.provider ?? current.provider ?? ''
    const model = next.model ?? current.model ?? ''
    if (Boolean(provider) !== Boolean(model)) {
      throw badRequest('provider 和 model 需要同时填写，或同时留空跟随 DSH 默认', 'invalid_settings')
    }
  }
  if (input.agentPreset !== undefined) {
    const preset = optionalString(input.agentPreset, 'agentPreset', 128)
    if (preset === '') throw badRequest('agentPreset 不能为空', 'invalid_settings')
    next.agentPreset = preset
  }
  if (input.cwd !== undefined) next.cwd = optionalString(input.cwd, 'cwd', 2048)
  if (input.maxTokens !== undefined) next.maxTokens = optionalInteger(input.maxTokens, 'maxTokens', 1, Number.MAX_SAFE_INTEGER, true)
  if (input.requestTimeoutMs !== undefined) {
    next.requestTimeoutMs = optionalInteger(input.requestTimeoutMs, 'requestTimeoutMs', 5_000, 24 * 60 * 60 * 1000)
  }
  if (input.maxBodyBytes !== undefined) {
    next.maxBodyBytes = optionalInteger(input.maxBodyBytes, 'maxBodyBytes', 1024, 256 * 1024 * 1024)
  }
  if (input.allowRemote !== undefined) next.allowRemote = allowRemote
  if (input.allowLegacyPlain !== undefined) next.allowLegacyPlain = optionalBoolean(input.allowLegacyPlain, 'allowLegacyPlain')
  if (input.sessionOnStale !== undefined) {
    next.sessionOnStale = input.sessionOnStale === 'recreate' || input.sessionOnStale === true ? 'recreate' : 'error'
  }
  if (input.sessionOnArchived !== undefined) {
    next.sessionOnArchived = input.sessionOnArchived === 'recreate' || input.sessionOnArchived === true ? 'recreate' : 'error'
  }
  if (input.contextOverflow !== undefined) {
    next.contextOverflow = input.contextOverflow === 'recreate' || input.contextOverflow === true ? 'recreate' : 'error'
  }
  if (input.transientRetry !== undefined) {
    next.transientRetry = optionalInteger(input.transientRetry, 'transientRetry', 0, 2)
  }
  if (input.appendFormat !== undefined) {
    next.appendFormat = input.appendFormat === 'tagged' ? 'tagged' : 'nonce'
  }
  if (input.appendNonce !== undefined) {
    const raw = String(input.appendNonce ?? '').trim().toUpperCase().replace(/^STB-/, '')
    if (raw !== '' && !/^[A-F0-9]{8,32}$/.test(raw)) {
      throw badRequest('appendNonce 必须是 8-32 位十六进制', 'invalid_settings')
    }
    next.appendNonce = raw
  }
  if (input.allowExtensionOrigins !== undefined) {
    next.allowExtensionOrigins = optionalBoolean(input.allowExtensionOrigins, 'allowExtensionOrigins')
  }
  if (input.allowNullOrigin !== undefined) next.allowNullOrigin = optionalBoolean(input.allowNullOrigin, 'allowNullOrigin')
  if (input.corsOrigins !== undefined) next.corsOrigins = parseOrigins(input.corsOrigins)
  if (input.allowedClientIds !== undefined) {
    const raw = Array.isArray(input.allowedClientIds)
      ? input.allowedClientIds
      : String(input.allowedClientIds ?? '').split(/[\n,]+/)
    const list = raw.map(item => String(item).trim()).filter(Boolean)
    for (const item of list) normalizeClientId(item)
    next.allowedClientIds = [...new Set(list)]
  }
  if (input.plainCompat !== undefined) {
    if (!isPlainObject(input.plainCompat)) throw badRequest('plainCompat 必须是对象', 'invalid_settings')
    const enabled = optionalBoolean(input.plainCompat.enabled, 'plainCompat.enabled')
      ?? (current.plainCompat?.enabled === true)
    const clientId = normalizeClientId(input.plainCompat.clientId ?? current.plainCompat?.clientId ?? 'yuzi-phone') ?? 'yuzi-phone'
    const chatId = optionalString(input.plainCompat.chatId ?? current.plainCompat?.chatId ?? 'yuzi-phone', 'plainCompat.chatId', 256)
    if (chatId === '') throw badRequest('plainCompat.chatId 不能为空', 'invalid_settings')
    const taskId = normalizeTaskId(input.plainCompat.taskId ?? current.plainCompat?.taskId ?? 'default')
    const fixedMessageCount = optionalInteger(
      input.plainCompat.fixedMessageCount ?? current.plainCompat?.fixedMessageCount ?? 0,
      'plainCompat.fixedMessageCount', 0, 4,
    )
    let fixedMessageTypes = input.plainCompat.fixedMessageTypes ?? current.plainCompat?.fixedMessageTypes ?? []
    if (!Array.isArray(fixedMessageTypes) || !fixedMessageTypes.every(type => typeof type === 'string')) {
      throw badRequest('plainCompat.fixedMessageTypes 必须是字符串数组', 'invalid_settings')
    }
    fixedMessageTypes = fixedMessageTypes.map(type => type.trim()).filter(Boolean)
    if (fixedMessageTypes.length !== fixedMessageCount) {
      throw badRequest('plainCompat.fixedMessageTypes 必须与 fixedMessageCount 逐条对应', 'invalid_settings')
    }
    if (new Set(fixedMessageTypes).size !== fixedMessageTypes.length) {
      throw badRequest('plainCompat.fixedMessageTypes 不能重复', 'invalid_settings')
    }
    for (const type of fixedMessageTypes) {
      if (!['prefix', 'spec', 'contract', 'check'].includes(type)) {
        throw badRequest(`plainCompat.fixedMessageTypes 只能是 prefix/spec/contract/check: ${type}`, 'invalid_settings')
      }
    }
    next.plainCompat = { enabled, clientId, chatId, taskId, fixedMessageCount, fixedMessageTypes }
  }
  if (input.inputCleanup !== undefined) {
    if (!isPlainObject(input.inputCleanup)) throw badRequest('inputCleanup 必须是对象', 'invalid_settings')
    const enabled = optionalBoolean(input.inputCleanup.enabled, 'inputCleanup.enabled')
      ?? (current.inputCleanup?.enabled !== false)
    const rawTags = input.inputCleanup.tags ?? current.inputCleanup?.tags ?? ['bbi_image']
    if (!Array.isArray(rawTags) || rawTags.length === 0 || rawTags.length > 8) {
      throw badRequest('inputCleanup.tags 必须是 1-8 个标签名', 'invalid_settings')
    }
    const tags = [...new Set(rawTags.map(tag => String(tag).trim()).filter(Boolean))]
    for (const tag of tags) {
      if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(tag)) throw badRequest(`inputCleanup 标签名无效: ${tag}`, 'invalid_settings')
    }
    if (tags.length === 0) throw badRequest('inputCleanup.tags 不能为空', 'invalid_settings')
    next.inputCleanup = { enabled, tags }
  }
  if (input.snapshotDiff !== undefined) {
    if (!isPlainObject(input.snapshotDiff)) throw badRequest('snapshotDiff 必须是对象', 'invalid_settings')
    const enabled = optionalBoolean(input.snapshotDiff.enabled, 'snapshotDiff.enabled')
      ?? (current.snapshotDiff?.enabled === true)
    const rawMarker = input.snapshotDiff.marker ?? current.snapshotDiff?.marker ?? ''
    const marker = normalizeSnapshotMarker(rawMarker)
    if (String(rawMarker).trim() !== '' && marker === '') {
      throw badRequest('snapshotDiff.marker 必须是 8-32 位十六进制', 'invalid_settings')
    }
    const rawClients = input.snapshotDiff.clients ?? current.snapshotDiff?.clients ?? ['shujuku', 'yuzi-phone']
    if (!Array.isArray(rawClients) || rawClients.length > 32) {
      throw badRequest('snapshotDiff.clients 必须是数组（最多32个）', 'invalid_settings')
    }
    const clients = [...new Set(rawClients.map(client => String(client).trim()).filter(Boolean))]
    for (const client of clients) normalizeClientId(client)
    const onDivergence = input.snapshotDiff.onDivergence === 'branch'
      ? 'branch'
      : (input.snapshotDiff.onDivergence === 'full' ? 'full' : (current.snapshotDiff?.onDivergence ?? 'full'))
    const mode = input.snapshotDiff.mode === 'marker'
      ? 'marker'
      : (input.snapshotDiff.mode === 'auto' ? 'auto' : (current.snapshotDiff?.mode ?? 'auto'))
    const maxBlockChars = optionalInteger(
      input.snapshotDiff.maxBlockChars ?? current.snapshotDiff?.maxBlockChars ?? 2000,
      'snapshotDiff.maxBlockChars', 64, 20000,
    )
    next.snapshotDiff = { enabled, mode, marker, maxBlockChars, clients, onDivergence }
  }

  if (input.clearAuthToken === true) {
    next.authToken = ''
  } else if (input.authToken !== undefined) {
    // An empty field means "leave the stored token unchanged" so the panel
    // never needs to display a secret.
    const token = optionalString(input.authToken, 'authToken', 4096)
    if (token !== '' && token !== '<set>' && token !== '<redacted>') next.authToken = token
  }

  if (next.cwd !== undefined) {
    if (next.cwd === '') throw badRequest('cwd 不能为空', 'invalid_settings')
    ensureDir(next.cwd)
  }
  return { settings: next, warnings: [] }
}

export function panelSettingsPath(stateDir) {
  return join(stateDir, SETTINGS_FILE)
}

function lanBridgeUrls(port) {
  const urls = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      urls.push(`http://${item.address}:${port}/v1`)
    }
  }
  return [...new Set(urls)]
}

/** Apply persisted panel settings on Host boot. Invalid values are ignored. */
export function applyPersistedSettings(config) {
  const file = panelSettingsPath(config.stateDir)
  let raw
  try {
    raw = readJsonFile(file, undefined)
  } catch (error) {
    return { applied: false, warnings: [`设置文件无法解析，已忽略: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!isPlainObject(raw)) return { applied: false, warnings: [] }
  try {
    const { settings } = sanitizeSettings(raw, config)
    Object.assign(config, settings)
    return { applied: true, warnings: [] }
  } catch (error) {
    return { applied: false, warnings: [error instanceof Error ? error.message : String(error)] }
  }
}

function persistedSettings(config) {
  const settings = {}
  for (const key of EDITABLE_KEYS) {
    if (config[key] !== undefined) settings[key] = config[key]
  }
  // Empty authToken normally means "keep current" in the panel. Persisting an
  // explicit clear flag lets a boot with a token from cordis.patch.yml still
  // honor a later panel-side clear.
  settings.clearAuthToken = !config.authToken
  return settings
}

function readTail(file, maxBytes = 32 * 1024) {
  try {
    const text = readFileSync(file, 'utf8')
    const tail = text.length > maxBytes ? text.slice(-maxBytes) : text
    return tail.split(/\r?\n/).slice(-120).join('\n')
  } catch {
    return ''
  }
}

/**
 * Host-side controller for the DSH settings panel. The browser half calls
 * these endpoints through connection.rpc.
 */
export class PanelController {
  constructor({ ctx, config, store, engine, serverControl, log, version }) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.engine = engine
    this.serverControl = serverControl
    this.log = log
    this.version = version
    this.stateDir = config.stateDir
    this.settingsFile = panelSettingsPath(config.stateDir)
    this.logFile = join(config.stateDir, 'bridge.log')
  }

  async call(endpoint, payload) {
    try {
      switch (endpoint) {
        case 'status': return { ok: true, value: this.status() }
        case 'save': return { ok: true, value: this.save(payload) }
        case 'raw': return { ok: true, value: this.raw() }
        case 'save_raw': return { ok: true, value: await this.saveRaw(payload) }
        case 'action': return { ok: true, value: await this.action(payload) }
        case 'rules': return { ok: true, value: this.rules(payload) }
        case 'presets': return { ok: true, value: this.presets() }
        case 'save_presets': return { ok: true, value: this.engine.presetConfigs.save(payload) }
        default:
          return { ok: false, error: { code: 'not-found', message: `未知设置接口 ${JSON.stringify(endpoint)}`, details: {} } }
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'panel-error',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      }
    }
  }

  status() {
    const chats = this.store.listChats()
      .slice()
      .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
      .map(chat => ({
        client_id: chat.clientId ?? 'baibai-image',
        client_label: clientLabel(chat.clientId),
        chat_id: chat.chatId,
        task_id: chat.taskId ?? 'default',
        session_id: chat.sessionId,
        title: chat.title,
        fixed_rule_types: chat.fixedRules?.map(rule => rule.type) ?? [],
        known_messages: chat.knownMessages?.length ?? 0,
        protocol: chat.protocol ?? null,
        last_target: chat.lastTarget ?? null,
        previous_sessions: chat.previousSessions?.length ?? 0,
        updated_at: chat.updatedAt,
      }))
    const sessions = new Set(chats.map(chat => chat.session_id).filter(Boolean))
    return {
      running: this.serverControl.isRunning(),
      active: this.serverControl.address?.() ?? null,
      version: this.version,
      state_dir: this.stateDir,
      settings_file: this.settingsFile,
      log_file: this.logFile,
      service: {
        host: this.config.host,
        port: this.config.port,
        requestTimeoutMs: this.config.requestTimeoutMs,
        maxBodyBytes: this.config.maxBodyBytes,
        authTokenSet: Boolean(this.config.authToken),
        allowLegacyPlain: this.config.allowLegacyPlain === true,
        sessionOnStale: this.config.sessionOnStale ?? 'error',
        sessionOnArchived: this.config.sessionOnArchived ?? 'error',
        contextOverflow: this.config.contextOverflow ?? 'error',
        transientRetry: this.config.transientRetry ?? 0,
        appendFormat: this.config.appendFormat ?? 'nonce',
        appendNonce: this.config.appendNonce ?? '7F3A9C2E',
        allowRemote: this.config.allowRemote === true,
        allowExtensionOrigins: this.config.allowExtensionOrigins !== false,
        allowNullOrigin: this.config.allowNullOrigin === true,
        corsOrigins: this.config.corsOrigins ?? [],
        allowedClientIds: this.config.allowedClientIds ?? [],
        plainCompat: this.config.plainCompat ?? { enabled: false, clientId: 'yuzi-phone', chatId: 'yuzi-phone', taskId: 'default', fixedMessageCount: 0, fixedMessageTypes: [] },
        inputCleanup: this.config.inputCleanup ?? { enabled: true, tags: ['bbi_image'] },
        snapshotDiff: this.config.snapshotDiff ?? { enabled: false, mode: 'auto', marker: '', maxBlockChars: 2000, clients: ['shujuku', 'yuzi-phone'], onDivergence: 'full' },
      },
      network: {
        mobileEnabled: !['127.0.0.1', 'localhost', '::1'].includes(this.config.host),
        urls: lanBridgeUrls(this.config.port),
        tokenSet: Boolean(this.config.authToken),
      },
      model: {
        provider: this.config.provider ?? '',
        model: this.config.model ?? '',
        agentPreset: this.config.agentPreset ?? '',
        cwd: this.config.cwd ?? '',
        maxTokens: this.config.maxTokens ?? null,
      },
      counts: {
        scopes: chats.length,
        sessions: sessions.size,
        fixed_rules: chats.reduce((sum, chat) => sum + chat.fixed_rule_types.length, 0),
      },
      chats,
      capabilities: this.engine.capabilities(),
      log_tail: readTail(this.logFile),
    }
  }

  save(payload) {
    const input = isPlainObject(payload?.settings) ? payload.settings : payload
    const before = { ...this.config }
    const { settings, warnings } = sanitizeSettings(input, this.config)
    Object.assign(this.config, settings)
    try {
      ensureDir(this.config.stateDir)
      writeJsonAtomic(this.settingsFile, persistedSettings(this.config))
    } catch (error) {
      Object.assign(this.config, before)
      throw error
    }
    const restartRequired = before.host !== this.config.host || before.port !== this.config.port
    this.log(`[panel] 设置已保存${restartRequired ? '（host/port 需重启桥接服务）' : ''}`)
    return {
      ok: true,
      applied: Object.keys(settings),
      restart_required: restartRequired,
      warnings,
      status: this.status(),
    }
  }

  raw() {
    return {
      settings_file: this.settingsFile,
      settings: { ...persistedSettings(this.config), authToken: '' },
      authTokenSet: Boolean(this.config.authToken),
      effective: {
        ...persistedSettings(this.config),
        authToken: this.config.authToken ? '<set>' : '',
        stateDir: this.config.stateDir,
      },
      restart_required: false,
    }
  }

  async saveRaw(payload) {
    if (!isPlainObject(payload)) throw badRequest('原始配置必须是 JSON 对象', 'invalid_settings')
    const settings = isPlainObject(payload.settings) ? payload.settings : payload
    const result = this.save({ settings })
    if (payload.restart === true) {
      await this.serverControl.restart()
      return { ...result, restarted: true }
    }
    return result
  }

  async action(payload) {
    if (!isPlainObject(payload)) throw badRequest('action 必须是对象', 'invalid_action')
    const action = String(payload.action ?? '')
    if (action === 'enable_mobile_access') {
      const generated = !this.config.authToken
      if (generated) this.config.authToken = randomBytes(24).toString('hex')
      this.config.allowRemote = true
      this.config.host = '0.0.0.0'
      ensureDir(this.config.stateDir)
      writeJsonAtomic(this.settingsFile, persistedSettings(this.config))
      await this.serverControl.restart()
      this.log(`[panel] 已开启局域网访问 port=${this.config.port}`)
      return {
        ok: true,
        restarted: true,
        token: generated ? this.config.authToken : null,
        tokenSet: true,
        urls: lanBridgeUrls(this.config.port),
      }
    }
    if (action === 'disable_mobile_access') {
      this.config.allowRemote = false
      this.config.host = '127.0.0.1'
      ensureDir(this.config.stateDir)
      writeJsonAtomic(this.settingsFile, persistedSettings(this.config))
      await this.serverControl.restart()
      this.log('[panel] 已关闭局域网访问')
      return { ok: true, restarted: true }
    }
    if (action === 'rotate_append_nonce') {
      const nonce = randomBytes(6).toString('hex').toUpperCase()
      this.config.appendNonce = nonce
      ensureDir(this.config.stateDir)
      writeJsonAtomic(this.settingsFile, persistedSettings(this.config))
      this.log(`[panel] 已生成新的追加分隔标记 ${nonce}`)
      return { ok: true, nonce }
    }
    if (action === 'rotate_snapshot_marker') {
      const marker = randomBytes(6).toString('hex').toUpperCase()
      const current = this.config.snapshotDiff ?? {}
      this.config.snapshotDiff = { ...current, enabled: true, marker }
      ensureDir(this.config.stateDir)
      writeJsonAtomic(this.settingsFile, persistedSettings(this.config))
      this.log(`[panel] 已生成新的快照标记 ${marker}`);
      return { ok: true, marker }
    }
    if (action === 'reset_preset') {
      const scope = this.scopeFrom(payload)
      const chat = this.store.getChat(scope.scopeKey)
      if (!chat) return { ok: false, reason: 'no-binding' }
      this.store.updateChat(scope.scopeKey, { presetManagement: null, presetDiagnostic: null })
      this.log(`[panel] 清除固定预设安装状态 ${scope.clientId}/${scope.chatId}/${scope.taskId}`)
      return { ok: true, action }
    }
    if (action === 'reset_binding') {
      const scope = this.scopeFrom(payload)
      return { ...this.engine.resetScoped(scope), action }
    }
    if (action === 'clear_rules') {
      const scope = this.scopeFrom(payload)
      return { ...this.engine.clearRules(scope), action }
    }
    if (action === 'clear_bindings') {
      if (payload.confirm !== 'RESET') {
        throw conflict('清空全部绑定需要输入确认词 RESET', 'confirmation_required')
      }
      if (this.engine.queues?.size > 0) {
        throw conflict('仍有请求正在处理，请等待完成后再清空绑定', 'chat_busy')
      }
      const removed = this.store.clearAll()
      this.log(`[panel] 清空全部绑定 ${removed} 个 scope`)
      return { ok: true, action, removed }
    }
    if (action === 'stop') {
      await this.serverControl.stop()
      return { ok: true, action, running: false }
    }
    if (action === 'start') {
      await this.serverControl.start()
      return { ok: true, action, running: true }
    }
    if (action === 'restart') {
      await this.serverControl.restart()
      return { ok: true, action, running: true, status: this.status() }
    }
    if (action === 'open_log') {
      return { ok: true, action, path: this.logFile }
    }
    throw badRequest(`未知 action ${JSON.stringify(action)}`, 'invalid_action')
  }

  rules(payload) {
    const scope = this.scopeFrom(payload)
    const chat = this.store.getChat(scope.scopeKey)
    return {
      client_id: scope.clientId,
      client_label: clientLabel(scope.clientId),
      chat_id: scope.chatId,
      task_id: scope.taskId,
      session_id: chat?.sessionId ?? '',
      title: chat?.title ?? '',
      fixed_rules: (chat?.fixedRules ?? []).map(rule => ({ type: rule.type, role: rule.role, text: rule.text })),
    }
  }

  presets() {
    const configs = this.engine.presetConfigs.list()
    const chats = this.store.listChats()
    return {
      ...configs,
      // Per-scope install state, hashes only. No preset body and no chat text.
      installs: chats
        .filter(chat => chat.presetManagement || chat.presetDiagnostic)
        .map(chat => ({
          client_id: chat.clientId ?? 'baibai-image',
          client_label: clientLabel(chat.clientId),
          chat_id: chat.chatId,
          task_id: chat.taskId ?? 'default',
          session_id: chat.sessionId ?? '',
          preset_id: chat.presetManagement?.presetId ?? null,
          rule_hash: chat.presetManagement?.hash ?? null,
          installed_at: chat.presetManagement?.installedAt ?? null,
          last_status: chat.presetDiagnostic?.status ?? null,
          last_reason: chat.presetDiagnostic?.reason ?? null,
          original_chars: chat.presetDiagnostic?.original_chars ?? null,
          deduped_chars: chat.presetDiagnostic?.deduped_chars ?? null,
        })),
    }
  }

  scopeFrom(payload) {
    const chatId = String(payload?.chat_id ?? payload?.chatId ?? '').trim()
    if (!chatId) throw badRequest('缺少 chat_id', 'missing_chat_id')
    const clientId = normalizeClientId(payload?.client_id ?? payload?.clientId)
    const taskId = normalizeTaskId(payload?.task_id ?? payload?.taskId)
    return resolveScope({ clientId, chatId, taskId })
  }
}

const CHANNEL = '/st-bridge'
const RPC_BODY_LIMIT = 1024 * 1024

function rejectRequest(ctx, req) {
  try {
    const rejection = ctx.connection?.requestRejection?.({ headers: req.headers })
    if (rejection !== undefined) return rejection
    if (typeof ctx.connection?.requestRejection === 'function') return undefined
  } catch {
    // Fall through to the loopback rule.
  }
  const host = String(req.headers.host ?? '').replace(/:\d+$/u, '').replace(/^\[|\]$/gu, '')
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' ? undefined : 403
}

async function readRpcBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > RPC_BODY_LIMIT) throw badRequest('设置请求体过大', 'payload_too_large')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw badRequest('设置请求体不是合法 JSON', 'invalid_json')
  }
}

function sendRpcJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Register the browser settings channel. Prefer DSH's own connection RPC
 * registry (it applies the browser trust fence); fall back to a guarded Web
 * route with the same envelope.
 */
export function registerPanelRpc(ctx, panel, log) {
  try {
    const handle = ctx.connection?.rpc?.handle
    if (typeof handle === 'function') {
      const dispose = handle.call(ctx.connection.rpc, CHANNEL, (endpoint, payload) => panel.call(endpoint, payload))
      if (typeof dispose === 'function') return dispose
    }
  } catch (error) {
    log(`[panel] connection.rpc.handle 不可用，改用 Web 路由: ${error instanceof Error ? error.message : String(error)}`)
  }

  const webServer = ctx.webServer
  if (!webServer?.register) {
    log('[panel] webServer 不可用，设置页无法连接 Host')
    return undefined
  }
  const route = {
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      try {
        const rejection = rejectRequest(ctx, req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
        const endpoint = decodeURIComponent(pathname.slice(CHANNEL.length).replace(/^\/+/u, ''))
        const message = await readRpcBody(req)
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
        if (message?.type !== 'client-request' || message.method !== endpoint) {
          sendRpcJson(res, 400, {
            type: 'server-response',
            rpcId,
            result: { ok: false, error: { code: 'bad-request', message: '请求信封与 endpoint 不匹配', details: {} } },
          })
          return
        }
        sendRpcJson(res, 200, { type: 'server-response', rpcId, result: await panel.call(endpoint, message.payload) })
      } catch (error) {
        log(`[panel] RPC 失败: ${error instanceof Error ? error.message : String(error)}`)
        if (!res.headersSent) {
          sendRpcJson(res, 500, {
            type: 'server-response',
            rpcId: 'invalid-request',
            result: { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} } },
          })
        } else {
          res.destroy()
        }
      }
    },
  }
  return webServer.register(route)
}
