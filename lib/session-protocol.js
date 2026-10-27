import { deriveScopedTitle, messageHash } from './context.js'
import { badRequest } from './errors.js'
import { isPlainObject, sha256 } from './util.js'

export const PROTOCOL_VERSION = 1
export const ACTIONS = new Set(['generate', 'sync_rules', 'reset'])
export const FIXED_TYPES = new Set(['prefix', 'spec', 'contract', 'check'])
export const TURN_POLICY_SECTION = 'st-bridge:turn-policy'

const CLIENT_LABELS = {
  'baibai-image': '柏宝绘',
  'yuzi-phone': '玉子手机',
  shujuku: '数据库',
}

export function clientLabel(clientId) {
  if (!clientId) return CLIENT_LABELS['baibai-image']
  return CLIENT_LABELS[clientId] ?? clientId
}

export function normalizeClientId(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.trim())) {
    throw badRequest('client_id 必须是 1-128 位稳定插件标识（字母、数字、. _ : -）', 'invalid_client_id')
  }
  return value.trim()
}

export function normalizeTaskId(value) {
  if (value === undefined || value === null || value === '') return 'default'
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f]/.test(value)) {
    throw badRequest('task_id 必须是不含控制字符的字符串（最长 256）', 'invalid_task_id')
  }
  return value
}

/**
 * Resolve the isolation scope. Requests without client_id keep the old
 * baibai-image/chat_id binding so an upgrade does not silently start a new
 * empty session. Explicit baibai-image/default does the same.
 */
export function resolveScope({ clientId, chatId, taskId }) {
  const client = clientId ?? 'baibai-image'
  const task = taskId ?? 'default'
  if (client === 'baibai-image' && task === 'default') {
    return { clientId: client, taskId: task, chatId, scopeKey: chatId, legacy: true }
  }
  const scopeKey = `scope:${sha256(JSON.stringify([client, chatId, task]))}`
  return { clientId: client, taskId: task, chatId, scopeKey, legacy: false }
}

export function scopedTitle(chatId, messages, explicitTitle, clientId, taskId) {
  const taskPart = taskId && taskId !== 'default' ? ` · ${taskId}` : ''
  return deriveScopedTitle(chatId, messages, explicitTitle, `${clientLabel(clientId)}${taskPart}`)
}

export function formatTurnPolicy() {
  return [
    '## 本轮快照优先',
    '本轮动态资料是最新状态快照。若与更早的会话历史冲突，以本轮为准。',
    '不要从旧助手回复中补回已删除的记录，也不要继续执行上一轮尚未完成的指令。',
    '持久历史只提供背景，不代替本次状态快照。',
  ].join('\n')
}

const TOOL_MODE_MESSAGE = '当前 DSH 通用会话只支持文本、JSON 和填表文本指令，请切换文本模式或使用支持原生工具调用的 API'

/**
 * Reject OpenAI tool/function protocol instead of silently deleting it or
 * pretending the call succeeded. DSH-internal Agent tools are separate.
 */
function nonEmpty(value) {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function assertTextOnlyRequest(body) {
  if (nonEmpty(body.tools)) {
    throw badRequest(TOOL_MODE_MESSAGE, 'unsupported_tool_mode')
  }
  if (nonEmpty(body.functions)) {
    throw badRequest(TOOL_MODE_MESSAGE, 'unsupported_tool_mode')
  }
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      const role = message?.role
      if (role === 'tool' || role === 'function') {
        throw badRequest(TOOL_MODE_MESSAGE, 'unsupported_tool_mode')
      }
      if (nonEmpty(message?.tool_calls)) {
        throw badRequest(TOOL_MODE_MESSAGE, 'unsupported_tool_mode')
      }
      if (message?.function_call !== undefined && message.function_call !== null) {
        throw badRequest(TOOL_MODE_MESSAGE, 'unsupported_tool_mode')
      }
    }
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    const value = typeof body.tool_choice === 'string' ? body.tool_choice.toLowerCase() : body.tool_choice
    if (typeof value === 'object' || value === 'required' || value === 'any') {
      throw badRequest(TOOL_MODE_MESSAGE, 'unsupported_tool_mode')
    }
  }
  if (body.function_call !== undefined && body.function_call !== null) {
    const value = typeof body.function_call === 'string' ? body.function_call.toLowerCase() : body.function_call
    if (typeof value === 'object' || (value !== 'none' && value !== 'auto')) {
      throw badRequest(TOOL_MODE_MESSAGE, 'unsupported_tool_mode')
    }
  }
  if (body.response_format && typeof body.response_format === 'object') {
    if (body.response_format.type === 'json_schema' || body.response_format.json_schema) {
      throw badRequest(
        '当前 DSH 通用会话不提供严格 response_format/json_schema 约束采样；请移除该约束，或使用支持严格结构化输出的 API',
        'unsupported_response_format',
      )
    }
  }
}

export function parseAction(value) {
  if (value === undefined || value === null || value === '') return 'generate'
  if (typeof value !== 'string' || !ACTIONS.has(value)) {
    throw badRequest('dsh_session.action 必须是 generate、sync_rules 或 reset', 'invalid_action')
  }
  return value
}

/**
 * Split and validate the fixed group at the head of messages.
 *
 * The fixed group is keyed by purpose, not by position alone: the types array
 * is one-to-one with the first `fixedCount` messages. This lets the bridge
 * update a single rule slot without keeping the previous version active.
 */
export function parseFixedRules(messages, fixedCount, fixedTypes, { requireAll = false } = {}) {
  if (!Number.isInteger(fixedCount) || fixedCount < 0 || fixedCount > messages.length) {
    throw badRequest('fixed_message_count 必须是 0 到 messages.length 之间的整数', 'invalid_fixed_count')
  }
  const types = fixedTypes === undefined || fixedTypes === null ? [] : fixedTypes
  if (!Array.isArray(types)) {
    throw badRequest('fixed_message_types 必须是数组', 'invalid_fixed_types')
  }
  if (types.length !== fixedCount) {
    throw badRequest('fixed_message_types 必须与 fixed_message_count 逐条对应', 'fixed_types_mismatch')
  }
  if (requireAll && fixedCount !== messages.length) {
    throw badRequest('该操作只接收固定组，messages 不能包含动态消息', 'dynamic_messages_not_allowed')
  }
  const rules = []
  const seen = new Set()
  for (let index = 0; index < fixedCount; index += 1) {
    const type = types[index]
    if (typeof type !== 'string' || !FIXED_TYPES.has(type)) {
      throw badRequest(`fixed_message_types[${index}] 必须是 prefix、spec、contract 或 check`, 'invalid_fixed_type')
    }
    if (seen.has(type)) {
      throw badRequest(`fixed_message_types 重复：${type}`, 'duplicate_fixed_type')
    }
    seen.add(type)
    const message = messages[index]
    rules.push({
      type,
      role: message.role,
      text: message.text,
      hash: message.hash ?? messageHash(message.role, message.text, message.name),
    })
  }
  return rules
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/**
 * Render the latest confirmed fixed group as one dynamic system section.
 * The original role, order, and text are preserved; the section is replaced
 * wholesale on sync_rules, never paralleled with an older version.
 */
export function formatFixedRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return ''
  const lines = [
    '## 当前固定规则（最新确认版）',
    '以下规则按用途覆盖旧版本。生成时必须使用本版本，不要把旧规范与新规范并列执行。',
    '',
  ]
  for (const rule of rules) {
    lines.push(`<<<FIXED_RULE type="${escapeAttribute(rule.type)}" role="${escapeAttribute(rule.role)}">>>`)
    lines.push(rule.text)
    lines.push('<<<END_FIXED_RULE>>>')
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * Render this turn's dynamic system messages (character cards, worldbooks,
 * etc.) as a separate system section so their role and order are not lost by
 * flattening them into the user prompt.
 */
export function formatDynamicSystem(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const lines = ['## 本轮动态系统资料', '']
  messages.forEach((message, index) => {
    lines.push(`<<<DYNAMIC_SYSTEM index="${index}" role="${escapeAttribute(message.role)}">>>`)
    lines.push(message.text)
    lines.push('<<<END_DYNAMIC_SYSTEM>>>')
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}

/**
 * Stable session identity for a protocol operation. Reusing request_id after
 * a crash therefore targets the same DSH session instead of creating another.
 */
export function sessionIdFor(chatId, requestId, action) {
  const hex = sha256(`st-bridge:${action}:${chatId}:${requestId}`).slice(0, 32)
  return `session-st-${hex}`
}

export function parseTarget(raw) {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) throw badRequest('dsh_session.target 必须是对象', 'invalid_target')
  const target = {}
  if (raw.floor !== undefined) {
    if (!Number.isInteger(raw.floor) || raw.floor < 0) {
      throw badRequest('target.floor 必须是非负整数', 'invalid_target')
    }
    target.floor = raw.floor
  }
  if (raw.swipe_id !== undefined) {
    if (raw.swipe_id !== null && !Number.isInteger(raw.swipe_id)) {
      throw badRequest('target.swipe_id 必须是整数或 null', 'invalid_target')
    }
    target.swipe_id = raw.swipe_id
  }
  if (raw.revision !== undefined) {
    if (raw.revision !== null && typeof raw.revision !== 'string') {
      throw badRequest('target.revision 必须是字符串或 null', 'invalid_target')
    }
    target.revision = raw.revision
  }
  return Object.keys(target).length > 0 ? target : undefined
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Extract the standard sampling fields that the plugin forwards. */
export function paramsFromBody(body) {
  const params = {}
  const temperature = finite(body.temperature)
  if (temperature !== undefined) params.temperature = temperature
  const topP = finite(body.top_p ?? body.topP)
  if (topP !== undefined) params.topP = topP
  const presence = finite(body.presence_penalty ?? body.presencePenalty)
  if (presence !== undefined) params.presencePenalty = presence
  const frequency = finite(body.frequency_penalty ?? body.frequencyPenalty)
  if (frequency !== undefined) params.frequencyPenalty = frequency
  const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.maxTokens
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0) params.maxTokens = maxTokens
  const reasoning = body.reasoning_effort ?? body.reasoningEffort
  if (typeof reasoning === 'string' && reasoning.trim() !== '') params.reasoningEffort = reasoning.trim()
  if (Array.isArray(body.stop) && body.stop.every(item => typeof item === 'string') && body.stop.length > 0) {
    params.stop = body.stop
  }
  if (Number.isSafeInteger(body.seed)) params.seed = body.seed
  return params
}

/**
 * Merge per-request sampling parameters into the Agent request config.
 * reasoningEffort is passed only when the resolved model advertises that exact
 * level; otherwise DSH rejects the whole turn with UNSUPPORTED_REASONING_EFFORT.
 */
export function applyRuntimeParams(resolved, params, { reasoningEfforts } = {}) {
  if (!params || typeof params !== 'object') return resolved
  const next = { ...resolved }
  if (Number.isFinite(params.temperature)) next.temperature = params.temperature
  if (Number.isFinite(params.topP)) next.top_p = params.topP
  if (Number.isFinite(params.presencePenalty)) next.presence_penalty = params.presencePenalty
  if (Number.isFinite(params.frequencyPenalty)) next.frequency_penalty = params.frequencyPenalty
  if (Number.isSafeInteger(params.seed)) next.seed = params.seed
  if (Array.isArray(params.stop) && params.stop.length > 0) next.stop = params.stop
  if (Number.isSafeInteger(params.maxTokens)) next.maxTokens = params.maxTokens
  if (
    typeof params.reasoningEffort === 'string'
    && params.reasoningEffort !== ''
    && Array.isArray(reasoningEfforts)
    && reasoningEfforts.includes(params.reasoningEffort)
  ) {
    next.reasoningEffort = params.reasoningEffort
  }
  return next
}

export function isSessionNotFound(error) {
  const text = error instanceof Error ? error.message : String(error)
  return /session[^\n]*not found|no such session|unknown session|SESSION_QUERY_SESSION_NOT_FOUND|SessionPersistenceNotFound|会话[^\n]*(?:不存在|未找到)/i.test(text)
}
