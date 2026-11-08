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

export const dshMethods = {
  cachedDshResult(existing, action) {
    return {
      ...(existing.contextAudit ? { contextAudit: existing.contextAudit } : {}),
      // A cached answer keeps this turn's preset verdict. It is an audit of the
      // original request, not a fresh install or reuse decision.
      ...(existing.preset ? { preset: { ...existing.preset, cached: true } } : {}),
      ...(existing.inputCleanup ? { inputCleanup: existing.inputCleanup } : {}),
      ...(existing.dynamicDiff ? { dynamicDiff: existing.dynamicDiff } : {}),
      ...(existing.skill ? { skill: existing.skill } : {}),
      ...(existing.atlasHash ? { atlasHash: existing.atlasHash } : {}),
      action: existing.action ?? action,
      answer: existing.answer,
      usage: existing.usage,
      finishReason: existing.finishReason ?? 'stop',
      sessionId: existing.sessionId,
      turn: existing.turn,
      idempotent: true,
    }
  },

  async handleDshSession(input) {
    if (input.sessionMode !== undefined && input.sessionMode !== 'dedicated') throw badRequest('未知 session_mode', 'invalid_session_mode')
    if (input.skillId !== undefined && input.skillId !== null && input.skillId !== ''
      && (typeof input.skillId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.skillId))) {
      throw badRequest('skill_id 必须是 kebab-case 的 Skill 名称', 'invalid_skill_id')
    }
    if (input.sessionMode === 'dedicated' && input.externalTools) throw badRequest('专属模式暂不支持外部工具续接', 'dedicated_tools_unsupported')
    if (input.externalTools) return this.externalTools.handle(input)
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
    const scope = this.scopeFor({ clientId, chatId, taskId })
    scope.requestKey = scope.shared ? [chatId, requestId].join(String.fromCharCode(0)) : requestId
    if (input.sessionMode === 'dedicated') {
      if (input.sourceChatId !== undefined && (typeof input.sourceChatId !== 'string' || input.sourceChatId.length > 256)) throw badRequest('source_chat_id 必须是最长256字符的字符串', 'invalid_source_chat_id')
      scope.sessionMode = 'dedicated'
      scope.sourceChatId = input.sourceChatId
    }

    const action = parseAction(input.action)
    const sessionInput = typeof input.sessionId === 'string' && input.sessionId.trim() !== ''
      ? input.sessionId.trim()
      : undefined
    const target = parseTarget(input.target)
    const params = input.params && typeof input.params === 'object' ? input.params : {}
    const maxTokens = input.maxTokens ?? params.maxTokens
    const { messages, images } = normalizeMessages(input.messages ?? [], { allowEmpty: action === 'reset' })
    const contextRequest = parseContextRequest(input.context, messages)
    const fixedCount = input.fixedCount === undefined ? 0 : input.fixedCount
    const fixedTypes = input.fixedTypes === undefined ? [] : input.fixedTypes
    const layoutAtlas = parseLayoutAtlas(input.layoutAtlas, messages, fixedCount, scope.sessionMode === 'dedicated')
    if (layoutAtlas && action !== 'generate') throw badRequest('layout_atlas 只用于 generate', 'invalid_layout_atlas')

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

    if (input.skillEnabled !== undefined && typeof input.skillEnabled !== 'boolean') throw badRequest('skill_enabled 必须是布尔值', 'invalid_skill_enabled')
    const requestKey = this.pendingKey(scope.scopeKey, scope.requestKey)
    const priorRequest = this.store.getRequest(scope.scopeKey, scope.requestKey)
    const reservedSkill = this.pendingSkills.get(requestKey)
    const boundSkillId = input.skillEnabled === false ? null : boundSkillFor(this.config, effectiveClientId)
    const requestedSkillId = input.skillId || null
    if (input.skillEnabled === false && requestedSkillId) throw badRequest('关闭 Skill 时不应携带 skill_id', 'invalid_skill_enabled')
    if (!priorRequest && !reservedSkill && action !== 'reset' && input.skillEnabled === true && !boundSkillId) throw badRequest('当前入口尚未绑定 Skill，无法开启本次 Skill', 'skill_not_bound')
    if (!priorRequest && !reservedSkill && requestedSkillId && requestedSkillId !== boundSkillId) {
      throw conflict(`请求 skill_id 与管理员绑定不一致（绑定：${boundSkillId || '无'}）`, 'skill_binding_mismatch')
    }
    const chatBefore = this.store.getChat(scope.scopeKey)
    // Freeze at request acceptance, not session creation. Retries never read a newer file.
    const savedSkill = record => {
      if (Object.hasOwn(record, 'skillSnapshot')) {
        return typeof record.skillSnapshot === 'string'
          ? this.store.getSkillSnapshot(record.skillSnapshot) ?? { ...record.skill, text: undefined }
          : record.skillSnapshot
      }
      return record.skill ? { ...record.skill, text: chatBefore?.skillHash === record.skill.hash ? chatBefore.skillText : undefined } : null
    }
    let skill = priorRequest ? savedSkill(priorRequest) : reservedSkill ? reservedSkill.skill : null
    if (!priorRequest && !reservedSkill && action !== 'reset' && boundSkillId) {
      const presets = this.getService('agentPresets')
      if (typeof presets?.acquireScope !== 'function') {
        throw new BridgeError(503, 'skill_scope_unavailable', 'DSH 未提供预设 Skill 读取作用域，请更新宿主')
      }
      // Skill scopes are opaque Host identities, not bridge scopeKey strings.
      // A preset lease also exposes its providers before an Agent exists.
      const lease = await presets.acquireScope(this.presetFor(effectiveClientId) || this.config.agentPreset)
      try {
        skill = await loadBoundSkill(this.ctx, {
          skillId: boundSkillId,
          cwd: chatBefore?.cwd || this.effectiveCwd(this.endpointConfig(effectiveClientId)?.cwd),
          scope: lease.key,
        })
      } finally {
        await lease[Symbol.asyncDispose]()
      }
    }
    // A simultaneous identical request may have reserved its version while lookup awaited.
    const reservation = this.pendingSkills.get(requestKey)
    if (reservation) skill = reservation.skill
    else {
      const accepted = this.store.getRequest(scope.scopeKey, scope.requestKey)
      if (accepted) skill = savedSkill(accepted)
    }
    if (requestedSkillId && skill?.id !== requestedSkillId) throw conflict('同一 request_id 的指定 Skill 已变化，请使用新的 request_id', 'request_id_conflict')

    const hashInput = {
      action,
      fixedCount,
      fixedTypes,
      messages: messages.map(message => message.hash),
      ...(skill ? { skill: { id: skill.id, hash: skill.hash } } : {}),
      ...(input.skillEnabled !== undefined ? { skillEnabled: input.skillEnabled } : {}),
      target: target
        ? [target.floor ?? null, target.swipe_id ?? null, target.revision ?? null]
        : null,
    }
    if (scope.sessionMode === 'dedicated') hashInput.dedicated = { version: 1, sourceChatId: scope.sourceChatId ?? null }
    if (layoutAtlas) hashInput.layoutAtlas = { hash: layoutAtlas.hash, indices: layoutAtlas.indices }
    // Attribution is observational. Only an actual rule selection changes model input.
    if (contextRequest && contextRequest.profile_id !== 'original') hashInput.context = {
      profile_id: contextRequest.profile_id,
      ...(contextRequest.profile_hash ? { profile_hash: contextRequest.profile_hash } : {}),
    }
    // Keep the pre-scope hash for the legacy baibai binding so an in-flight
    // request or stored record remains idempotent across the upgrade.
    if (!scope.legacy) hashInput.scope = scope.scopeKey
    const requestHash = hashRequest(hashInput)

    const existing = this.store.getRequest(scope.scopeKey, scope.requestKey)
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
        const inFlight = this.pending.get(this.pendingKey(scope.scopeKey, scope.requestKey))
        if (inFlight) return inFlight
        if (action === 'generate') {
          try {
            const recovered = await this.tryRecoverDshSession(scope.scopeKey, scope.requestKey, existing)
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

    const key = this.pendingKey(scope.scopeKey, scope.requestKey)
    const inFlight = this.pending.get(key)
    if (inFlight) {
      if (reservation && reservation.requestHash !== requestHash) throw conflict('同一 request_id 的请求内容已变化', 'request_id_conflict')
      return inFlight
    }
    if (skill && typeof skill.text !== 'string') throw conflict('本次旧请求的 Skill 快照已不可用，请使用新的 request_id，桥接不会改用新版重放', 'skill_version_unavailable')
    this.store.rememberSkill(skill)

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
      skill,
      layoutAtlas,
      images: messages.slice(fixedCount).flatMap(message => message.images ?? []),
      contextRequest,
      contextProfile: this.contextProfiles.resolve(contextRequest?.profile_id, scope, contextRequest?.profile_hash),
    }))
    this.pending.set(key, promise)
    this.pendingSkills.set(key, { skill, requestHash })
    try {
      return await promise
    } finally {
      if (this.pending.get(key) === promise) {
        this.pending.delete(key)
        this.pendingSkills.delete(key)
      }
    }
  },

  async runDshAction({ scope, chatId, requestId, action, sessionId, messages, fixedCount, fixedTypes, target, maxTokens, params, requestHash, skill, images, contextRequest, contextProfile, layoutAtlas }) {
    let chat = this.store.getChat(scope.scopeKey)
    if (!chat) {
      chat = newChatRecord({
        chatId: scope.shared ? scope.scopeKey : chatId,
        clientId: scope.clientId,
        taskId: scope.shared ? 'shared' : scope.taskId,
        scopeKey: scope.scopeKey,
        sessionId: '',
        title: scopedTitle(chatId, messages, undefined, scope.clientId, scope.taskId),
        cwd: this.effectiveCwd(this.endpointConfig(scope.clientId)?.cwd),
        provider: '',
        model: '',
        agentPreset: this.presetFor(scope.clientId),
      })
      if (scope.shared) chat.sharedChats = {}
      this.store.putChat(scope.scopeKey, chat)
    }
    if (scope.shared && sessionId && sessionId !== chat.sessionId) {
      this.log(`[dsh-session] 共享窗口忽略旧 session_id ${sessionId}`)
      sessionId = undefined
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

    if (chat.externalToolPending) {
      if (action !== 'reset') throw conflict('先回填待执行工具结果，或显式重建会话', 'tool_result_required')
      this.externalTools.cancel(scope.scopeKey)
      chat = this.store.updateChat(scope.scopeKey, { externalToolPending: null, externalInputHashes: [] })
    }
    if (action === 'reset') {
      chat = this.store.updateChat(scope.scopeKey, { externalInputHashes: [] })
      return this.resetDshSession({ scope, chat, requestId, requestHash, maxTokens, params })
    }
    if (action === 'sync_rules') {
      return this.syncDshRules({ scope, chat, requestId, sessionId, messages, fixedCount, fixedTypes, maxTokens, params, requestHash, skill })
    }
    try {
      return await this.generateDsh({ scope, chat, requestId, sessionId, messages, fixedCount, fixedTypes, target, maxTokens, params, requestHash, skill, images, contextRequest, contextProfile, layoutAtlas })
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'context_length_exceeded' && this.config.contextOverflow === 'recreate') {
        this.log(`[dsh-session] 上下文超限，重建会话 ${chat.sessionId || '(none)'}`)
        this.store.updateChat(scope.scopeKey, {
          sessionId: '',
          knownMessages: [],
          snapshot: null,
          ...(scope.shared ? { sharedChats: {} } : {}),
          presetManagement: null,
          presetDiagnostic: null,
        })
        const fresh = this.store.getChat(scope.scopeKey)
        return this.generateDsh({
          scope, chat: fresh, requestId, sessionId: undefined, messages, fixedCount, fixedTypes,
          target, maxTokens, params, requestHash, skill, images, contextRequest, contextProfile, layoutAtlas,
        })
      }
      throw error
    }
  },

  async resetDshSession({ scope, chat, requestId, requestHash, maxTokens, params }) {
    const chatId = scope.chatId
    const newSessionId = sessionIdFor(scope.scopeKey, scope.requestKey, 'reset')
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
      requestId,
      chatId: scope.chatId,
      shared: scope.shared === true,
      sessionId: newSessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.store.putRequest(scope.scopeKey, scope.requestKey, pending)
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
        taskId: scope.shared ? 'shared' : scope.taskId,
        scopeKey: scope.scopeKey,
        sessionId: newSessionId,
        fixedRules: [],
        sourceFixedRules: [],
        knownMessages: [],
        skillId: '',
        skillHash: '',
        skillProvider: '',
        skillText: '',
        layoutAtlas: null,
        title,
        previousSessions: previous,
        generation: (chat.generation ?? 0) + 1,
        lastTarget: null,
        protocol: 1,
        presetManagement: null,
        presetDiagnostic: null,
        snapshot: null,
        ...(scope.shared ? { sharedChats: {} } : {}),
      })
      this.store.putRequest(scope.scopeKey, scope.requestKey, { ...pending, status: 'done', updatedAt: nowIso() })
      this.log(`[dsh-session] reset ${scope.clientId}/${chatId}/${scope.taskId} -> ${newSessionId}`)
      return { action: 'reset', sessionId: newSessionId, idempotent: false }
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : upstreamError(error instanceof Error ? error.message : String(error))
      this.store.putRequest(scope.scopeKey, scope.requestKey, {
        ...pending,
        status: 'error',
        httpStatus: bridgeError.status,
        errorCode: bridgeError.code,
        errorMessage: bridgeError.message,
        updatedAt: nowIso(),
      })
      throw bridgeError
    }
  },

  async syncDshRules({ scope, chat, requestId, sessionId, messages, fixedCount, fixedTypes, maxTokens, params, requestHash, skill }) {
    const chatId = scope.chatId
    const rules = parseFixedRules(messages, fixedCount, fixedTypes, { requireAll: true })
    const rulesChanged = JSON.stringify(rules) !== JSON.stringify(chat.sourceFixedRules ?? chat.fixedRules ?? [])
    const title = chat.title || scopedTitle(chatId, messages, undefined, scope.clientId, scope.taskId)
    const candidate = sessionId || chat.sessionId
    const recreateArchived = Boolean(candidate)
      && this.config.sessionOnArchived === 'recreate'
      && this.archivedSessionError(candidate)
    if (recreateArchived) this.log(`[dsh-session] 协议同步会话 ${candidate} 已归档，按配置新建`)
    const reuse = Boolean(candidate) && !recreateArchived
    const targetSessionId = recreateArchived
      ? sessionIdFor(scope.scopeKey, scope.requestKey, 'sync_rules')
      : (candidate || sessionIdFor(scope.scopeKey, scope.requestKey, 'sync_rules'))
    const runtime = this.runtimeFor(targetSessionId, rules)
    runtime.params = {}
    runtime.dynamicSystem = []
    runtime.protocol = true
    runtime.skillText = skill?.text ?? ''
    runtime.skillHash = skill?.hash ?? ''
    runtime.skillId = skill?.id ?? ''
    const pending = {
      status: 'pending',
      action: 'sync_rules',
      skillSnapshot: skill?.hash ?? null,
      ...(skill ? { skill: { id: skill.id, hash: skill.hash, provider: skill.provider } } : {}),
      requestHash,
      requestId,
      chatId: scope.chatId,
      shared: scope.shared === true,
      sessionId: targetSessionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.store.putRequest(scope.scopeKey, scope.requestKey, pending)
    try {
      if (reuse) {
        await this.ensureSession(chat, maxTokens, { sessionId: targetSessionId, fixedRules: rules, missingStatus: 410 })
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
        taskId: scope.shared ? 'shared' : scope.taskId,
        scopeKey: scope.scopeKey,
        sessionId: targetSessionId,
        fixedRules: rules,
        sourceFixedRules: rules,
        knownMessages: [],
        skillId: skill?.id ?? '',
        skillHash: skill?.hash ?? '',
        skillProvider: skill?.provider ?? '',
        skillText: skill?.text ?? '',
        title,
        protocol: 1,
        ...(scope.shared && (rulesChanged || !reuse) ? { sharedChats: {} } : {}),
        ...(reuse ? {} : {
          previousSessions: this.previousSessions(chat, targetSessionId, 'sync_rules'),
          generation: (chat.generation ?? 0) + 1,
        }),
      })
      this.store.putRequest(scope.scopeKey, scope.requestKey, { ...pending, status: 'done', updatedAt: nowIso() })
      this.log(`[dsh-session] sync_rules ${scope.clientId}/${chatId}/${scope.taskId} -> ${targetSessionId} (${rules.length} rules)`)
      return { action: 'sync_rules', sessionId: targetSessionId, idempotent: false, ...(skill ? { skill: { id: skill.id, hash: skill.hash, provider: skill.provider } } : {}) }
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : upstreamError(error instanceof Error ? error.message : String(error))
      this.store.putRequest(scope.scopeKey, scope.requestKey, {
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
   */,

  async generateDsh({ scope, chat, requestId, sessionId, messages, fixedCount, fixedTypes, target, maxTokens, params, requestHash, skill, images, contextRequest, contextProfile, layoutAtlas }) {
    const chatId = scope.chatId
    const sourceRules = fixedCount > 0
      ? parseFixedRules(messages, fixedCount, fixedTypes)
      : (chat.sourceFixedRules ?? chat.fixedRules ?? [])
    if (scope.sessionMode === 'dedicated' && sourceRules.length === 0) {
      throw conflict('专属会话缺少固定协议，请重新发送宿主协议后重试', 'fixed_rules_required')
    }
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
    const atlasIndices = new Set(layoutAtlas?.indices ?? [])
    const storyMessages = messages.filter((_, index) => index >= fixedCount && !atlasIndices.has(index))
    images = storyMessages.flatMap(message => message.images ?? [])
    const projection = cleanMessagesForProjection(storyMessages, this.config.inputCleanup ?? {})
    const dynamicRaw = projection.messages
    if (dynamicRaw.length === 0) throw badRequest('generate 至少需要一条动态消息', 'empty_dynamic_group')

    const rulesChanged = fixedCount > 0
      && JSON.stringify(sourceRules) !== JSON.stringify(chat.sourceFixedRules ?? chat.fixedRules ?? [])
    let targetSessionId = sessionId
    if (!targetSessionId && !rulesChanged) targetSessionId = chat.sessionId
    let resumedFromChat = !sessionId && Boolean(targetSessionId) && targetSessionId === chat.sessionId
    let createdNew = false
    const createFresh = async () => {
      targetSessionId = sessionIdFor(scope.scopeKey, scope.requestKey, 'generate')
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
    const sharedState = scope.shared ? (chat.sharedChats?.[scope.chatId] ?? null) : null
    const sharedTurns = scope.shared ? ((sharedState?.turns ?? 0) + 1) : 0
    const diffed = scope.sessionMode === 'dedicated'
      ? { messages: dynamicRaw, diagnostic: { status: 'dedicated-full-snapshot' } }
      : await this.applySnapshotDiff({ scope, chat, sessionId: targetSessionId, messages: dynamicRaw, snapshotState: sharedState, turns: sharedTurns })
    // Markers are transport-only: always strip them before the model sees the
    // text, even when no snapshot existed or the diff was skipped.
    const marker = this.config.snapshotDiff?.marker
    const dynamic = stripMarkersInMessages(diffed.messages, marker)
    let leadingSystem = 0
    while (leadingSystem < dynamic.length && dynamic[leadingSystem].role === 'system') leadingSystem += 1
    const dynamicSystem = leadingSystemMessages(dynamicRaw, marker)
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
    runtime.skillText = skill?.text ?? ''
    runtime.skillHash = skill?.hash ?? ''
    runtime.skillId = skill?.id ?? ''
    const append = scope.sessionMode !== 'dedicated' && Boolean(targetSessionId)
      && (resumedFromChat || Boolean(sessionId && fixedCount === 0))
    const prompt = append
      ? composeAppendPrompt(dynamicBody, { format: this.config.appendFormat, nonce: this.config.appendNonce })
      : composeInitialPrompt(dynamicBody)

    this.store.updateChat(scope.scopeKey, {
      clientId: scope.clientId,
      taskId: scope.shared ? 'shared' : scope.taskId,
      scopeKey: scope.scopeKey,
      sessionId: targetSessionId,
      fixedRules: rules,
      sourceFixedRules: sourceRules,
      knownMessages: [],
      skillId: skill?.id ?? '',
      skillHash: skill?.hash ?? '',
      skillProvider: skill?.provider ?? '',
      skillText: skill?.text ?? '',
      title: scopedTitle(chatId, dynamicBody, undefined, scope.clientId, scope.taskId),
      protocol: 1,
      lastTarget: target ?? chat.lastTarget ?? null,
      ...(scope.sessionMode === 'dedicated' ? { sessionMode: 'dedicated', lastSourceChatId: scope.sourceChatId ?? null } : {}),
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
      requestId,
      chatId: scope.chatId,
      shared: scope.shared === true,
      sessionId: targetSessionId,
      skillSnapshot: skill?.hash ?? null,
      fixedRules: rules,
      ...(skill ? { skill: { id: skill.id, hash: skill.hash, provider: skill.provider } } : {}),
      ...(contextAudit ? { contextAudit } : {}),
      ...(presetPlan.diagnostic ? { preset: presetPlan.diagnostic } : {}),
      ...(projection.diagnostic ? { inputCleanup: projection.diagnostic } : {}),
      ...(diffed.diagnostic ? { dynamicDiff: diffed.diagnostic } : {}),
      target: target ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.store.putRequest(scope.scopeKey, scope.requestKey, pending)

    try {
      const retainedAtlas = await this.prepareLayoutAtlas(targetSessionId, layoutAtlas, chat)
      if (retainedAtlas) pending.atlasHash = retainedAtlas.hash
      this.store.updateChat(scope.scopeKey, { layoutAtlas: retainedAtlas })
      this.log(`[dsh-session] generate ${scope.clientId}/${chatId}/${scope.taskId} request=${requestId} session=${targetSessionId} fixed=${fixedCount} dynamic=${dynamic.length}`)
      const retryTimes = Number.isInteger(this.config.transientRetry) && this.config.transientRetry > 0
        ? this.config.transientRetry
        : 0
      let attempt = 0
      let sent
      let result
      if (scope.sessionMode === 'dedicated') this.clearDedicatedHistory(targetSessionId, retainedAtlas?.messageId)
      for (;;) {
        sent = await this.sendPrompt(targetSessionId, requestId, prompt, images)
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
      const snapshot = snapshotEnabled ? this.buildSnapshot({
        sessionId: targetSessionId,
        turn: result.turn,
        generation: (chat.generation ?? 0) + (createdNew ? 1 : 0),
        requestId,
        messageId: sent?.messageId,
        messages: dynamicRaw,
        marker: snapshotMarker,
        mode: snapshotMode,
        maxBlockChars: snapshotConfig.maxBlockChars,
      }) : undefined
      const currentShared = scope.shared ? (this.store.getChat(scope.scopeKey)?.sharedChats ?? {}) : null
      this.store.updateChat(scope.scopeKey, {
        clientId: scope.clientId,
        taskId: scope.shared ? 'shared' : scope.taskId,
        scopeKey: scope.scopeKey,
        sessionId: targetSessionId,
        fixedRules: rules,
        knownMessages: [],
        lastTurn: result.turn,
        lastTarget: target ?? chat.lastTarget ?? null,
        protocol: 1,
        ...(presetPlan.diagnostic ? { presetDiagnostic: presetPlan.diagnostic } : {}),
        ...(scope.shared ? {
          sharedChats: {
            ...currentShared,
            [scope.chatId]: {
              ...(snapshot ? { snapshot } : (sharedState?.snapshot ? { snapshot: sharedState.snapshot } : {})),
              lastTurn: result.turn,
              turns: sharedTurns,
            },
          },
        } : snapshot ? { snapshot } : {}),
      })
      this.confirmPresetInstall(scope.scopeKey, targetSessionId, presetPlan.install, presetPlan.diagnostic)
      this.store.putRequest(scope.scopeKey, scope.requestKey, {
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
        ...(retainedAtlas ? { atlasHash: retainedAtlas.hash } : {}),
        ...(skill ? { skill: { id: skill.id, hash: skill.hash, provider: skill.provider } } : {}),
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
        this.store.removeRequest(scope.scopeKey, scope.requestKey)
      } else {
        try {
          this.store.putRequest(scope.scopeKey, scope.requestKey, {
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
  },

  async tryRecoverDshSession(scopeKey, requestKey, record) {
    if (!record.sessionId) return undefined
    try {
      const events = await this.readEvents(record.sessionId, true)
      const result = recoverTurn(events, record.requestId ?? requestKey)
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
        this.store.putRequest(scopeKey, requestKey, {
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
      if (record.shared && record.chatId) {
        const chat = this.store.getChat(scopeKey)
        const previous = chat?.sharedChats?.[record.chatId] ?? {}
        patch.taskId = 'shared'
        patch.sharedChats = {
          ...(chat?.sharedChats ?? {}),
          [record.chatId]: {
            ...previous,
            lastTurn: result.turn,
            turns: (previous.turns ?? 0) + 1,
          },
        }
      }
      this.store.updateChat(scopeKey, patch)
      this.store.putRequest(scopeKey, requestKey, {
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
        ...(record.skill ? { skill: record.skill } : {}),
        ...(record.atlasHash ? { atlasHash: record.atlasHash } : {}),
        ...(record.contextAudit ? { contextAudit: record.contextAudit } : {}),
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error
      return undefined
    }
  },

  statusScoped(scope) {
    const chat = this.store.getChat(scope.scopeKey)
    const base = {
      client_id: scope.clientId,
      chat_id: scope.chatId,
      task_id: scope.taskId,
      scope_key: scope.scopeKey,
      shared: scope.shared === true,
    }
    if (!chat) return { ...base, bound: false }
    return {
      ...base,
      bound: true,
      ...(scope.shared ? { shared_chats: Object.keys(chat.sharedChats ?? {}).length } : {}),
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
  },

  status(chatId) {
    return this.statusScoped(resolveScope({ chatId }))
  },

  sharedKeyFor(clientId) {
    return sharedScopeKey(clientId)
  },

  resetShared(clientId) {
    const scopeKey = sharedScopeKey(clientId)
    if (this.queues.has(scopeKey)) {
      throw conflict('当前插件还有请求未结束，不能切换持续会话', 'chat_busy')
    }
    this.externalTools.cancel(scopeKey)
    const removed = this.store.removeChat(scopeKey)
    this.log(`[bridge] 重置共享窗口 ${clientId} removed=${removed}`)
    return { ok: true, client_id: clientId, scope_key: scopeKey, removed }
  },

  resetScoped(scope) {
    if (this.queues.has(scope.scopeKey)) {
      throw conflict('当前聊天还有请求未结束，不能重置绑定', 'chat_busy')
    }
    this.externalTools.cancel(scope.scopeKey)
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
  },

  reset(chatId) {
    if (!chatId) throw badRequest('缺少 chat_id', 'missing_chat_id')
    return this.resetScoped(resolveScope({ chatId }))
  },

  capabilities() {
    return {
      object: 'bridge.capabilities',
      protocol_versions: [1],
      base_url: '/v1',
      persistent_sessions: true,
      shared_sessions: true,
      scope_keys: ['client_id', 'chat_id', 'task_id'],
      control_actions: ['generate', 'sync_rules', 'reset'],
      skill_updates: { mode: 'per-request', toggle: 'skill_enabled', retry: 'frozen-version' },
      input_modes: ['text', 'json', 'form_text'],
      tool_calls: true,
      image_input: {
        supported: true,
        modes: ['data_url'],
        media_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        roles: ['user'],
        max_bytes_per_image: 10 * 1024 * 1024,
        max_images_per_message: 20,
        max_total_bytes: 20 * 1024 * 1024,
      },
      layout_atlas: { supported: true, mode: 'session-prefix-v1' },
      external_tools: { streaming: false, execution: 'caller', tool_choice: ['auto'], parallel_execution: false },
      strict_json: false,
      streaming: false,
      clients: ['baibai-image', 'yuzi-phone', 'shujuku'],
      fixed_preset_separation: true,
      fixed_preset_modes: ['off', 'exact', 'marker'],
      plain_compat: this.config.plainCompat?.enabled === true,
    }
  },

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
    if (chat) this.store.updateChat(scope.scopeKey, {
      fixedRules: [],
      knownMessages: [],
      ...(scope.shared ? { sharedChats: {} } : {}),
    })
    return {
      ok: true,
      client_id: scope.clientId,
      chat_id: scope.chatId,
      task_id: scope.taskId,
      cleared,
    }
  },

  models() {
    return {
      object: 'list',
      data: [{ id: 'dsh-default', object: 'model' }],
    }
  },
}
