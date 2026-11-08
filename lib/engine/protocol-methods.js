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

export const protocolMethods = {
  augmentProtocolAssembly(assembled, sessionId) {
    const runtime = this.runtimes.get(sessionId)
    const rules = runtime?.fixedRules?.length ? runtime.fixedRules : this.fixedRulesForSession(sessionId)
    const dynamicSystem = runtime?.dynamicSystem ?? []
    const skillText = runtime?.skillText
      ?? this.store.listChats().find(item => item.sessionId === sessionId)?.skillText
      ?? ''
    const source = Array.isArray(assembled.sections) ? assembled.sections : []
    const sections = source.filter(section => ['deployment:persona-prefix', 'deployment:persona-suffix'].includes(section.name))
    const presetText = formatManagedPreset(runtime?.managedPreset)
    const rulesText = formatFixedRules(rules)
    const dynamicText = formatDynamicSystem(dynamicSystem)
    if (presetText && !sections.some(section => section.name === PRESET_SECTION)) {
      sections.push({ name: PRESET_SECTION, text: presetText, interpolate: false })
    }
    if (skillText && !sections.some(section => section.name === 'st-bridge:skill')) {
      sections.push({ name: 'st-bridge:skill', text: skillText, interpolate: false })
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
    const result = { ...assembled, sections, tools: bridgeToolSchemas(assembled, runtime), contexts: [] }
    if (runtime) runtime.renderedSystemText = renderedSystemText(sections)
    return result
  },

  replaceProtocolSystemSnapshot(runtime, position) {
    const session = (this.ctx.agents?.get?.(runtime.sessionId)
      ?? this.handles.get(runtime.sessionId)?.agent)?.session
    return this.systemSnapshot.apply({
      runtime,
      position,
      session,
      renderedText: runtime.renderedSystemText ?? '',
    }).replaced
  },

  assertDedicatedSurface(sessionId) {
    const session = (this.ctx.agents?.get?.(sessionId) ?? this.handles.get(sessionId)?.agent)?.session
    if (!Array.isArray(session?.surface?.nodes) || typeof session.eventAt !== 'function' || typeof session.append !== 'function') {
      throw upstreamError('当前 DSH 不支持专属模式所需的原生上下文隔离，请关闭专属模式或更新 DSH', 'dedicated_surface_unavailable')
    }
    return session
  },

  clearDedicatedHistory(sessionId, atlasMessageId) {
    const session = this.assertDedicatedSurface(sessionId)
    const nodes = [...session.surface.nodes]
    if (!nodes.length) return
    // Append an auditable surface replacement; immutable historical events remain in the log.
    // DSH derives model messages from this surface AFTER agent/request, not from request config.
    // The native leading system node is protected: replace it separately from the conversation tail.
    const turn = nodes.reduce((max, seq) => Math.max(max, session.eventAt(seq)?.data?.turn || 0), 1)
    const ranges = []
    let range = []
    for (const seq of nodes) {
      const event = session.eventAt(seq)
      const retained = atlasMessageId && event?.type === 'user/message' && event.data.id === atlasMessageId
      const systemHead = seq === nodes[0] && event?.type === 'system/message'
      if (retained || systemHead) {
        if (range.length) ranges.push(range)
        range = []
        if (systemHead) ranges.push([seq])
      } else range.push(seq)
    }
    if (range.length) ranges.push(range)
    for (const range of ranges.toReversed()) session.append('system/message', {
      turn, step: 1,
      message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } },
    }, { surfaceOp: { op: 'replace', startSeq: range[0], endSeq: range.at(-1) }, sourceEventSeqs: range })
    this.runtimeFor(sessionId).lastSystemSnapshotKey = undefined
    this.log(`[dsh-session] dedicated snapshot session=${sessionId} replaced=${ranges.reduce((count, range) => count + range.length, 0)} retained_atlas=${atlasMessageId ? 'yes' : 'no'}`)
  },

  async prepareLayoutAtlas(sessionId, atlas, chat) {
    if (!atlas) return null
    const session = this.assertDedicatedSurface(sessionId)
    const current = chat.layoutAtlas
    if (current?.sessionId === sessionId && current.hash === atlas.hash && session.surface.nodes.some(seq => {
      const event = session.eventAt(seq)
      return event?.type === 'user/message' && event.data.id === current.messageId
    })) return current
    if (!atlas.messages.length) {
      throw new BridgeError(410, 'layout_atlas_required', '本会话的完整版式图尚未载入或已被压缩，请重新同步并发送完整图册')
    }
    if (typeof this.ctx.attachments?.admitPromptContent !== 'function') {
      throw new BridgeError(503, 'image_attachment_unavailable', 'DSH 附件服务不可用，不能保留版式图')
    }
    const content = await this.ctx.attachments.admitPromptContent(atlas.messages.flatMap(message => [
      { type: 'text', text: message.text },
      ...message.images.map(image => ({ type: 'image', mediaType: image.mediaType, data: image.data })),
    ]))
    const messageId = `layout-atlas:${randomUUID()}`
    session.append('user/message', { id: messageId, role: 'user', content, source: { kind: 'user' } },
      { surfaceOp: 'append' })
    return { hash: atlas.hash, sessionId, messageId }
  },

  installHooks(agentCtx, runtime) {
    if (!agentCtx || runtime.hooked || typeof agentCtx.on !== 'function') return
    runtime.hooked = true
    // The deployment mounts runtime-context providers at the root, so they
    // would otherwise be inherited by every Agent. Keep the selected preset's
    // tool schemas (or only the caller tools in external-tool mode), but strip
    // inherited dynamic runtime context for this Agent.
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
      if (runtime.skillText && !sections.some(section => section.name === 'st-bridge:skill')) {
        sections.push({ name: 'st-bridge:skill', text: runtime.skillText, interpolate: false })
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
      const result = {
        ...assembled,
        sections,
        tools: bridgeToolSchemas(assembled, runtime),
        contexts: [],
      }
      runtime.renderedSystemText = renderedSystemText(sections)
      return result
    })
    agentCtx.on('tools/pre-execute', async (exec, next) => {
      const external = runtime.externalTools
      if (external && (external.stopped || !external.schemas.some(tool => tool.name === exec.name))) {
        return { kind: 'deny', reason: 'Only caller-provided external tools are allowed in this bridge session' }
      }
      return next()
    })
    agentCtx.on('agent/request', async (payload, next) => {
      if (runtime.externalTools?.stopped) throw conflict('外部工具等待已中断', 'tool_continuation_unavailable')
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
  },

  setupPreset(sessionId, runtime = this.runtimeFor(sessionId), presetId) {
    const presets = this.getService('agentPresets')
    const preset = String(presetId ?? this.config.agentPreset ?? '').trim()
    return async (agentCtx) => {
      if (presets?.mount && preset) await presets.mount(agentCtx, preset)
      this.installHooks(agentCtx, runtime)
    }
  },

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
   */,

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

  /** Persist an install only after the turn produced a final answer. */,

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
   */,

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
  },

  async sessionHasMessage(sessionId, messageId) {
    if (!messageId) return false
    try {
      const events = await this.readEvents(sessionId, true)
      return Array.isArray(events) && events.some(event => event?.type === 'user/message' && event?.data?.id === messageId)
    } catch {
      return false
    }
  },

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
  },
}
