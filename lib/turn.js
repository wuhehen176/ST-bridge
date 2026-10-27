/**
 * Pure helpers for reading one DSH turn out of a session event log.
 * These functions never call the model and never mutate the log.
 */

function isTextBlock(block) {
  return block && block.type === 'text' && typeof block.text === 'string'
}

function isToolCallBlock(block) {
  return block && (block.type === 'tool-call' || block.type === 'tool_call' || block.type === 'tool-use')
}

function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks.filter(isTextBlock).map(block => block.text).join('\n')
}

function messageHasToolCall(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks.some(isToolCallBlock)
}

/**
 * Pick the final assistant text of one turn.
 *
 * Only the last assistant message is considered. A message that carries a
 * tool call is an intermediate step, not the final answer; when the turn ends
 * on such a message the bridge reports an empty final answer instead of
 * leaking tool narration into the frontend.
 */
export function finalAssistantText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const last = messages[messages.length - 1]
  if (messageHasToolCall(last)) return ''
  return messageText(last)
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pick(object, keys) {
  for (const key of keys) {
    const value = finiteNumber(object?.[key])
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Normalize one or more adapter usage objects.
 *
 * Accepts both snake_case (OpenAI wire) and camelCase (DSH adapter) shapes.
 * Absent fields stay absent; the bridge never invents a zero.
 */
export function normalizeUsage(usages) {
  let promptTokens
  let completionTokens
  let totalTokens
  let cacheHitTokens
  let cachedTokens

  for (const usage of Array.isArray(usages) ? usages : []) {
    if (!usage || typeof usage !== 'object') continue
    const prompt = pick(usage, ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens'])
    const completion = pick(usage, ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens'])
    const total = pick(usage, ['total_tokens', 'totalTokens'])
    const cacheHit = pick(usage, ['prompt_cache_hit_tokens', 'promptCacheHitTokens'])
    const cached = finiteNumber(usage?.prompt_tokens_details?.cached_tokens)
      ?? finiteNumber(usage?.promptTokensDetails?.cachedTokens)
      ?? pick(usage, ['cachedInputTokens', 'cache_read_input_tokens'])

    if (prompt !== undefined) promptTokens = (promptTokens ?? 0) + prompt
    if (completion !== undefined) completionTokens = (completionTokens ?? 0) + completion
    if (total !== undefined) totalTokens = (totalTokens ?? 0) + total
    if (cacheHit !== undefined) cacheHitTokens = (cacheHitTokens ?? 0) + cacheHit
    if (cached !== undefined) cachedTokens = (cachedTokens ?? 0) + cached
  }

  const result = {}
  if (promptTokens !== undefined) result.prompt_tokens = promptTokens
  if (completionTokens !== undefined) result.completion_tokens = completionTokens
  if (totalTokens !== undefined) result.total_tokens = totalTokens
  if (cacheHitTokens !== undefined) result.prompt_cache_hit_tokens = cacheHitTokens
  if (cachedTokens !== undefined) result.prompt_tokens_details = { cached_tokens: cachedTokens }
  return Object.keys(result).length > 0 ? result : undefined
}

function reasonMessage(reason) {
  if (!reason) return undefined
  if (typeof reason === 'string') return reason
  if (typeof reason.message === 'string' && reason.message !== '') return reason.message
  const error = reason.error ?? reason.failure ?? reason.cause
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message !== '') return error.message
    if (typeof error.code === 'string') return error.code
  }
  if (typeof reason.kind === 'string') return reason.kind
  try {
    return JSON.stringify(reason)
  } catch {
    return undefined
  }
}

function describeTurnEnd(reason) {
  const kind = reason?.kind ?? 'unknown'
  const message = reasonMessage(reason)
  if (kind === 'completed') {
    return { ok: true, finishReason: 'stop', turnEndKind: kind, message }
  }
  if (kind === 'max-tokens' || kind === 'max_tokens') {
    return { ok: true, finishReason: 'length', turnEndKind: kind, message }
  }
  if (kind === 'aborted' || kind === 'interrupted') {
    return { ok: false, code: 'agent_turn_aborted', turnEndKind: kind, message: message ?? 'Agent 回合已中止' }
  }
  if (kind === 'error') {
    return { ok: false, code: 'agent_turn_error', turnEndKind: kind, message: message ?? 'Agent 回合失败' }
  }
  return { ok: false, code: 'agent_turn_incomplete', turnEndKind: kind, message: message ?? `Agent 回合以 ${kind} 结束` }
}

/**
 * Find the turn that consumed `requestId` and fold its assistant messages.
 *
 * The match is exact: the user message id or its source.rpcId must equal the
 * bridge's request id. The function returns undefined until the matching turn
 * has ended.
 */
export function recoverTurn(events, requestId) {
  if (!Array.isArray(events) || events.length === 0) return undefined
  let currentTurn
  let targetTurn
  let matched = false
  const assistantMessages = []
  const usages = []

  for (const event of events) {
    const data = event?.data
    if (event?.type === 'turn/start') {
      if (matched && data?.turn !== targetTurn) return undefined
      currentTurn = data?.turn
      continue
    }
    if (!matched && event?.type === 'user/message') {
      const id = data?.id ?? data?.message?.id
      const rpcId = data?.source?.rpcId ?? data?.message?.source?.rpcId
      if (id === requestId || rpcId === requestId) {
        if (!Number.isSafeInteger(currentTurn)) continue
        matched = true
        targetTurn = currentTurn
      }
      continue
    }
    if (!matched) continue
    if (event?.type === 'assistant/message' && data?.turn === targetTurn && data?.interrupted !== true) {
      const message = data?.message ?? data
      assistantMessages.push(message)
      if (data?.usage) usages.push(data.usage)
      continue
    }
    if (event?.type === 'turn/end' && data?.turn === targetTurn) {
      const end = describeTurnEnd(data?.reason)
      const answer = finalAssistantText(assistantMessages)
      return {
        turn: targetTurn,
        answer,
        usage: normalizeUsage(usages),
        ...end,
      }
    }
  }
  return undefined
}
