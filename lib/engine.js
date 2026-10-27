import { randomUUID } from 'node:crypto'
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
  return /context(?:\s+length)?|too many tokens|maximum context|token limit|上下文.{0,8}(?:超|长)|超出.{0,8}上下文|超过.{0,8}上下文/i.test(message)
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
  }

  runtimeFor(sessionId, fixedRules) {
    let runtime = this.runtimes.get(sessionId)
    if (!runtime) {
      runtime = { fixedRules: [], dynamicSystem: [], params: {} }
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
        cwd: this.config.cwd,
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
        cwd: this.config.cwd,
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
      ? composeAppendPrompt(classification.newMessages ?? [])
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
        throw this.turnFailure(result)
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
    return typeof sessionId === 'string' && sessionId.startsWith('session-bbh-')
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
    const rulesText = formatFixedRules(rules)
    const dynamicText = formatDynamicSystem(dynamicSystem)
    if (rulesText && !sections.some(section => section.name === 'baobaohui:fixed-rules')) {
      sections.push({ name: 'baobaohui:fixed-rules', text: rulesText })
    }
    if (dynamicText && !sections.some(section => section.name === 'baobaohui:dynamic-system')) {
      sections.push({ name: 'baobaohui:dynamic-system', text: dynamicText })
    }
    if (!sections.some(section => section.name === TURN_POLICY_SECTION)) {
      sections.push({ name: TURN_POLICY_SECTION, text: formatTurnPolicy() })
    }
    return { ...assembled, sections, tools: [], contexts: [] }
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
      const rules = formatFixedRules(runtime.fixedRules)
      const dynamicSystem = formatDynamicSystem(runtime.dynamicSystem)
      const source = Array.isArray(assembled.sections) ? assembled.sections : []
      const sections = source.filter(section => keepSections.has(section.name))
      if (rules && !sections.some(section => section.name === 'baobaohui:fixed-rules')) {
        sections.push({ name: 'baobaohui:fixed-rules', text: rules })
      }
      if (dynamicSystem && !sections.some(section => section.name === 'baobaohui:dynamic-system')) {
        sections.push({ name: 'baobaohui:dynamic-system', text: dynamicSystem })
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
    agentCtx.on('agent/request', async (_payload, next) => {
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
      return applyRuntimeParams(resolved, params, { reasoningEfforts: efforts })
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
        cwd: this.config.cwd,
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

  async attachWorkspace(sessionId) {
    const registry = this.getService('workspaceRegistry')
    const workspaces = registry?.list?.() ?? []
    if (workspaces.length === 0) {
      this.log(`[bridge] 没有工作区可挂载 ${sessionId}；会话仍可在 DSH 历史中找到`)
      return
    }
    const target = workspaces.find(workspace => samePath(workspace.path, this.config.cwd)) ?? workspaces[0]
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

  turnFailure(result) {
    const message = result.message || 'Agent 回合失败'
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
      if (!result.ok) {
        this.store.putRequest(chatId, requestId, {
          ...record,
          status: 'error',
          httpStatus: 502,
          errorCode: result.code,
          errorMessage: result.message,
          updatedAt: nowIso(),
        })
        return undefined
      }
      if (!result.answer || result.answer.trim() === '') return undefined
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
    } catch {
      return undefined
    }
  }

  cachedDshResult(existing, action) {
    return {
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
    }))
    this.pending.set(key, promise)
    try {
      return await promise
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key)
    }
  }

  async runDshAction({ scope, chatId, requestId, action, sessionId, messages, fixedCount, fixedTypes, target, maxTokens, params, requestHash }) {
    let chat = this.store.getChat(scope.scopeKey)
    if (!chat) {
      chat = newChatRecord({
        chatId,
        clientId: scope.clientId,
        taskId: scope.taskId,
        scopeKey: scope.scopeKey,
        sessionId: '',
        title: scopedTitle(chatId, messages, undefined, scope.clientId, scope.taskId),
        cwd: this.config.cwd,
        provider: '',
        model: '',
        agentPreset: this.config.agentPreset,
      })
      this.store.putChat(scope.scopeKey, chat)
    }
    if (sessionId && action !== 'reset' && chat.sessionId !== sessionId) {
      throw sessionGone(`DSH 会话 ${sessionId} 不属于该 client_id/chat_id/task_id 范围，或绑定已失效；请清除绑定后重新初始化`)
    }

    if (action === 'reset') return this.resetDshSession({ scope, chat, requestId, requestHash, maxTokens, params })
    if (action === 'sync_rules') {
      return this.syncDshRules({ scope, chat, requestId, sessionId, messages, fixedCount, fixedTypes, maxTokens, params, requestHash })
    }
    return this.generateDsh({ scope, chat, requestId, sessionId, messages, fixedCount, fixedTypes, target, maxTokens, params, requestHash })
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
        knownMessages: [],
        title,
        previousSessions: previous,
        generation: (chat.generation ?? 0) + 1,
        lastTarget: null,
        protocol: 1,
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

  async generateDsh({ scope, chat, requestId, sessionId, messages, fixedCount, fixedTypes, target, maxTokens, params, requestHash }) {
    const chatId = chat.chatId
    const rules = fixedCount > 0
      ? parseFixedRules(messages, fixedCount, fixedTypes)
      : (chat.fixedRules ?? [])
    const dynamic = messages.slice(fixedCount)
    if (dynamic.length === 0) throw badRequest('generate 至少需要一条动态消息', 'empty_dynamic_group')
    let leadingSystem = 0
    while (leadingSystem < dynamic.length && dynamic[leadingSystem].role === 'system') leadingSystem += 1
    const dynamicSystem = dynamic.slice(0, leadingSystem)
    const dynamicBody = dynamic.slice(leadingSystem)
    if (dynamicBody.length === 0 || !dynamicBody.some(message => message.role === 'user')) {
      throw badRequest('generate 的动态组必须包含 user 消息', 'missing_user_message')
    }

    const rulesChanged = fixedCount > 0
      && JSON.stringify(rules) !== JSON.stringify(chat.fixedRules ?? [])
    let targetSessionId = sessionId
    if (!targetSessionId && !rulesChanged) targetSessionId = chat.sessionId
    let resumedFromChat = !sessionId && Boolean(targetSessionId) && targetSessionId === chat.sessionId
    let createdNew = false
    const createFresh = async () => {
      targetSessionId = sessionIdFor(scope.scopeKey, requestId, 'generate')
      await this.createOrResumeSession(chat, {
        sessionId: targetSessionId,
        title: scopedTitle(chatId, dynamicBody, undefined, scope.clientId, scope.taskId),
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
        } else {
          throw error
        }
      }
    }

    const runtime = this.runtimeFor(targetSessionId, rules)
    runtime.params = params
    runtime.dynamicSystem = dynamicSystem
    runtime.protocol = true
    const append = Boolean(targetSessionId)
      && (resumedFromChat || Boolean(sessionId && fixedCount === 0))
    const prompt = append ? composeAppendPrompt(dynamicBody) : composeInitialPrompt(dynamicBody)

    this.store.updateChat(scope.scopeKey, {
      clientId: scope.clientId,
      taskId: scope.taskId,
      scopeKey: scope.scopeKey,
      sessionId: targetSessionId,
      fixedRules: rules,
      knownMessages: [],
      title: scopedTitle(chatId, dynamicBody, undefined, scope.clientId, scope.taskId),
      protocol: 1,
      lastTarget: target ?? chat.lastTarget ?? null,
      ...(createdNew ? {
        previousSessions: this.previousSessions(chat, targetSessionId, 'generate'),
        generation: (chat.generation ?? 0) + 1,
      } : {}),
    })

    const pending = {
      status: 'pending',
      action: 'generate',
      requestHash,
      sessionId: targetSessionId,
      fixedRules: rules,
      target: target ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.store.putRequest(scope.scopeKey, requestId, pending)

    try {
      this.log(`[dsh-session] generate ${scope.clientId}/${chatId}/${scope.taskId} request=${requestId} session=${targetSessionId} fixed=${fixedCount} dynamic=${dynamic.length}`)
      const sent = await this.sendPrompt(targetSessionId, requestId, prompt)
      const result = await this.waitForTurn(targetSessionId, requestId, sent?.baselineEventCount)
      if (!result.ok) throw this.turnFailure(result)
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
      })
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
      if (!result.ok) {
        this.store.putRequest(scopeKey, requestId, {
          ...record,
          status: 'error',
          httpStatus: 502,
          errorCode: result.code,
          errorMessage: result.message,
          updatedAt: nowIso(),
        })
        return undefined
      }
      if (!result.answer || result.answer.trim() === '') return undefined
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
      }
    } catch (error) {
      if (error instanceof BridgeError && error.status === 410) throw error
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
