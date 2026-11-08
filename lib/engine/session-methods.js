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
import { POLL_INTERVAL_MS, SESSION_TITLE_MAX, bridgeToolSchemas, leadingSystemMessages, renderedSystemText, isContextLengthError, isProviderSessionBlocked, isAccountError } from './helpers.js'

export const sessionMethods = {
  runtimeFor(sessionId, fixedRules) {
    let runtime = this.runtimes.get(sessionId)
    if (!runtime) {
      runtime = { sessionId, fixedRules: [], dynamicSystem: [], params: {} }
      this.runtimes.set(sessionId, runtime)
    }
    if (Array.isArray(fixedRules)) runtime.fixedRules = fixedRules
    return runtime
  },

  getService(name) {
    try {
      return this.ctx.get?.(name)
    } catch {
      return undefined
    }
  },

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
  },

  async createSession(chat, messages, title, maxTokens, reason) {
    return this.createSessionWithId(chat, {
      sessionId: `session-${randomUUID()}`,
      title: deriveTitle(chat.chatId, messages, title),
      maxTokens,
      fixedRules: chat.fixedRules ?? [],
      reason,
    })
  },

  async createSessionWithId(chat, { sessionId, title, maxTokens, fixedRules, reason }) {
    const agents = this.ctx.agents
    if (!agents?.create) throw new BridgeError(500, 'agents_unavailable', 'DSH agents 服务不可用，无法创建会话')
    const endpoint = this.endpointConfig(chat.clientId)
    const preset = this.presetFor(chat.clientId)
    const cwd = this.effectiveCwd(endpoint?.cwd)
    const agentOptions = await this.resolveAgentOptions(maxTokens, chat.clientId)
    const runtime = this.runtimeFor(sessionId, fixedRules ?? [])
    const options = {
      sessionId,
      meta: {
        cwd,
        ...(preset ? { agentPreset: preset } : {}),
      },
      agentOptions,
      setup: this.setupPreset(sessionId, runtime, preset),
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
    await this.attachWorkspace(sessionId, cwd)
    await this.renameSession(handle.agent.session, title || chat.title || chat.chatId)
    const nextChat = this.store.updateChat(chat.scopeKey ?? chat.chatId, {
      provider: agentOptions.provider,
      model: agentOptions.model,
      agentPreset: preset,
      cwd,
    })
    if (nextChat) {
      chat.provider = nextChat.provider
      chat.model = nextChat.model
      chat.agentPreset = nextChat.agentPreset
      chat.cwd = nextChat.cwd
    }
    return sessionId
  },

  async ensureSession(chat, maxTokens, options = {}) {
    const agents = this.ctx.agents
    if (!agents) throw new BridgeError(500, 'agents_unavailable', 'DSH agents 服务不可用')
    const sessionId = options.sessionId ?? chat.sessionId
    const archived = this.archivedSessionError(sessionId)
    if (archived) throw archived
    const fixedRules = options.fixedRules ?? chat.fixedRules ?? []
    const missingStatus = options.missingStatus ?? 409
    const runtime = this.runtimeFor(sessionId, fixedRules)
    const endpoint = this.endpointConfig(chat.clientId)
    const cwd = this.effectiveCwd(chat.cwd || endpoint?.cwd)
    const preset = chat.agentPreset || this.presetFor(chat.clientId)
    const live = agents.get?.(sessionId)
    if (live) {
      this.installHooks(live.ctx, runtime)
      await this.attachWorkspace(sessionId, cwd)
      return live
    }

    const agentOptions = await this.resolveAgentOptions(maxTokens, chat.clientId)
    const resumeOptions = {
      resumeSessionId: sessionId,
      agentOptions,
      setup: this.setupPreset(sessionId, runtime, preset),
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
    await this.attachWorkspace(sessionId, cwd)
    return handle.agent
  },

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
  },

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
   */,

  effectiveCwd(override = '') {
    const workspaces = this.getService('workspaceRegistry')?.list?.() ?? []
    const desired = String(override || this.config.cwd || '').trim()
    if (workspaces.length === 0) return desired || this.config.cwd
    if (!desired) return workspaces[0].path
    if (workspaces.some(workspace => samePath(workspace.path, desired))) return desired
    const fallback = workspaces[0].path
    if (!this.cwdFallbackLogged) {
      this.cwdFallbackLogged = true
      this.log(`[bridge] cwd ${desired} 不是 DSH 工作区，改用 ${fallback}`)
    }
    return fallback
  },

  async attachWorkspace(sessionId, cwdOverride = '') {
    const registry = this.getService('workspaceRegistry')
    const workspaces = registry?.list?.() ?? []
    if (workspaces.length === 0) {
      this.log(`[bridge] 没有工作区可挂载 ${sessionId}；会话仍可在 DSH 历史中找到`)
      return
    }
    const cwd = this.effectiveCwd(cwdOverride)
    const target = workspaces.find(workspace => samePath(workspace.path, cwd)) ?? workspaces[0]
    try {
      await target.attachSession?.(sessionId)
      this.log(`[bridge] 已挂载 ${sessionId} -> ${target.path}`)
    } catch (error) {
      this.log(`[bridge] 挂载会话 ${sessionId} 到工作区失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  },

  async renameSession(session, title) {
    const service = this.getService('sessionTitle')
    if (!service?.rename || !session) return
    try {
      service.rename(session, title.slice(0, SESSION_TITLE_MAX))
    } catch (error) {
      this.log(`[bridge] 设置会话标题失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  },

  async sendPrompt(sessionId, requestId, prompt, images = []) {
    const agents = this.ctx.agents
    const agent = agents?.get?.(sessionId)
    if (!agent?.followup) {
      throw new BridgeError(409, 'session_unavailable', `DSH 会话 ${sessionId} 当前没有运行中的 Agent`)
    }
    let content = [{ type: 'text', text: prompt || '（用户发送了图片）' }]
    if (images.length > 0) {
      if (!this.ctx.attachments || typeof this.ctx.attachments.admitPromptContent !== 'function') {
        throw new BridgeError(503, 'image_attachment_unavailable', 'DSH 附件服务不可用，不能接收图片')
      }
      try {
        content = await this.ctx.attachments.admitPromptContent([
          { type: 'text', text: prompt || '（用户发送了图片）' },
          ...images.map(image => ({ type: 'image', mediaType: image.mediaType, data: image.data })),
        ])
      } catch (error) {
        throw new BridgeError(400, 'image_rejected', `图片未被 DSH 接受：${error instanceof Error ? error.message : String(error)}`)
      }
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
        content,
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
   */,

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
  },

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
  },

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
  },

  archivedSessionError(sessionId) {
    const archivedIds = this.getService('workspaceRegistry')?.archivedSessionIds
    if (sessionId && Array.isArray(archivedIds) && archivedIds.includes(sessionId)) {
      return conflict(`DSH 会话 ${sessionId} 已归档，无法执行生成；请在 DSH 恢复该会话，或明确选择清除绑定后新建会话`, 'session_archived')
    }
    return undefined
  },

  turnFailure(result, sessionId) {
    if (result.code === 'agent_request_canceled') {
      return new BridgeError(499, result.code, result.message)
    }
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
  },

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
  },
}
