import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { ContextProfiles, parseContextRequest, applyContextProfile, contextAudit as buildContextAudit } from './context-policy.js'
import { cleanMessagesForProjection } from './input-cleanup.js'
import { diffAgainstSnapshot, normalizeSnapshotMarker, snapshotOf, stripMarkersInMessages } from './snapshot-diff.js'
import {
  PRESET_SECTION,
  PresetConfigs,
  carriesManagedPreset,
  formatManagedPreset,
  identifyPreset,
  presetDiagnostic,
  presetSpansWithin,
  reuseDecision,
  stripPresetForRendering,
} from './preset-policy.js'
import {
  baseMessagesFor,
  classifyContext,
  composeAppendPrompt,
  composeInitialPrompt,
  composeReplayPrompt,
  deriveTitle,
  normalizeMessages,
  withAssistant,
} from './context.js'
import { BridgeError, badRequest, conflict, sessionGone, timeoutError, upstreamError } from './errors.js'
import {
  applyRuntimeParams,
  formatDynamicSystem,
  formatFixedRules,
  formatTurnPolicy,
  isSessionNotFound,
  normalizeClientId,
  normalizeTaskId,
  parseAction,
  parseFixedRules,
  parseTarget,
  resolveScope,
  scopedTitle,
  sessionIdFor,
  TURN_POLICY_SECTION,
} from './session-protocol.js'
import { newChatRecord } from './store.js'
import { recoverTurn } from './turn.js'
import { clampInteger, hashRequest, nowIso, samePath, sha256, sleep } from './util.js'

const POLL_INTERVAL_MS = 300
const SESSION_TITLE_MAX = 120

function isContextLengthError(message) {
  // Avoid matching a provider's generic "clear context" hint: a blocked
  // provider session is not the same as a DSH context-length error.
  return /context\s+length|too many tokens|maximum context|token limit|上下文.{0,8}(?:超|长)|超出.{0,8}上下文|超过.{0,8}上下文/i.test(message)
}

function isProviderSessionBlocked(message) {
  return /session\s+blocked|\b406\b[^\n]*model_error|model_error[^\n]*session\s+blocked/i.test(message)
}

function isAccountError(message) {
  return /quota|balance|credit|unauthorized|invalid api key|authentication|401|403/i.test(message)
}

/**
 * Owns DSH Agent sessions and the chat_id -> session_id mapping.
 *
 * This class never talks to a model provider directly. It creates ordinary DSH
 * sessions through ctx.agents, so every bridge chat remains visible and
 * continuable in the DSH UI.
 */
export class BridgeEngine {
  constructor(ctx, config, store, log) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.log = log
    this.queues = new Map()
    this.pending = new Map()
    this.handles = new Map()
    this.runtimes = new Map()
    this.reasoningCache = new Map()
    this.contextProfiles = new ContextProfiles(join(config.stateDir || (store.file ? dirname(store.file) : process.cwd()), 'context-profiles.json'))
    this.presetConfigs = new PresetConfigs(join(config.stateDir || (store.file ? dirname(store.file) : process.cwd()), 'fixed-presets.json'))
  }

  runtimeFor(sessionId, fixedRules) {
    let runtime = this.runtimes.get(sessionId)
    if (!runtime) {
      runtime = { sessionId, fixedRules: [], dynamicSystem: [], params: {} }
      this.runtimes.set(sessionId, runtime)
    }
    if (Array.isArray(fixedRules)) runtime.fixedRules = fixedRules
    return runtime
  }

  getService(name) {
    try {
      return this.ctx.get?.(name)
    } catch {
      return undefined
    }
  }

  async supportedReasoningEfforts(provider, model) {
    if (!provider || !model) return undefined
    const key = `${provider}/${model}`
    if (this.reasoningCache.has(key)) return this.reasoningCache.get(key)
    const llm = this.getService('llm')
    let efforts
    if (typeof llm?.resolveModelInfo === 'function') {
      try {
        const info = await llm.resolveModelInfo(provider, model)
        const raw = info?.reasoning?.efforts
        efforts = Array.isArray(raw)
          ? raw.map(item => (typeof item === 'string' ? item : item?.id)).filter(Boolean)
          : []
      } catch (error) {
        this.log(`[dsh-session] 读取模型 reasoning 能力失败 ${provider}/${model}: ${error instanceof Error ? error.message : String(error)}`)
        efforts = undefined
      }
    }
    if (Array.isArray(efforts)) this.reasoningCache.set(key, efforts)
    return efforts
  }

  async handle(input) {
    const chatId = String(input.chatId ?? '').trim()
    const requestId = String(input.requestId ?? '').trim()
    if (!chatId) throw badRequest('缺少 chat_id', 'missing_chat_id')
    if (!requestId) throw badRequest('缺少 request_id', 'missing_request_id')
    if (chatId.length > 256) throw badRequest('chat_id 过长', 'invalid_chat_id')
    if (requestId.length > 256) throw badRequest('request_id 过长', 'invalid_request_id')
    const allowedClients = Array.isArray(this.config.allowedClientIds) ? this.config.allowedClientIds : []
    if (allowedClients.length > 0 && !allowedClients.includes('baibai-image')) {
      throw new BridgeError(403, 'client_not_allowed', '旧式普通补全按 baibai-image 处理，但该 client_id 不在允许列表中')
    }

    const { messages } = normalizeMessages(input.messages)
    const contextMode = input.contextMode ?? 'auto'
    const requestHash = hashRequest({
      messages: messages.map(message => message.hash),
      contextMode,
    })

    const existing = this.store.getRequest(chatId, requestId)
    if (existing) {
      if (existing.requestHash && existing.requestHash !== requestHash) {
        throw conflict('同一个 request_id 对应了不同的请求内容；请换一个新的 request_id', 'request_id_conflict')
      }
      if (existing.status === 'done') {
        return {
          answer: existing.answer ?? '',
          usage: existing.usage,
          finishReason: existing.finishReason ?? 'stop',
          sessionId: existing.sessionId,
          turn: existing.turn,
          idempotent: true,
          branch: false,
        }
      }
      if (existing.status === 'error') {
        throw new BridgeError(
          existing.httpStatus ?? 502,
          existing.errorCode ?? 'request_failed',
          existing.errorMessage ?? '此前使用该 request_id 的请求已失败；如需重试请使用新的 request_id',
        )
      }
      if (existing.status === 'pending') {
        const inFlight = this.pending.get(this.pendingKey(chatId, requestId))
        if (inFlight) return inFlight
        const recovered = await this.tryRecover(chatId, requestId, existing)
        if (recovered) return recovered
        throw conflict('该 request_id 仍在处理中，或上次进程在回合结束前中断；请稍后重试', 'request_in_progress')
      }
    }

    const key = this.pendingKey(chatId, requestId)
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const promise = this.enqueue(chatId, () => this.run({
      chatId,
      requestId,
      messages,
      contextMode,
      title: input.title,
      maxTokens: input.maxTokens,
      requestHash,
    }))
    this.pending.set(key, promise)
    try {
      return await promise
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key)
    }
  }

  pendingKey(chatId, requestId) {
    return `${chatId}\u0000${requestId}`
  }

  enqueue(chatId, operation) {
    const previous = this.queues.get(chatId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    const tail = current.then(() => undefined, () => undefined)
    this.queues.set(chatId, tail)
    return current.finally(() => {
      if (this.queues.get(chatId) === tail) this.queues.delete(chatId)
    })
  }

  async run({ chatId, requestId, messages, contextMode, title, maxTokens, requestHash }) {
    let chat = this.store.getChat(chatId)
    if (!chat) {
      chat = newChatRecord({
        chatId,
        sessionId: '',
        title: deriveTitle(chatId, messages, title),
        cwd: this.effectiveCwd(),
        provider: '',
        model: '',
        agentPreset: this.config.agentPreset,
      })
      this.store.putChat(chatId, chat)
    }

    let classification = classifyContext(chat.knownMessages ?? [], messages, contextMode)
    if (classification.kind === 'duplicate') {
      throw conflict('这批消息已经全部发送过，没有新增内容；如要重新生成请使用 context_mode=branch 或提供新的 request_id', 'duplicate_context')
    }

    let sessionId = chat.sessionId
    let base = baseMessagesFor({ classification, previousKnown: chat.knownMessages ?? [], incoming: messages })
    let branch = false

    if (!sessionId || ['initial', 'branch', 'regenerate'].includes(classification.kind)) {
      const created = await this.createSession(chat, messages, title, maxTokens, classification.reason)
      sessionId = created
      branch = classification.kind === 'branch' || classification.kind === 'regenerate'
      base = baseMessagesFor({ classification, previousKnown: chat.knownMessages ?? [], incoming: messages })
      chat = this.store.updateChat(chatId, {
        sessionId,
        knownMessages: base,
        title: deriveTitle(chatId, messages, title),
        cwd: this.effectiveCwd(),
        agentPreset: this.config.agentPreset,
        previousSessions: this.previousSessions(chat, sessionId, classification.reason),
        generation: (chat.generation ?? 1) + 1,
      }) ?? chat
    } else {
      try {
        await this.ensureSession(chat, maxTokens)
        chat = this.store.updateChat(chatId, { knownMessages: base }) ?? chat
      } catch (error) {
        if (!classification.fullContext) {
          throw conflict(
            `无法恢复 DSH 会话 ${sessionId}，且本次请求只包含增量内容，无法重建完整上下文。请发送完整 messages，或先重置绑定。原始错误：${error.message}`,
            'session_unavailable',
          )
        }
        if (error instanceof BridgeError && error.code === 'session_archived') throw error
        this.log(`[bridge] 会话恢复失败，改为重建分支 ${sessionId}: ${error.message}`)
        classification = { kind: 'branch', replay: messages, reason: 'session_unavailable' }
        const created = await this.createSession(chat, messages, title, maxTokens, classification.reason)
        sessionId = created
        branch = true
        base = messages
        chat = this.store.updateChat(chatId, {
          sessionId,
          knownMessages: base,
          title: deriveTitle(chatId, messages, title),
          previousSessions: this.previousSessions(chat, sessionId, classification.reason),
          generation: (chat.generation ?? 1) + 1,
        }) ?? chat
      }
    }

    const prompt = classification.kind === 'append'
      ? composeAppendPrompt(classification.newMessages ?? [], { format: this.config.appendFormat, nonce: this.config.appendNonce })
      : (classification.kind === 'initial'
        ? composeInitialPrompt(messages)
        : composeReplayPrompt(messages))

    const pendingRecord = {
      status: 'pending',
      requestHash,
      sessionId,
      baseMessages: base,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.store.putRequest(chatId, requestId, pendingRecord)

    try {
      this.log(`[bridge] ${chatId} request=${requestId} session=${sessionId} kind=${classification.kind} bytes=${Buffer.byteLength(prompt, 'utf8')}`)
      const sent = await this.sendPrompt(sessionId, requestId, prompt)
      const result = await this.waitForTurn(sessionId, requestId, sent?.baselineEventCount)
      if (!result.ok) {
        throw this.turnFailure(result, sessionId)
      }
      if (!result.answer || result.answer.trim() === '') {
        throw upstreamError('Agent 回合结束，但没有产生可返回的最终文本；工具调用或中间步骤不计入最终回答', 'empty_answer')
      }

      const known = withAssistant(base, result.answer)
      this.store.updateChat(chatId, {
        knownMessages: known,
        sessionId,
        title: deriveTitle(chatId, messages, title),
        provider: chat.provider,
        model: chat.model,
        lastTurn: result.turn,
      })
      this.store.putRequest(chatId, requestId, {
        ...pendingRecord,
        status: 'done',
        answer: result.answer,
        usage: result.usage,
        finishReason: result.finishReason ?? 'stop',
        turn: result.turn,
        updatedAt: nowIso(),
      })
      return {
        answer: result.answer,
        usage: result.usage,
        finishReason: result.finishReason ?? 'stop',
        sessionId,
        turn: result.turn,
        idempotent: false,
        branch,
      }
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : upstreamError(error instanceof Error ? error.message : String(error))
      try {
        this.store.putRequest(chatId, requestId, {
          ...pendingRecord,
          status: 'error',
          httpStatus: bridgeError.status,
          errorCode: bridgeError.code,
          errorMessage: bridgeError.message,
          updatedAt: nowIso(),
        })
      } catch (persistError) {
        this.log(`[bridge] 保存失败请求记录失败: ${persistError.message}`)
      }
      throw bridgeError
    }
  }

  previousSessions(chat, newSessionId, reason) {
    const previous = Array.isArray(chat.previousSessions) ? [...chat.previousSessions] : []
    if (chat.sessionId && chat.sessionId !== newSessionId) {
      previous.push({ sessionId: chat.sessionId, at: nowIso(), reason: reason ?? 'branch' })
    }
    return previous.slice(-20)
  }

  async resolveAgentOptions(maxTokens) {
    const selection = this.getService('agentDefaultModel')?.currentSelection?.() ?? {}
    const provider = (this.config.provider || selection.provider || '').trim()
    const model = (this.config.model || selection.model || '').trim()
    if (!provider || !model) {
      throw new BridgeError(500, 'model_not_configured', '没有可用的 DSH 模型通道：请在桥接配置中设置 provider/model，或在 DSH 中选择默认模型')
    }
    const limit = clampInteger(maxTokens ?? this.config.maxTokens, 1, Number.MAX_SAFE_INTEGER)
    return {
      provider,
      model,
      ...(limit === undefined ? {} : { maxTokens: limit }),
    }
  }

  isProtocolSession(sessionId) {
    return typeof sessionId === 'string' && sessionId.startsWith('session-st-')
  }

  fixedRulesForSession(sessionId) {
    const chat = this.store.listChats().find(item => item.sessionId === sessionId)
    return chat?.fixedRules ?? []
  }

  /**
   * Global fallback for protocol sessions. The per-Agent hook covers normal
   * bridge turns; this listener also covers a session opened manually in the
   * DSH UI after the Host restarted, when no per-Agent runtime exists yet.
   */
  augmentProtocolAssembly(assembled, sessionId) {
    const runtime = this.runtimes.get(sessionId)
    const rules = runtime?.fixedRules?.length ? runtime.fixedRules : this.fixedRulesForSession(sessionId)
    const dynamicSystem = runtime?.dynamicSystem ?? []
    const source = Array.isArray(assembled.sections) ? assembled.sections : []
    const sections = source.filter(section => ['deployment:persona-prefix', 'deployment:persona-suffix'].includes(section.name))
    const presetText = formatManagedPreset(runtime?.managedPreset)
    const rulesText = formatFixedRules(rules)
    const dynamicText = formatDynamicSystem(dynamicSystem)
    if (presetText && !sections.some(section => section.name === PRESET_SECTION)) {
      sections.push({ name: PRESET_SECTION, text: presetText, interpolate: false })
    }
    if (rulesText && !sections.some(section => section.name === 'st-bridge:fixed-rules')) {
      sections.push({ name: 'st-bridge:fixed-rules', text: rulesText, interpolate: false })
    }
    if (dynamicText && !sections.some(section => section.name === 'st-bridge:dynamic-system')) {
      sections.push({ name: 'st-bridge:dynamic-system', text: dynamicText, interpolate: false })
    }
    if (!sections.some(section => section.name === TURN_POLICY_SECTION)) {
      sections.push({ name: TURN_POLICY_SECTION, text: formatTurnPolicy() })
    }
    return { ...assembled, sections, tools: [], contexts: [] }
  }

  replaceProtocolSystemSnapshot(runtime, position) {
    if (!runtime.protocol || !this.isProtocolSession(runtime.sessionId)) return 0
    const session = (this.ctx.agents?.get?.(runtime.sessionId)
      ?? this.handles.get(runtime.sessionId)?.agent)?.session
    if (!Array.isArray(session?.surface?.nodes)
      || typeof session.eventAt !== 'function' || typeof session.append !== 'function') {
      throw upstreamError('当前 DSH 不支持系统快照的原生 surface 替换，已停止本轮以避免重复累积', 'system_snapshot_unavailable')
    }
    const snapshotKey = sha256(JSON.stringify([runtime.managedPreset, runtime.fixedRules, runtime.dynamicSystem]))
    const nodes = session.surface.nodes.map(seq => ({ seq, event: session.eventAt(seq) }))
      .filter(({ event }) => {
        if (event?.type !== 'system/message') return false
        const text = (event.data.message.content ?? [])
          .filter(block => block.type === 'text').map(block => block.text).join('\n')
        return text.includes('<<<FIXED_RULE ') || text.includes('<<<DYNAMIC_SYSTEM ')
          || carriesManagedPreset(text)
          || text.includes(formatTurnPolicy())
      })
    if (nodes.length === 1 && runtime.lastSystemSnapshotKey === snapshotKey) return 0
    // A native system-node replacement creates a content-generation boundary.
    // DSH then installs the freshly rendered prompt at its leading system node,
    // even on in-history routes. User/assistant nodes and old log events stay.
    for (const { seq } of nodes.toReversed()) {
      session.append('system/message', {
        turn: position.turn,
        step: position.step,
        message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } },
      }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    }
    runtime.lastSystemSnapshotKey = snapshotKey
    if (nodes.length) this.log(`[dsh-session] system-snapshot replace session=${runtime.sessionId} nodes=${nodes.length}`)
    return nodes.length
  }

  installHooks(agentCtx, runtime) {
    if (!agentCtx || runtime.hooked || typeof agentCtx.on !== 'function') return
    runtime.hooked = true
    // The deployment mounts some tools and runtime-context providers at the
    // root, so they would otherwise be inherited by every Agent. A bridge
    // session is a pure text endpoint: strip tool schemas and dynamic runtime
    // context for this Agent only, keeping the preset's system prompt and the
    // caller's messages untouched.
    const keepSections = new Set(['deployment:persona-prefix', 'deployment:persona-suffix'])
    agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      const presetText = formatManagedPreset(runtime.managedPreset)
      const rules = formatFixedRules(runtime.fixedRules)
      const dynamicSystem = formatDynamicSystem(runtime.dynamicSystem)
      const source = Array.isArray(assembled.sections) ? assembled.sections : []
      const sections = source.filter(section => keepSections.has(section.name))
      if (presetText && !sections.some(section => section.name === PRESET_SECTION)) {
        // 酒馆确认过的固定预设：唯一受管副本，按 Hash 就地更新
        sections.push({ name: PRESET_SECTION, text: presetText, interpolate: false })
      }
      if (rules && !sections.some(section => section.name === 'st-bridge:fixed-rules')) {
        // 酒馆文本按字面量注入：其中的 {{...}} 是 ST 宏，不是 DSH 提示变量
        sections.push({ name: 'st-bridge:fixed-rules', text: rules, interpolate: false })
      }
      if (dynamicSystem && !sections.some(section => section.name === 'st-bridge:dynamic-system')) {
        sections.push({ name: 'st-bridge:dynamic-system', text: dynamicSystem, interpolate: false })
      }
      if (runtime.protocol && !sections.some(section => section.name === TURN_POLICY_SECTION)) {
        sections.push({ name: TURN_POLICY_SECTION, text: formatTurnPolicy() })
      }
      return {
        ...assembled,
        sections,
        tools: [],
        contexts: [],
      }
    })
    agentCtx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const efforts = await this.supportedReasoningEfforts(resolved.provider, resolved.model)
      const params = runtime.params
      if (
        typeof params.reasoningEffort === 'string'
        && params.reasoningEffort !== ''
        && (!Array.isArray(efforts) || !efforts.includes(params.reasoningEffort))
      ) {
        this.log(
          `[dsh-session] 忽略不支持的 reasoningEffort=${params.reasoningEffort} `
          + `model=${resolved.provider}/${resolved.model} supported=${Array.isArray(efforts) ? efforts.join(',') || '(none)' : 'unknown'}`,
        )
      }
      const request = applyRuntimeParams(resolved, params, { reasoningEfforts: efforts })
      this.replaceProtocolSystemSnapshot(runtime, payload)
      return request
    })
  }

  setupPreset(sessionId, runtime = this.runtimeFor(sessionId)) {
    const presets = this.getService('agentPresets')
    const preset = (this.config.agentPreset || '').trim()
    return async (agentCtx) => {
      if (presets?.mount && preset) await presets.mount(agentCtx, preset)
      this.installHooks(agentCtx, runtime)
    }
  }

  async createSession(chat, messages, title, maxTokens, reason) {
    return this.createSessionWithId(chat, {
      sessionId: `session-${randomUUID()}`,
      title: deriveTitle(chat.chatId, messages, title),
      maxTokens,
      fixedRules: chat.fixedRules ?? [],
      reason,
    })
  }

  async createSessionWithId(chat, { sessionId, title, maxTokens, fixedRules, reason }) {
    const agents = this.ctx.agents
    if (!agents?.create) throw new BridgeError(500, 'agents_unavailable', 'DSH agents 服务不可用，无法创建会话')
    const agentOptions = await this.resolveAgentOptions(maxTokens)
    const runtime = this.runtimeFor(sessionId, fixedRules ?? [])
    const options = {
      sessionId,
      meta: {
        cwd: this.effectiveCwd(),
        ...(this.config.agentPreset ? { agentPreset: this.config.agentPreset } : {}),
      },
      agentOptions,
      setup: this.setupPreset(sessionId, runtime),
    }
    this.log(`[bridge] 新建会话 ${sessionId} model=${agentOptions.provider}/${agentOptions.model} reason=${reason ?? 'initial'}`)
    let handle
    try {
      const create = () => agents.create(options)
      handle = await (agents.withoutInitiator ? agents.withoutInitiator(create) : create())
    } catch (error) {
      throw new BridgeError(
        500,
        'session_create_failed',
        `创建 DSH 会话失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!handle?.agent?.session) {
      throw new BridgeError(500, 'session_create_failed', 'DSH 没有返回可用的 Agent 会话')
    }
    this.handles.set(sessionId, handle)
    await this.attachWorkspace(sessionId)
    await this.renameSession(handle.agent.session, title || chat.title || chat.chatId)
    const nextChat = this.store.updateChat(chat.scopeKey ?? chat.chatId, {
      provider: agentOptions.provider,
      model: agentOptions.model,
      agentPreset: this.config.agentPreset,
    })
    if (nextChat) chat.provider = nextChat.provider
    if (nextChat) chat.model = nextChat.model
    return sessionId
  }

  async ensureSession(chat, maxTokens, options = {}) {
    const agents = this.ctx.agents
    if (!agents) throw new BridgeError(500, 'agents_unavailable', 'DSH agents 服务不可用')
    const sessionId = options.sessionId ?? chat.sessionId
    const archived = this.archivedSessionError(sessionId)
    if (archived) throw archived
    const fixedRules = options.fixedRules ?? chat.fixedRules ?? []
    const missingStatus = options.missingStatus ?? 409
    const runtime = this.runtimeFor(sessionId, fixedRules)
    const live = agents.get?.(sessionId)
    if (live) {
      this.installHooks(live.ctx, runtime)
      await this.attachWorkspace(sessionId)
      return live
    }

    const agentOptions = await this.resolveAgentOptions(maxTokens)
    const resumeOptions = {
      resumeSessionId: sessionId,
      agentOptions,
      setup: this.setupPreset(sessionId, runtime),
    }
    let handle
    try {
      const resume = () => agents.resume(resumeOptions)
      handle = await (agents.withoutInitiator ? agents.withoutInitiator(resume) : resume())
    } catch (error) {
      const notFound = isSessionNotFound(error)
      const status = notFound ? missingStatus : 409
      const code = notFound && missingStatus === 410 ? 'session_gone' : 'session_unavailable'
      throw new BridgeError(status, code, `恢复 DSH 会话 ${sessionId} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!handle?.agent?.session) {
      throw new BridgeError(missingStatus, missingStatus === 410 ? 'session_gone' : 'session_unavailable', `DSH 没有返回会话 ${sessionId}`)
    }
    this.handles.set(sessionId, handle)
    await this.attachWorkspace(sessionId)
    return handle.agent
  }

  async sessionExists(sessionId) {
    if (this.ctx.agents?.get?.(sessionId)) return true
    const controller = this.getService('sessionController')
    if (typeof controller?.inspect === 'function') {
      try {
        await controller.inspect(sessionId)
        return true
      } catch (error) {
        if (isSessionNotFound(error)) return false
        throw error
      }
    }
    return false
  }

  async createOrResumeSession(chat, { sessionId, title, maxTokens, fixedRules, reason }) {
    try {
      if (await this.sessionExists(sessionId)) {
        await this.ensureSession(chat, maxTokens, { sessionId, fixedRules, missingStatus: 410 })
        return sessionId
      }
    } catch (error) {
      if (error instanceof BridgeError && error.status === 410) {
        // Fall through and create it.
      } else if (!isSessionNotFound(error)) {
        throw error
      }
    }
    try {
      return await this.createSessionWithId(chat, { sessionId, title, maxTokens, fixedRules, reason })
    } catch (error) {
      // A concurrent retry may have created the same deterministic ID.
      try {
        await this.ensureSession(chat, maxTokens, { sessionId, fixedRules, missingStatus: 410 })
        return sessionId
      } catch {
        throw error
      }
    }
  }

  /**
   * Use a real DSH workspace when the configured cwd does not match one.
   * DSH Desktop often starts with cwd at its launch root, which cannot be
   * attached to the user's workspace.
   */
  effectiveCwd() {
    const workspaces = this.getService('workspaceRegistry')?.list?.() ?? []
    if (workspaces.length === 0) return this.config.cwd
    if (workspaces.some(workspace => samePath(workspace.path, this.config.cwd))) return this.config.cwd
    const fallback = workspaces[0].path
    if (!this.cwdFallbackLogged) {
      this.cwdFallbackLogged = true
      this.log(`[bridge] cwd ${this.config.cwd} 不是 DSH 工作区，改用 ${fallback}`)
    }
    return fallback
  }

  async attachWorkspace(sessionId) {
    const registry = this.getService('workspaceRegistry')
    const workspaces = registry?.list?.() ?? []
    if (workspaces.length === 0) {
      this.log(`[bridge] 没有工作区可挂载 ${sessionId}；会话仍可在 DSH 历史中找到`)
      return
    }
    const cwd = this.effectiveCwd()
    const target = workspaces.find(workspace => samePath(workspace.path, cwd)) ?? workspaces[0]
    try {
      await target.attachSession?.(sessionId)
      this.log(`[bridge] 已挂载 ${sessionId} -> ${target.path}`)
    } catch (error) {
      this.log(`[bridge] 挂载会话 ${sessionId} 到工作区失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async renameSession(session, title) {
    const service = this.getService('sessionTitle')
    if (!service?.rename || !session) return
    try {
      service.rename(session, title.slice(0, SESSION_TITLE_MAX))
    } catch (error) {
      this.log(`[bridge] 设置会话标题失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async sendPrompt(sessionId, requestId, prompt) {
    const agents = this.ctx.agents
    const agent = agents?.get?.(sessionId)
    if (!agent?.followup) {
      throw new BridgeError(409, 'session_unavailable', `DSH 会话 ${sessionId} 当前没有运行中的 Agent`)
    }
    let baselineEventCount = 0
    try {
      const before = await this.readEvents(sessionId)
      if (Array.isArray(before)) baselineEventCount = before.length
    } catch {
      // Best-effort baseline only; normal request-id recovery still works.
    }
    const messageId = /^[A-Za-z0-9._:-]{1,200}$/.test(requestId)
      ? requestId
      : `bbh-${sha256(requestId).slice(0, 32)}`
    try {
      agent.followup({
        id: messageId,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user', rpcId: requestId },
      })
    } catch (error) {
      throw new BridgeError(
        502,
        'prompt_rejected',
        `DSH 拒绝接收本轮输入：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return { messageId, baselineEventCount }
  }

  /**
   * A policy/provider error can end a turn before any user/message event is
   * persisted, so recoverTurn() cannot match it by request id. Detect a new
   * error turn after the prompt baseline to avoid waiting for the full timeout.
   */
  earlyTurnFailure(events, fromIndex = 0) {
    if (!Array.isArray(events)) return undefined
    const slice = events.slice(Math.max(0, fromIndex))
    for (let index = slice.length - 1; index >= 0; index -= 1) {
      const event = slice[index]
      if (event?.type !== 'turn/end') continue
      const data = event.data ?? {}
      const reason = data.reason
      if (reason?.kind !== 'error') continue
      const turn = data.turn
      if (slice.some(item => item?.type === 'assistant/message' && item?.data?.turn === turn)) continue
      const error = reason.error ?? reason
      return {
        ok: false,
        turn,
        code: error?.code ?? 'agent_turn_error',
        message: error?.message ?? 'Agent 回合失败',
      }
    }
    return undefined
  }

  async readEvents(sessionId, forceInspect = false) {
    if (!forceInspect) {
      const live = this.ctx.agents?.get?.(sessionId)
      const session = live?.session
      if (typeof session?.snapshotEvents === 'function') {
        const events = session.snapshotEvents()
        if (Array.isArray(events) && events.length > 0) return events
      }
    }
    const controller = this.getService('sessionController')
    if (typeof controller?.inspect === 'function') {
      const inspection = await controller.inspect(sessionId)
      if (Array.isArray(inspection?.events)) return inspection.events
    }
    return []
  }

  async waitForTurn(sessionId, requestId, baselineEventCount = 0) {
    const timeoutMs = this.config.requestTimeoutMs
    const deadline = Date.now() + timeoutMs
    let polls = 0
    let failures = 0
    while (Date.now() < deadline) {
      let events = []
      try {
        events = await this.readEvents(sessionId, polls % 8 === 7)
        failures = 0
      } catch (error) {
        failures += 1
        if (failures >= 10) {
          throw upstreamError(`读取 DSH 会话事件失败：${error instanceof Error ? error.message : String(error)}`, 'session_read_failed')
        }
      }
      const result = recoverTurn(events, requestId)
      if (result) return result
      const early = this.earlyTurnFailure(events, baselineEventCount)
      if (early) return early
      polls += 1
      await sleep(POLL_INTERVAL_MS)
    }
    throw timeoutError(`Agent 在 ${Math.round(timeoutMs / 1000)} 秒内没有完成本轮任务`)
  }

  archivedSessionError(sessionId) {
    const archivedIds = this.getService('workspaceRegistry')?.archivedSessionIds
    if (sessionId && Array.isArray(archivedIds) && archivedIds.includes(sessionId)) {
      return conflict(`DSH 会话 ${sessionId} 已归档，无法执行生成；请在 DSH 恢复该会话，或明确选择清除绑定后新建会话`, 'session_archived')
    }
    return undefined
  }

  turnFailure(result, sessionId) {
    if (result.turnEndKind === 'blocked' || result.code === 'agent_turn_blocked') {
      return this.archivedSessionError(sessionId)
        ?? conflict(result.message || 'DSH 已阻止本轮执行（blocked）', 'agent_turn_blocked')
    }
    const message = result.message || 'Agent 回合失败'
    if (isProviderSessionBlocked(message)) {
      return new BridgeError(
        502,
        'provider_session_blocked',
        `模型提供方会话被阻断：${message}；请清理提供方会话/切换模型或重启 DSH，桥接新建 DSH 会话不会解除该阻断`,
      )
    }
    if (isContextLengthError(message)) {
      return new BridgeError(413, 'context_length_exceeded', `上下文超出模型限制：${message}`)
    }
    if (isAccountError(message)) {
      return new BridgeError(502, 'upstream_account_error', `模型账号或配额异常：${message}`)
    }
    if (/UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort/i.test(message)) {
      return new BridgeError(
        400,
        'unsupported_reasoning_effort',
        `当前模型不支持请求的思考强度，桥接已按模型能力忽略该参数；请重新生成：${message}`,
      )
    }
    return new BridgeError(502, result.code ?? 'agent_turn_error', message)
  }

  async tryRecover(chatId, requestId, record) {
    if (!record.sessionId) return undefined
    try {
      const events = await this.readEvents(record.sessionId, true)
      const result = recoverTurn(events, requestId)
      if (!result) return undefined
      if (!result.ok || !result.answer || result.answer.trim() === '') {
        const failure = !result.ok ? this.turnFailure(result, record.sessionId)
          : upstreamError('Agent 回合结束，但没有产生可返回的最终文本', 'empty_answer')
        this.store.putRequest(chatId, requestId, {
          ...record,
          status: 'error',
          httpStatus: failure.status,
          errorCode: failure.code,
          errorMessage: failure.message,
          updatedAt: nowIso(),
        })
        throw failure
      }
      if (Array.isArray(record.baseMessages)) {
        this.store.updateChat(chatId, { knownMessages: withAssistant(record.baseMessages, result.answer) })
      }
      this.store.putRequest(chatId, requestId, {
        ...record,
        status: 'done',
        answer: result.answer,
        usage: result.usage,
        finishReason: result.finishReason ?? 'stop',
        turn: result.turn,
        updatedAt: nowIso(),
      })
      return {
        answer: result.answer,
        usage: result.usage,
        finishReason: result.finishReason ?? 'stop',
        sessionId: record.sessionId,
        turn: result.turn,
        idempotent: true,
        branch: false,
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error
      return undefined
    }
  }

  cachedDshResult(existing, action) {
    return {
      ...(existing.contextAudit ? { contextAudit: existing.contextAudit } : {}),
      // A cached answer keeps this turn's preset verdict. It is an audit of the
      // original request, not a fresh install or reuse decision.
      ...(existing.preset ? { preset: { ...existing.preset, cached: true } } : {}),
      ...(existing.inputCleanup ? { inputCleanup: existing.inputCleanup } : {}),
      ...(existing.dynamicDiff ? { dynamicDiff: existing.dynamicDiff } : {}),
      action: existing.action ?? action,
      answer: existing.answer,
      usage: existing.usage,
      finishReason: existing.finishReason ?? 'stop',
      sessionId: existing.sessionId,
      turn: existing.turn,
      idempotent: true,
    }
  }

  async handleDshSession(input) {
    const chatId = String(input.chatId ?? '').trim()
    const requestId = String(input.requestId ?? '').trim()
    if (!chatId) throw badRequest('缺少 dsh_session.chat_id', 'missing_chat_id')
    if (!requestId) throw badRequest('缺少 dsh_session.request_id', 'missing_request_id')
    if (chatId.length > 256) throw badRequest('chat_id 过长', 'invalid_chat_id')
    if (requestId.length > 256) throw badRequest('request_id 过长', 'invalid_request_id')
    if (input.protocolVersion !== 1) {
      throw badRequest('dsh_session.protocol_version 必须为整数 1', 'unsupported_protocol_version')
    }
    const clientId = normalizeClientId(input.clientId)
    const taskId = normalizeTaskId(input.taskId)
    const effectiveClientId = clientId ?? 'baibai-image'
    const allowedClients = Array.isArray(this.config.allowedClientIds) ? this.config.allowedClientIds : []
    if (allowedClients.length > 0 && !allowedClients.includes(effectiveClientId)) {
      throw new BridgeError(403, 'client_not_allowed', `client_id "${effectiveClientId}" 不在允许列表中`)
    }
    const scope = resolveScope({ clientId, chatId, taskId })

    const action = parseAction(input.action)
    const sessionInput = typeof input.sessionId === 'string' && input.sessionId.trim() !== ''
      ? input.sessionId.trim()
      : undefined
    const target = parseTarget(input.target)
    const params = input.params && typeof input.params === 'object' ? input.params : {}
    const maxTokens = input.maxTokens ?? params.maxTokens
    const { messages } = normalizeMessages(input.messages ?? [], { allowEmpty: action === 'reset' })
    const contextRequest = parseContextRequest(input.context, messages)
    const fixedCount = input.fixedCount === undefined ? 0 : input.fixedCount
    const fixedTypes = input.fixedTypes === undefined ? [] : input.fixedTypes

    if (action === 'reset') {
      if (messages.length !== 0) throw badRequest('reset 的 messages 必须为空', 'reset_messages_not_empty')
      if (fixedCount !== 0) throw badRequest('reset 的 fixed_message_count 必须为 0', 'invalid_fixed_count')
      if (!Array.isArray(fixedTypes) || fixedTypes.length !== 0) {
        throw badRequest('reset 的 fixed_message_types 必须为空数组', 'invalid_fixed_types')
      }
    } else if (action === 'sync_rules') {
      parseFixedRules(messages, fixedCount, fixedTypes, { requireAll: true })
    } else {
      parseFixedRules(messages, fixedCount, fixedTypes)
      const dynamic = messages.slice(fixedCount)
      if (dynamic.length === 0) throw badRequest('generate 至少需要一条动态消息', 'empty_dynamic_group')
      if (!dynamic.some(message => message.role === 'user')) {
        throw badRequest('generate 的动态组必须包含 user 消息', 'missing_user_message')
      }
    }

    const hashInput = {
      action,
      fixedCount,
      fixedTypes,
      messages: messages.map(message => message.hash),
      target: target
        ? [target.floor ?? null, target.swipe_id ?? null, target.revision ?? null]
        : null,
    }
    // Attribution is observational. Only an actual rule selection changes model input.
    if (contextRequest && contextRequest.profile_id !== 'original') hashInput.context = {
      profile_id: contextRequest.profile_id,
      ...(contextRequest.profile_hash ? { profile_hash: contextRequest.profile_hash } : {}),
    }
    // Keep the pre-scope hash for the legacy baibai binding so an in-flight
    // request or stored record remains idempotent across the upgrade.
    if (!scope.legacy) hashInput.scope = scope.scopeKey
    const requestHash = hashRequest(hashInput)

    const existing = this.store.getRequest(scope.scopeKey, requestId)
    if (existing) {
      if (existing.action && existing.action !== action) {
        throw conflict('同一个 request_id 对应了不同的 action；请换一个新的 request_id', 'request_id_conflict')
      }
      if (existing.requestHash && existing.requestHash !== requestHash) {
        throw conflict('同一个 request_id 对应了不同的 dsh_session 请求内容；请换一个新的 request_id', 'request_id_conflict')
      }
      if (existing.status === 'done') return this.cachedDshResult(existing, action)
      if (existing.status === 'error') {
        // A 410 is a binding failure, not a completed operation. The plugin is
        // expected to clear its binding and retry the same request_id with an
        // initializing request, so let that retry through.
        if (existing.httpStatus !== 410) {
          throw new BridgeError(
            existing.httpStatus ?? 502,
            existing.errorCode ?? 'request_failed',
            existing.errorMessage ?? '此前使用该 request_id 的请求已失败；如需重试请使用新的 request_id',
          )
        }
      }
      if (existing.status === 'pending') {
        const inFlight = this.pending.get(this.pendingKey(scope.scopeKey, requestId))
        if (inFlight) return inFlight
        if (action === 'generate') {
          try {
            const recovered = await this.tryRecoverDshSession(scope.scopeKey, requestId, existing)
            if (recovered) return recovered
            throw conflict('该 request_id 仍在处理中，或上次进程在回合结束前中断；请稍后重试', 'request_in_progress')
          } catch (error) {
            // The old session is gone. Let an initialization retry (same
            // request_id, fixed group, no session_id) create a new session.
            if (!(error instanceof BridgeError && error.status === 410)) throw error
          }
        }
        // sync_rules and reset are idempotent; fall through and re-apply. This
        // repairs a crash between session creation and request-record commit.
      }
    }

    const key = this.pendingKey(scope.scopeKey, requestId)
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight

    const promise = this.enqueue(scope.scopeKey, () => this.runDshAction({
      scope,
      chatId,
      requestId,
      action,
      sessionId: sessionInput,
      messages,
      fixedCount,
      fixedTypes,
      target,
      maxTokens,
      params,
      requestHash,
      contextRequest,
      contextProfile: this.contextProfiles.resolve(contextRequest?.profile_id, scope, contextRequest?.profile_hash),
    }))
    this.pending.set(key, promise)
    try {
      return await promise
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key)
    }
  }

  async runDshAction({ scope, chatId, requestId, action, sessionId, messages, fixedCount, fixedTypes, target, maxTokens, params, requestHash, contextRequest, contextProfile }) {
    let chat = this.store.getChat(scope.scopeKey)
    if (!chat) {
      chat = newChatRecord({
        chatId,
        clientId: scope.clientId,
        taskId: scope.taskId,
        scopeKey: scope.scopeKey,
        sessionId: '',
        title: scopedTitle(chatId, messages, undefined, scope.clientId, scope.taskId),
        cwd: this.effectiveCwd(),
        provider: '',
        model: '',
        agentPreset: this.config.agentPreset,
      })
      this.store.putChat(scope.scopeKey, chat)
    }
    if (sessionId && action !== 'reset' && chat.sessionId !== sessionId) {
      const archived = this.archivedSessionError(sessionId)
      if (action === 'generate' && this.config.sessionOnStale === 'recreate' && !chat.sessionId) {
        // The scope binding was cleared (reset) but the plugin still sends the
        // old session_id. Treat it as a fresh initialization instead of 410.
        this.log(`[dsh-session] 忽略失效 session_id ${sessionId}，按新会话初始化`)
        sessionId = undefined
      } else if (action === 'generate' && this.config.sessionOnStale === 'recreate' && archived && chat.sessionId) {
        // The plugin still holds an archived session_id while this scope has a
        // newer valid binding. The binding is authoritative; use it instead of
        // failing every retry with 410.
        this.log(`[dsh-session] 忽略已归档旧 session_id ${sessionId}，使用当前绑定 ${chat.sessionId}`)
        sessionId = undefined
      } else {
        throw sessionGone(`DSH 会话 ${sessionId} 不属于该 client_id/chat_id/task_id 范围，或绑定已失效；请清除绑定后重新初始化`)
      }
    }

    if (action === 'reset') return this.resetDshSession({ scope, chat, requestId, requestHash, maxTokens, params })
    if (action === 'sync_rules') {
      return this.syncDshRules({ scope, chat, requestId, sessionId, messages, fixedCount, fixedTypes, maxTokens, params, requestHash })
    }
    try {
      return await this.generateDsh({ scope, chat, requestId, sessionId, messages, fixedCount, fixedTypes, target, maxTokens, params, requestHash, contextRequest, contextProfile })
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'context_length_exceeded' && this.config.contextOverflow === 'recreate') {
        this.log(`[dsh-session] 上下文超限，重建会话 ${chat.sessionId || '(none)'}`)
        this.store.updateChat(scope.scopeKey, {
          sessionId: '',
          knownMessages: [],
          snapshot: null,
          presetManagement: null,
          presetDiagnostic: null,
        })
        const fresh = this.store.getChat(scope.scopeKey)
        return this.generateDsh({
          scope, chat: fresh, requestId, sessionId: undefined, messages, fixedCount, fixedTypes,
          target, maxTokens, params, requestHash, contextRequest, contextProfile,
        })
      }
      throw error
    }
  }

  async resetDshSession({ scope, chat, requestId, requestHash, maxTokens, params }) {
    const chatId = chat.chatId
    const newSessionId = sessionIdFor(scope.scopeKey, requestId, 'reset')
    const previous = this.previousSessions(chat, newSessionId, 'reset')
    const title = scopedTitle(chatId, [], undefined, scope.clientId, scope.taskId)
    const runtime = this.runtimeFor(newSessionId, [])
    runtime.params = {}
    runtime.dynamicSystem = []
    runtime.protocol = true
    const pending = {
      status: 'pending',
      action: 'reset',
      requestHash,
      sessionId: newSessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.store.putRequest(scope.scopeKey, requestId, pending)
    try {
      await this.createOrResumeSession(chat, {
        sessionId: newSessionId,
        title,
        maxTokens,
        fixedRules: [],
        reason: 'reset',
      })
      this.store.updateChat(scope.scopeKey, {
        clientId: scope.clientId,
        taskId: scope.taskId,
        scopeKey: scope.scopeKey,
        sessionId: newSessionId,
        fixedRules: [],
        sourceFixedRules: [],
        knownMessages: [],
        title,
        previousSessions: previous,
        generation: (chat.generation ?? 0) + 1,
        lastTarget: null,
        protocol: 1,
        presetManagement: null,
        presetDiagnostic: null,
        snapshot: null,
      })
      this.store.putRequest(scope.scopeKey, requestId, { ...pending, status: 'done', updatedAt: nowIso() })
      this.log(`[dsh-session] reset ${scope.clientId}/${chatId}/${scope.taskId} -> ${newSessionId}`)
      return { action: 'reset', sessionId: newSessionId, idempotent: false }
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : upstreamError(error instanceof Error ? error.message : String(error))
      this.store.putRequest(scope.scopeKey, requestId, {
        ...pending,
        status: 'error',
        httpStatus: bridgeError.status,
        errorCode: bridgeError.code,
        errorMessage: bridgeError.message,
        updatedAt: nowIso(),
      })
      throw bridgeError
    }
  }

  async syncDshRules({ scope, chat, requestId, sessionId, messages, fixedCount, fixedTypes, maxTokens, params, requestHash }) {
    const chatId = chat.chatId
    const rules = parseFixedRules(messages, fixedCount, fixedTypes, { requireAll: true })
    const title = chat.title || scopedTitle(chatId, messages, undefined, scope.clientId, scope.taskId)
    const targetSessionId = sessionId ?? sessionIdFor(scope.scopeKey, requestId, 'sync_rules')
    const runtime = this.runtimeFor(targetSessionId, rules)
    runtime.params = {}
    runtime.dynamicSystem = []
    runtime.protocol = true
    const pending = {
      status: 'pending',
      action: 'sync_rules',
      requestHash,
      sessionId: targetSessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.store.putRequest(scope.scopeKey, requestId, pending)
    try {
      if (sessionId) {
        await this.ensureSession(chat, maxTokens, { sessionId, fixedRules: rules, missingStatus: 410 })
      } else {
        await this.createOrResumeSession(chat, {
          sessionId: targetSessionId,
          title,
          maxTokens,
          fixedRules: rules,
          reason: 'sync_rules',
        })
      }
      this.store.updateChat(scope.scopeKey, {
        clientId: scope.clientId,
        taskId: scope.taskId,
        scopeKey: scope.scopeKey,
        sessionId: targetSessionId,
        fixedRules: rules,
        sourceFixedRules: rules,
        knownMessages: [],
        title,
        protocol: 1,
        ...(sessionId ? {} : {
          previousSessions: this.previousSessions(chat, targetSessionId, 'sync_rules'),
          generation: (chat.generation ?? 0) + 1,
        }),
      })
      this.store.putRequest(scope.scopeKey, requestId, { ...pending, status: 'done', updatedAt: nowIso() })
      this.log(`[dsh-session] sync_rules ${scope.clientId}/${chatId}/${scope.taskId} -> ${targetSessionId} (${rules.length} rules)`)
      return { action: 'sync_rules', sessionId: targetSessionId, idempotent: false }
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : upstreamError(error instanceof Error ? error.message : String(error))
      this.store.putRequest(scope.scopeKey, requestId, {
        ...pending,
        status: 'error',
        httpStatus: bridgeError.status,
        errorCode: bridgeError.code,
        errorMessage: bridgeError.message,
        updatedAt: nowIso(),
      })
      throw bridgeError
    }
  }

  /**
   * Decide this turn's managed fixed preset and the dynamic system block that
   * still has to be sent.
   *
   * Order matters: identify → verify boundaries → reuse only when the same
   * version is already confirmed for this exact session → otherwise keep every
   * message verbatim. Nothing here may raise on an unrecognised request.
   */
  planPreset({ scope, chat, dynamicSystem }) {
    const disabled = { dynamicSystem, managedPreset: undefined, diagnostic: undefined, install: undefined }
    let preset
    try {
      preset = this.presetConfigs.resolveFor(scope)
    } catch (error) {
      this.log(`[dsh-session] 固定预设配置不可用，本轮保留全部动态副本: ${error instanceof Error ? error.message : String(error)}`)
      return { ...disabled, diagnostic: { preset_id: null, status: 'config-error', reason: 'config-unreadable' } }
    }
    if (!preset) return disabled

    const identity = identifyPreset(dynamicSystem, preset)
    const originalChars = dynamicSystem.reduce((sum, message) => sum + message.text.length, 0)
    if (identity.status !== 'identified') {
      return {
        ...disabled,
        diagnostic: presetDiagnostic(preset, identity, undefined, {
          status: identity.status,
          reason: identity.reason,
          originalChars,
          keptChars: originalChars,
        }),
      }
    }

    const spans = presetSpansWithin(identity.spans, dynamicSystem.length)
    if (!spans) {
      return {
        ...disabled,
        diagnostic: presetDiagnostic(preset, identity, undefined, {
          status: 'boundary-outside-system',
          reason: '固定预设边界越出动态 system 区，本轮完整保留',
          originalChars,
          keptChars: originalChars,
        }),
      }
    }

    const management = chat.presetManagement
    const decision = reuseDecision(management, {
      hash: identity.hash,
      presetId: identity.presetId,
      sessionId: chat.sessionId,
    })

    const managedPreset = {
      id: identity.presetId,
      hash: identity.hash,
      texts: identity.texts,
    }

    if (decision.reuse) {
      const deduped = stripPresetForRendering(dynamicSystem, spans)
      const keptChars = deduped.reduce((sum, message) => sum + message.text.length, 0)
      return {
        dynamicSystem: deduped,
        managedPreset,
        install: undefined,
        diagnostic: presetDiagnostic(preset, identity, decision, {
          status: 'reused',
          reason: 'same-version',
          originalChars,
          dedupedChars: originalChars - keptChars,
          keptChars,
        }),
      }
    }

    // First install or changed version: send the full text this turn, install
    // the managed copy, and only claim success once the turn finishes.
    return {
      dynamicSystem,
      managedPreset,
      install: {
        presetId: identity.presetId,
        hash: identity.hash,
        configHash: preset.config_hash,
        texts: identity.texts,
        dynamicChars: originalChars,
      },
      diagnostic: presetDiagnostic(preset, identity, decision, {
        status: management?.hash === identity.hash ? 'reinstalling' : 'first-install',
        reason: decision.reason,
        originalChars,
        keptChars: originalChars,
      }),
    }
  }

  /**
   * Read-only twin of planPreset for the settings preview. Never installs and
   * never mutates a stored management record; it only reports what would
   * happen, plus which messages would still be sent verbatim.
   */
  previewPreset({ scope, dynamicSystem }) {
    let preset
    try {
      preset = this.presetConfigs.resolveFor(scope)
    } catch (error) {
      return { preview_only: true, status: 'config-error', reason: error instanceof Error ? error.message : String(error) }
    }
    if (!preset) return { preview_only: true, status: 'no-preset', preset_id: null }
    const identity = identifyPreset(dynamicSystem, preset)
    const originalChars = dynamicSystem.reduce((sum, message) => sum + message.text.length, 0)
    if (identity.status !== 'identified') {
      return {
        preview_only: true,
        status: identity.status,
        reason: identity.reason,
        preset_id: identity.presetId,
        mode: identity.mode,
        hash: null,
        original_chars: originalChars,
        deduped_chars: 0,
        kept_chars: originalChars,
      }
    }
    const spans = presetSpansWithin(identity.spans, dynamicSystem.length)
    if (!spans) {
      return {
        preview_only: true,
        status: 'boundary-outside-system',
        reason: '固定预设边界越出动态 system 区，本轮会完整保留',
        preset_id: identity.presetId,
        mode: identity.mode,
        hash: identity.hash,
        original_chars: originalChars,
        deduped_chars: 0,
        kept_chars: originalChars,
      }
    }
    const deduped = stripPresetForRendering(dynamicSystem, spans)
    const keptChars = deduped.reduce((sum, message) => sum + message.text.length, 0)
    return {
      preview_only: true,
      status: 'identified',
      preset_id: identity.presetId,
      mode: identity.mode,
      hash: identity.hash,
      matched_messages: identity.matched_messages,
      original_chars: originalChars,
      deduped_chars: originalChars - keptChars,
      kept_chars: keptChars,
      spans: spans.map(span => ({ index: span.index, whole: span.whole })),
    }
  }

  /** Persist an install only after the turn produced a final answer. */
  confirmPresetInstall(scopeKey, sessionId, install, diagnostic) {
    if (!install) {
      // Reuse path: the managed section was injected into whatever session
      // served this turn. Rebinding keeps the next turn from re-installing a
      // full copy just because the session id moved.
      const current = this.store.getChat(scopeKey)?.presetManagement
      if (!current || current.sessionId === sessionId) return
      this.store.updateChat(scopeKey, { presetManagement: { ...current, sessionId } })
      this.log(`[dsh-session] preset rebound ${current.presetId} session=${sessionId}`)
      return
    }
    this.store.updateChat(scopeKey, {
      presetManagement: {
        presetId: install.presetId,
        hash: install.hash,
        configHash: install.configHash,
        sessionId,
        installedAt: nowIso(),
        ruleTypes: install.texts.map(item => item.role),
      },
      presetDiagnostic: diagnostic,
    })
    this.log(`[dsh-session] preset installed ${install.presetId} hash=${install.hash.slice(0, 12)} session=${sessionId}`)
  }

  /**
   * Apply the per-scope snapshot diff only when the previous turn is still the
   * same session and its message is still present in DSH history. Any doubt
   * falls back to the full body.
   */
  async applySnapshotDiff({ scope, chat, sessionId, messages }) {
    const config = this.config.snapshotDiff ?? {}
    if (config.enabled !== true) return { messages, diagnostic: undefined }
    const mode = config.mode === 'marker' ? 'marker' : 'auto'
    const marker = normalizeSnapshotMarker(config.marker)
    if (mode === 'marker' && !marker) return { messages, diagnostic: undefined }
    const clients = Array.isArray(config.clients) ? config.clients : []
    if (clients.length > 0 && !clients.includes(scope.clientId)) return { messages, diagnostic: undefined }
    const snapshot = chat.snapshot
    if (!snapshot || snapshot.sessionId !== sessionId) return { messages, diagnostic: { status: 'no-snapshot' } }
    const snapshotMode = snapshot.mode === 'auto' ? 'auto' : 'marker'
    if (snapshotMode !== mode) return { messages, diagnostic: { status: 'mode-changed' } }
    if (mode === 'marker' && snapshot.marker !== marker) return { messages, diagnostic: { status: 'marker-changed' } }
    if (snapshot.turn !== chat.lastTurn) return { messages, diagnostic: { status: 'turn-mismatch' } }
    if (!snapshot.messageId || !(await this.sessionHasMessage(sessionId, snapshot.messageId))) {
      return { messages, diagnostic: { status: 'session-compacted' } }
    }
    const diff = diffAgainstSnapshot(messages, snapshot, { mode, marker, maxBlockChars: config.maxBlockChars })
    if (!diff.diagnostic) return { messages, diagnostic: { status: 'no-change' } }
    if (diff.diagnostic.status === 'no-user-after-trim') return { messages, diagnostic: diff.diagnostic }
    return { messages: diff.messages, diagnostic: { ...diff.diagnostic, status: 'trimmed' } }
  }

  async sessionHasMessage(sessionId, messageId) {
    if (!messageId) return false
    try {
      const events = await this.readEvents(sessionId, true)
      return Array.isArray(events) && events.some(event => event?.type === 'user/message' && event?.data?.id === messageId)
    } catch {
      return false
    }
  }

  buildSnapshot({ sessionId, turn, generation, requestId, messageId, messages, marker, mode = 'auto', maxBlockChars }) {
    return {
      sessionId,
      turn,
      generation: generation ?? 0,
      requestId,
      messageId,
      mode,
      marker,
      maxBlockChars,
      messages: snapshotOf(messages, { mode, marker, maxBlockChars }),
      at: nowIso(),
    }
  }

  async generateDsh({ scope, chat, requestId, sessionId, messages, fixedCount, fixedTypes, target, maxTokens, params, requestHash, contextRequest, contextProfile }) {
    const chatId = chat.chatId
    const sourceRules = fixedCount > 0
      ? parseFixedRules(messages, fixedCount, fixedTypes)
      : (chat.sourceFixedRules ?? chat.fixedRules ?? [])
    const rulesWithMarkers = applyContextProfile(sourceRules, contextProfile)
    const markerForRules = normalizeSnapshotMarker(this.config.snapshotDiff?.marker)
    // Fixed rules can also carry transport markers when the client wraps the
    // whole message; strip them before they enter the system section.
    const rules = markerForRules
      ? rulesWithMarkers.map(rule => ({
        ...rule,
        text: stripMarkersInMessages([{ role: 'system', text: rule.text }], markerForRules)[0].text,
      }))
      : rulesWithMarkers
    const contextAudit = contextRequest ? buildContextAudit(messages, fixedCount, contextRequest, contextProfile, sourceRules, rules) : undefined
    // Bridge-side fallback for callers that bypass the browser adapter. Only
    // dynamic messages are projected; fixed rules and the original audit stay
    // intact, so the receipt digest still describes the real input.
    const projection = cleanMessagesForProjection(messages.slice(fixedCount), this.config.inputCleanup ?? {})
    const dynamicRaw = projection.messages
    if (dynamicRaw.length === 0) throw badRequest('generate 至少需要一条动态消息', 'empty_dynamic_group')

    const rulesChanged = fixedCount > 0
      && JSON.stringify(sourceRules) !== JSON.stringify(chat.sourceFixedRules ?? chat.fixedRules ?? [])
    let targetSessionId = sessionId
    if (!targetSessionId && !rulesChanged) targetSessionId = chat.sessionId
    let resumedFromChat = !sessionId && Boolean(targetSessionId) && targetSessionId === chat.sessionId
    let createdNew = false
    const createFresh = async () => {
      targetSessionId = sessionIdFor(scope.scopeKey, requestId, 'generate')
      await this.createOrResumeSession(chat, {
        sessionId: targetSessionId,
        title: scopedTitle(chatId, dynamicRaw, undefined, scope.clientId, scope.taskId),
        maxTokens,
        fixedRules: rules,
        reason: 'generate',
      })
      createdNew = true
      resumedFromChat = false
    }
    if (!targetSessionId) {
      await createFresh()
    } else {
      try {
        await this.ensureSession(chat, maxTokens, { sessionId: targetSessionId, fixedRules: rules, missingStatus: 410 })
      } catch (error) {
        if (!sessionId && error instanceof BridgeError && error.status === 410) {
          // A static preset has no way to send a replacement session_id; drop
          // the stale local binding and rebuild instead of failing forever.
          await createFresh()
        } else if (error instanceof BridgeError && error.code === 'session_archived' && this.config.sessionOnArchived === 'recreate') {
          this.log(`[dsh-session] 会话 ${targetSessionId} 已归档，按配置新建`)
          await createFresh()
        } else {
          throw error
        }
      }
    }

    // Snapshot diff only runs against the session that actually serves this
    // turn. A recreated/compacted session must never receive a trimmed body.
    const diffed = await this.applySnapshotDiff({ scope, chat, sessionId: targetSessionId, messages: dynamicRaw })
    // Markers are transport-only: always strip them before the model sees the
    // text, even when no snapshot existed or the diff was skipped.
    const dynamic = stripMarkersInMessages(diffed.messages, this.config.snapshotDiff?.marker)
    let leadingSystem = 0
    while (leadingSystem < dynamic.length && dynamic[leadingSystem].role === 'system') leadingSystem += 1
    const dynamicSystem = dynamic.slice(0, leadingSystem)
    const dynamicBody = dynamic.slice(leadingSystem)
    if (dynamicBody.length === 0 || !dynamicBody.some(message => message.role === 'user')) {
      throw badRequest('generate 的动态组必须包含 user 消息', 'missing_user_message')
    }

    // Fixed-preset separation runs only after scope + messages are validated and
    // never touches requestHash, so retries stay idempotent.
    const presetPlan = this.planPreset({ scope, chat, dynamicSystem })

    const runtime = this.runtimeFor(targetSessionId, rules)
    runtime.params = params
    runtime.dynamicSystem = presetPlan.dynamicSystem
    runtime.managedPreset = presetPlan.managedPreset
    runtime.protocol = true
    const append = Boolean(targetSessionId)
      && (resumedFromChat || Boolean(sessionId && fixedCount === 0))
    const prompt = append
      ? composeAppendPrompt(dynamicBody, { format: this.config.appendFormat, nonce: this.config.appendNonce })
      : composeInitialPrompt(dynamicBody)

    this.store.updateChat(scope.scopeKey, {
      clientId: scope.clientId,
      taskId: scope.taskId,
      scopeKey: scope.scopeKey,
      sessionId: targetSessionId,
      fixedRules: rules,
      sourceFixedRules: sourceRules,
      knownMessages: [],
      title: scopedTitle(chatId, dynamicBody, undefined, scope.clientId, scope.taskId),
      protocol: 1,
      lastTarget: target ?? chat.lastTarget ?? null,
      ...(createdNew ? {
        previousSessions: this.previousSessions(chat, targetSessionId, 'generate'),
        generation: (chat.generation ?? 0) + 1,
      } : {}),
    })

    const snapshotConfig = this.config.snapshotDiff ?? {}
    const snapshotMode = snapshotConfig.mode === 'marker' ? 'marker' : 'auto'
    const snapshotMarker = snapshotConfig.enabled === true ? normalizeSnapshotMarker(snapshotConfig.marker) : ''
    const snapshotClients = Array.isArray(snapshotConfig.clients) ? snapshotConfig.clients : []
    const snapshotEnabled = snapshotConfig.enabled === true
      && (snapshotMode === 'auto' || Boolean(snapshotMarker))
      && (snapshotClients.length === 0 || snapshotClients.includes(scope.clientId))

    const pending = {
      status: 'pending',
      action: 'generate',
      requestHash,
      sessionId: targetSessionId,
      fixedRules: rules,
      ...(contextAudit ? { contextAudit } : {}),
      ...(presetPlan.diagnostic ? { preset: presetPlan.diagnostic } : {}),
      ...(projection.diagnostic ? { inputCleanup: projection.diagnostic } : {}),
      ...(diffed.diagnostic ? { dynamicDiff: diffed.diagnostic } : {}),
      target: target ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.store.putRequest(scope.scopeKey, requestId, pending)

    try {
      this.log(`[dsh-session] generate ${scope.clientId}/${chatId}/${scope.taskId} request=${requestId} session=${targetSessionId} fixed=${fixedCount} dynamic=${dynamic.length}`)
      const retryTimes = Number.isInteger(this.config.transientRetry) && this.config.transientRetry > 0
        ? this.config.transientRetry
        : 0
      let attempt = 0
      let sent
      let result
      for (;;) {
        sent = await this.sendPrompt(targetSessionId, requestId, prompt)
        try {
          result = await this.waitForTurn(targetSessionId, requestId, sent?.baselineEventCount)
          if (!result.ok) throw this.turnFailure(result, targetSessionId)
          break
        } catch (error) {
          const retryable = error instanceof BridgeError
            && error.code !== 'provider_session_blocked'
            && [429, 500, 502, 503, 504].includes(error.status)
          // Only retry when the prompt never produced a user message. Once the
          // session contains the turn, resending would duplicate it.
          if (attempt < retryTimes && retryable && !(await this.sessionHasMessage(targetSessionId, sent?.messageId))) {
            attempt += 1
            this.log(`[dsh-session] 瞬时错误 ${error.code}，重试 ${attempt}/${retryTimes} request=${requestId}`)
            continue
          }
          throw error
        }
      }
      if (!result.answer || result.answer.trim() === '') {
        throw upstreamError('Agent 回合结束，但没有产生可返回的最终文本；工具调用或中间步骤不计入最终回答', 'empty_answer')
      }
      this.store.updateChat(scope.scopeKey, {
        clientId: scope.clientId,
        taskId: scope.taskId,
        scopeKey: scope.scopeKey,
        sessionId: targetSessionId,
        fixedRules: rules,
        knownMessages: [],
        lastTurn: result.turn,
        lastTarget: target ?? chat.lastTarget ?? null,
        protocol: 1,
        ...(presetPlan.diagnostic ? { presetDiagnostic: presetPlan.diagnostic } : {}),
        ...(snapshotEnabled ? {
          snapshot: this.buildSnapshot({
            sessionId: targetSessionId,
            turn: result.turn,
            generation: (chat.generation ?? 0) + (createdNew ? 1 : 0),
            requestId,
            messageId: sent?.messageId,
            messages: dynamicRaw,
            marker: snapshotMarker,
            mode: snapshotMode,
            maxBlockChars: snapshotConfig.maxBlockChars,
          }),
        } : {}),
      })
      this.confirmPresetInstall(scope.scopeKey, targetSessionId, presetPlan.install, presetPlan.diagnostic)
      this.store.putRequest(scope.scopeKey, requestId, {
        ...pending,
        status: 'done',
        answer: result.answer,
        usage: result.usage,
        finishReason: result.finishReason ?? 'stop',
        turn: result.turn,
        updatedAt: nowIso(),
      })
      return {
        action: 'generate',
        answer: result.answer,
        usage: result.usage,
        finishReason: result.finishReason ?? 'stop',
        sessionId: targetSessionId,
        turn: result.turn,
        idempotent: false,
        ...(contextAudit ? { contextAudit } : {}),
        ...(presetPlan.diagnostic ? { preset: presetPlan.diagnostic } : {}),
        ...(projection.diagnostic ? { inputCleanup: projection.diagnostic } : {}),
        ...(diffed.diagnostic ? { dynamicDiff: diffed.diagnostic } : {}),
      }
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : upstreamError(error instanceof Error ? error.message : String(error))
      if (bridgeError.code === 'unsupported_reasoning_effort') {
        // The failed turn produced no assistant output, so dropping the
        // request record lets the client retry the same request_id after it
        // fixes the thinking setting. Other failures stay cached.
        this.store.removeRequest(scope.scopeKey, requestId)
      } else {
        try {
          this.store.putRequest(scope.scopeKey, requestId, {
            ...pending,
            status: 'error',
            httpStatus: bridgeError.status,
            errorCode: bridgeError.code,
            errorMessage: bridgeError.message,
            updatedAt: nowIso(),
          })
        } catch (persistError) {
          this.log(`[dsh-session] 保存失败请求记录失败: ${persistError.message}`)
        }
      }
      throw bridgeError
    } finally {
      // Dynamic system material and sampling overrides belong only to this
      // turn. Clearing them keeps a later manual turn in the DSH UI from
      // inheriting a stale worldbook or the bridge's temperature/max_tokens.
      runtime.dynamicSystem = []
      runtime.params = {}
    }
  }

  async tryRecoverDshSession(scopeKey, requestId, record) {
    if (!record.sessionId) return undefined
    try {
      const events = await this.readEvents(record.sessionId, true)
      const result = recoverTurn(events, requestId)
      if (!result) {
        let exists = true
        try {
          exists = await this.sessionExists(record.sessionId)
        } catch {
          // Keep the request pending; a transient read failure is not proof
          // that the session is gone.
        }
        if (!exists) throw sessionGone(`DSH 会话 ${record.sessionId} 已失效；请清除绑定后重新初始化`)
        return undefined
      }
      if (!result.ok || !result.answer || result.answer.trim() === '') {
        const failure = !result.ok ? this.turnFailure(result, record.sessionId)
          : upstreamError('Agent 回合结束，但没有产生可返回的最终文本', 'empty_answer')
        this.store.putRequest(scopeKey, requestId, {
          ...record,
          status: 'error',
          httpStatus: failure.status,
          errorCode: failure.code,
          errorMessage: failure.message,
          updatedAt: nowIso(),
        })
        throw failure
      }
      const patch = {
        sessionId: record.sessionId,
        lastTurn: result.turn,
        protocol: 1,
      }
      if (Array.isArray(record.fixedRules)) patch.fixedRules = record.fixedRules
      if (record.target !== undefined) patch.lastTarget = record.target
      this.store.updateChat(scopeKey, patch)
      this.store.putRequest(scopeKey, requestId, {
        ...record,
        status: 'done',
        answer: result.answer,
        usage: result.usage,
        finishReason: result.finishReason ?? 'stop',
        turn: result.turn,
        updatedAt: nowIso(),
      })
      return {
        action: 'generate',
        answer: result.answer,
        usage: result.usage,
        finishReason: result.finishReason ?? 'stop',
        sessionId: record.sessionId,
        turn: result.turn,
        idempotent: true,
        ...(record.contextAudit ? { contextAudit: record.contextAudit } : {}),
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error
      return undefined
    }
  }

  statusScoped(scope) {
    const chat = this.store.getChat(scope.scopeKey)
    const base = {
      client_id: scope.clientId,
      chat_id: scope.chatId,
      task_id: scope.taskId,
      scope_key: scope.scopeKey,
    }
    if (!chat) return { ...base, bound: false }
    return {
      ...base,
      bound: true,
      session_id: chat.sessionId,
      title: chat.title,
      provider: chat.provider,
      model: chat.model,
      agent_preset: chat.agentPreset,
      generation: chat.generation ?? 0,
      known_messages: chat.knownMessages?.length ?? 0,
      fixed_rule_types: chat.fixedRules?.map(rule => rule.type) ?? [],
      last_target: chat.lastTarget ?? null,
      protocol: chat.protocol ?? null,
      previous_sessions: chat.previousSessions?.map(item => item.sessionId) ?? [],
      updated_at: chat.updatedAt,
    }
  }

  status(chatId) {
    return this.statusScoped(resolveScope({ chatId }))
  }

  resetScoped(scope) {
    if (this.queues.has(scope.scopeKey)) {
      throw conflict('当前聊天还有请求未结束，不能重置绑定', 'chat_busy')
    }
    const removed = this.store.removeChat(scope.scopeKey)
    this.log(`[bridge] 重置绑定 ${scope.clientId}/${scope.chatId}/${scope.taskId} removed=${removed}`)
    return {
      ok: true,
      client_id: scope.clientId,
      chat_id: scope.chatId,
      task_id: scope.taskId,
      scope_key: scope.scopeKey,
      removed,
    }
  }

  reset(chatId) {
    if (!chatId) throw badRequest('缺少 chat_id', 'missing_chat_id')
    return this.resetScoped(resolveScope({ chatId }))
  }

  capabilities() {
    return {
      object: 'bridge.capabilities',
      protocol_versions: [1],
      base_url: '/v1',
      persistent_sessions: true,
      scope_keys: ['client_id', 'chat_id', 'task_id'],
      control_actions: ['generate', 'sync_rules', 'reset'],
      input_modes: ['text', 'json', 'form_text'],
      tool_calls: false,
      strict_json: false,
      streaming: false,
      clients: ['baibai-image', 'yuzi-phone', 'shujuku'],
      fixed_preset_separation: true,
      fixed_preset_modes: ['off', 'exact', 'marker'],
      plain_compat: this.config.plainCompat?.enabled === true,
    }
  }

  clearRules(scope) {
    if (this.queues.has(scope.scopeKey)) {
      throw conflict('当前 scope 还有请求正在处理，请稍后再清除规则', 'chat_busy')
    }
    const chat = this.store.getChat(scope.scopeKey)
    const cleared = chat?.fixedRules?.length ?? 0
    const runtime = chat?.sessionId ? this.runtimes.get(chat.sessionId) : undefined
    if (runtime) {
      runtime.fixedRules = []
      runtime.dynamicSystem = []
    }
    if (chat) this.store.updateChat(scope.scopeKey, { fixedRules: [], knownMessages: [] })
    return {
      ok: true,
      client_id: scope.clientId,
      chat_id: scope.chatId,
      task_id: scope.taskId,
      cleared,
    }
  }

  models() {
    return {
      object: 'list',
      data: [{ id: 'dsh-default', object: 'model' }],
    }
  }

  dispose() {
    for (const [sessionId, handle] of this.handles) {
      try {
        void handle?.dispose?.()
      } catch (error) {
        this.log(`[bridge] 关闭会话句柄 ${sessionId} 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.handles.clear()
    this.runtimes.clear()
  }
}
