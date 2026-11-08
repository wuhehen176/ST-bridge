import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { ContextProfiles, parseContextRequest, applyContextProfile, contextAudit as buildContextAudit } from '../context-policy.js'
import { cleanMessagesForProjection } from '../input-cleanup.js'
import { diffAgainstSnapshot, normalizeSnapshotMarker, snapshotOf, stripMarkersInMessages } from '../snapshot-diff.js'
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
} from '../preset-policy.js'
import {
  baseMessagesFor,
  classifyContext,
  composeAppendPrompt,
  composeInitialPrompt,
  composeReplayPrompt,
  deriveTitle,
  normalizeMessages,
  withAssistant,
} from '../context.js'
import { BridgeError, badRequest, conflict, sessionGone, timeoutError, upstreamError } from '../errors.js'
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
} from '../session-protocol.js'
import { newChatRecord } from '../store.js'
import { clientEndpointConfig } from '../client-endpoints.js'
import { boundSkillFor, loadBoundSkill } from '../skill-binding.js'
import { parseLayoutAtlas } from '../layout-atlas.js'
import { ExternalTools } from '../external-tools.js'
import { SystemSnapshot } from '../system-snapshot.js'
import { recoverTurn } from '../turn.js'
import { clampInteger, hashRequest, nowIso, samePath, sha256, sleep } from '../util.js'
import { POLL_INTERVAL_MS, SESSION_TITLE_MAX, bridgeToolSchemas, leadingSystemMessages, renderedSystemText, isContextLengthError, isProviderSessionBlocked, isAccountError, sharedScopeKey } from './helpers.js'
import { sessionMethods } from './session-methods.js'
import { protocolMethods } from './protocol-methods.js'
import { dshMethods } from './dsh-methods.js'

export class BridgeEngine {
  constructor(ctx, config, store, log) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.log = log
    this.queues = new Map()
    this.pending = new Map()
    this.pendingSkills = new Map()
    this.handles = new Map()
    this.runtimes = new Map()
    this.externalTools = new ExternalTools(this)
    this.systemSnapshot = new SystemSnapshot({ mode: config.systemSnapshot?.mode, log })
    this.reasoningCache = new Map()
    this.contextProfiles = new ContextProfiles(join(config.stateDir || (store.file ? dirname(store.file) : process.cwd()), 'context-profiles.json'))
    this.presetConfigs = new PresetConfigs(join(config.stateDir || (store.file ? dirname(store.file) : process.cwd()), 'fixed-presets.json'))
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
        cwd: this.effectiveCwd(this.endpointConfig('baibai-image')?.cwd),
        provider: '',
        model: '',
        agentPreset: '',
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
        cwd: chat.cwd || this.effectiveCwd(),
        agentPreset: chat.agentPreset ?? '',
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

  endpointConfig(clientId) {
    return clientEndpointConfig(this.config, clientId)
  }

  scopeFor({ clientId, chatId, taskId }) {
    const scope = resolveScope({ clientId, chatId, taskId })
    if (this.endpointConfig(scope.clientId)?.persistentSession === true) {
      scope.shared = true
      scope.scopeKey = sharedScopeKey(scope.clientId)
    }
    return scope
  }

  /**
   * Model/preset/cwd overrides live on the plugin-access entry. A blank field
   * always follows DSH, never a separate bridge-wide default.
   */

  presetFor(clientId) {
    const endpoint = this.endpointConfig(clientId)
    if (endpoint?.agentPreset) return endpoint.agentPreset
    try {
      const defaultId = this.getService('agentPresets')?.defaultId
      return typeof defaultId === 'string' ? defaultId.trim() : ''
    } catch {
      return ''
    }
  }

  async resolveAgentOptions(maxTokens, clientId) {
    const selection = this.getService('agentDefaultModel')?.currentSelection?.() ?? {}
    const endpoint = this.endpointConfig(clientId)
    const provider = (endpoint?.provider || selection.provider || '').trim()
    const model = (endpoint?.model || selection.model || '').trim()
    if (!provider || !model) {
      throw new BridgeError(500, 'model_not_configured', '没有可用的 DSH 模型通道：请给插件接入条目选择模型，或在 DSH 中选择默认模型')
    }
    const limit = clampInteger(maxTokens ?? endpoint?.maxTokens, 1, Number.MAX_SAFE_INTEGER)
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

  dispose() {
    for (const live of [...this.externalTools.live.values()]) this.externalTools.cancel(live.scope.scopeKey)
    for (const [sessionId, handle] of this.handles) {
      try {
        void handle?.dispose?.()
      } catch (error) {
        this.log(`[bridge] 关闭会话句柄 ${sessionId} 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.handles.clear()
    this.runtimes.clear()
    this.pendingSkills.clear()
  }
}

Object.assign(BridgeEngine.prototype, sessionMethods, protocolMethods, dshMethods)
