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
 * Walk backwards and return the last non-empty text block. A message that also
 * carries a tool call is still allowed to contribute text: some clients emit
 * the visible answer and an auxiliary tool call in the same message. Only an
 * entirely text-less turn is treated as an empty final answer.
 */
export function finalAssistantText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index])
    if (text.trim() !== '') return text
  }
  return ''
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

function inclusivePromptTokens(usage) {
  const prompt = pick(usage, ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens'])
  const nativeInput = finiteNumber(usage?.inputTokens)
  const read = finiteNumber(usage?.cacheReadTokens)
  const write = finiteNumber(usage?.cacheWriteTokens)
  const output = pick(usage, ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens'])
  const total = pick(usage, ['total_tokens', 'totalTokens'])
  // DSH may report uncached input separately. Convert only when the accounting
  // equation confirms it; an explicit OpenAI prompt count already includes cache.
  if (pick(usage, ['prompt_tokens', 'promptTokens', 'input_tokens']) === undefined
    && nativeInput !== undefined && (read !== undefined || write !== undefined)
    && output !== undefined && total !== undefined
    && total === nativeInput + (read ?? 0) + (write ?? 0) + output) {
    return nativeInput + (read ?? 0) + (write ?? 0)
  }
  return prompt
}

/**
 * Normalize one or more adapter usage objects.
 *
 * Accepts both snake_case (OpenAI wire) and camelCase (DSH adapter) shapes.
 * Absent fields stay absent; the bridge never invents a zero.
 */
export function normalizeUsage(usages, callKeys) {
  let promptTokens
  let completionTokens
  let totalTokens
  let cacheHitTokens
  let cachedTokens

  for (const usage of Array.isArray(usages) ? usages : []) {
    if (!usage || typeof usage !== 'object') continue
    const prompt = inclusivePromptTokens(usage)
    const completion = pick(usage, ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens'])
    const total = pick(usage, ['total_tokens', 'totalTokens'])
    const cacheHit = pick(usage, ['prompt_cache_hit_tokens', 'promptCacheHitTokens'])
    const cached = finiteNumber(usage?.prompt_tokens_details?.cached_tokens)
      ?? finiteNumber(usage?.promptTokensDetails?.cachedTokens)
      ?? pick(usage, ['cachedInputTokens', 'cache_read_input_tokens', 'cacheReadTokens'])

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
  if (Array.isArray(callKeys) && Object.keys(result).length > 0) {
    result.diagnostics = usageDiagnostics(usages, callKeys)
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function usageDiagnostics(usages, callKeys) {
  // A message ID is not a model-call ID. Keep event measurements separate
  // from per-call totals; repeated call IDs have ambiguous snapshot semantics.
  const records = usages.map((usage, index) => {
    const callId = typeof callKeys[index] === 'string' && callKeys[index].trim() !== ''
      ? callKeys[index] : undefined
    const adapterUsage = Object.fromEntries(
      ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens']
        .filter(key => finiteNumber(usage?.[key]) !== undefined)
        .map(key => [key, usage[key]]),
    )
    return {
      ...(callId ? { callId } : {}), usage: normalizeUsage([usage]) ?? {},
      ...(Object.keys(adapterUsage).length ? { adapterUsage } : {}),
    }
  })
  const knownIds = records.map(record => record.callId).filter(Boolean)
  const allIdsKnown = knownIds.length === records.length
  const distinctIds = new Set(knownIds)
  const independent = allIdsKnown && distinctIds.size === records.length
  const prompts = records.map(record => record.usage.prompt_tokens)
  const allPromptsKnown = prompts.every(value => value !== undefined)
  const knownPrompts = prompts.filter(value => value !== undefined)
  const hits = records.map(record => record.usage.prompt_cache_hit_tokens
    ?? record.usage.prompt_tokens_details?.cached_tokens)
  const cacheEvents = hits.filter(value => value !== undefined).length
  return {
    usageEventCount: records.length,
    ...(allIdsKnown ? { modelCallCount: distinctIds.size } : {}),
    ...(independent && allPromptsKnown ? {
      sumPromptTokens: prompts.reduce((sum, value) => sum + value, 0),
      maxPromptTokens: Math.max(...prompts),
    } : {}),
    ...(knownPrompts.length ? { maxUsageEventPromptTokens: Math.max(...knownPrompts) } : {}),
    ...(independent && cacheEvents === records.length ? {
      cacheHitTokens: hits.reduce((sum, value) => sum + value, 0),
    } : {}),
    cacheReporting: cacheEvents ? 'reported' : 'unavailable',
    cacheCoverage: cacheEvents === records.length ? 'complete' : cacheEvents ? 'partial' : 'none',
    usageRecords: records,
  }
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
  if (kind === 'blocked') {
    return {
      ok: false, code: 'agent_turn_blocked', turnEndKind: kind,
      message: message && message !== 'blocked' ? message
        : 'DSH 在执行前阻止了本轮任务（blocked）；请检查会话归档状态或前置策略',
    }
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
  const callKeys = []
  const inbox = { 'next-turn': [], 'next-step': [] }
  const matches = item => {
    const message = item?.message ?? item
    return message?.id === requestId || message?.source?.rpcId === requestId
  }

  for (const event of events) {
    const data = event?.data
    if (event?.type === 'turn/start') {
      if (matched && data?.turn !== targetTurn) return undefined
      currentTurn = data?.turn
      continue
    }
    if (event?.type === 'agent/inbox/spliced') {
      const queue = inbox[data?.target]
      const start = data?.start
      const count = data?.removedCount ?? 0
      if (Array.isArray(queue) && Number.isSafeInteger(start) && start >= 0 && start <= queue.length
        && Number.isSafeInteger(count) && count >= 0 && count <= queue.length - start
        && Array.isArray(data?.inserted)) {
        const claimed = queue.splice(start, count, ...data.inserted)
        // Rejected pre-step turns never persist user/message. Match their
        // consumed inbox item instead; canceled or unclaimed items are not work.
        if (!matched && data.outcome !== 'canceled' && Number.isSafeInteger(currentTurn)
          && claimed.some(matches)) {
          matched = true
          targetTurn = currentTurn
        }
      }
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
    if (!matched) {
      if (event?.type === 'turn/end' && data?.turn === currentTurn) currentTurn = undefined
      continue
    }
    if (event?.type === 'assistant/message' && data?.turn === targetTurn && data?.interrupted !== true) {
      const message = data?.message ?? data
      assistantMessages.push(message)
      if (data?.usage && typeof data.usage === 'object' && !Array.isArray(data.usage)) {
        usages.push(data.usage)
        callKeys.push(typeof data.callId === 'string' && data.callId.trim() !== ''
          ? `call:${data.callId}`
          : Number.isSafeInteger(data.turn) && data.turn >= 1
            && Number.isSafeInteger(data.step) && data.step >= 1
            ? `step:${data.turn}:${data.step}` : undefined)
      }
      continue
    }
    if (event?.type === 'turn/end' && data?.turn === targetTurn) {
      const end = describeTurnEnd(data?.reason)
      const answer = finalAssistantText(assistantMessages)
      return {
        turn: targetTurn,
        answer,
        usage: normalizeUsage(usages, callKeys),
        ...end,
      }
    }
  }
  return undefined
}
