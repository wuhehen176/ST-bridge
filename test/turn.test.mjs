import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeUsage, recoverTurn } from '../lib/turn.js'

function event(type, data) {
  return { type, data }
}

function turnLog({ requestId = 'req-1', answer = 'final', toolFirst = true, usage } = {}) {
  const events = [
    event('turn/start', { turn: 7 }),
    event('user/message', { id: requestId, source: { rpcId: requestId } }),
  ]
  if (toolFirst) {
    events.push(event('assistant/message', {
      turn: 7,
      message: {
        content: [
          { type: 'text', text: 'interim' },
          { type: 'tool-call', name: 'shell', arguments: '{}' },
        ],
      },
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }))
    events.push(event('assistant/message', {
      turn: 7,
      message: { content: [{ type: 'text', text: answer }] },
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    }))
  } else {
    events.push(event('assistant/message', {
      turn: 7,
      message: { content: [{ type: 'text', text: answer }] },
      ...(usage ? { usage } : {}),
    }))
  }
  events.push(event('turn/end', { turn: 7, reason: { kind: 'completed' } }))
  return events
}

test('recoverTurn returns only the final assistant message, not tool narration', () => {
  const result = recoverTurn(turnLog(), 'req-1')
  assert.equal(result.ok, true)
  assert.equal(result.answer, 'final')
  assert.equal(result.turn, 7)
})

test('recoverTurn sums usage across steps and preserves both cache shapes', () => {
  const result = recoverTurn(turnLog({
    toolFirst: false,
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_cache_hit_tokens: 4,
      prompt_tokens_details: { cached_tokens: 3 },
    },
  }), 'req-1')
  const { diagnostics, ...usage } = result.usage
  assert.deepEqual(usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    prompt_cache_hit_tokens: 4,
    prompt_tokens_details: { cached_tokens: 3 },
  })
  assert.equal(diagnostics.cacheReporting, 'reported')
  assert.equal(diagnostics.cacheCoverage, 'complete')
  assert.equal(diagnostics.modelCallCount, undefined)
})

test('diagnostics distinguish message IDs from call IDs', () => {
  const events = turnLog()
  for (const [index, item] of events.entries()) {
    if (item.type === 'assistant/message') {
      item.data.id = `event-${index}`
      item.data.message.id = `message-${index}`
    }
  }
  const result = recoverTurn(events, 'req-1')
  assert.equal(result.usage.prompt_tokens, 22)
  const d = result.usage.diagnostics
  assert.equal(d.usageEventCount, 2)
  assert.equal(d.maxUsageEventPromptTokens, 12)
  for (const key of ['modelCallCount', 'sumPromptTokens', 'maxPromptTokens', 'cacheHitTokens']) {
    assert.equal(Object.hasOwn(d, key), false)
  }
  assert.equal(d.cacheReporting, 'unavailable')
  assert.equal(d.cacheCoverage, 'none')
})

test('diagnostics report independent calls only when every explicit ID is unique', () => {
  const events = turnLog()
  const messages = events.filter(item => item.type === 'assistant/message')
  messages[0].data.callId = 'call-1'
  messages[1].data.callId = 'call-2'
  messages[0].data.usage.prompt_cache_hit_tokens = 0
  messages[1].data.usage.prompt_tokens_details = { cached_tokens: 4 }
  const d = recoverTurn(events, 'req-1').usage.diagnostics
  assert.equal(d.modelCallCount, 2)
  assert.equal(d.sumPromptTokens, 22)
  assert.equal(d.maxPromptTokens, 12)
  assert.equal(d.cacheHitTokens, 4)
  assert.equal(d.cacheCoverage, 'complete')
  assert.deepEqual(d.usageRecords.map(record => record.callId), ['call:call-1', 'call:call-2'])
})

test('repeated call IDs do not invent a deduplicated token total', () => {
  const events = turnLog()
  for (const item of events) {
    if (item.type === 'assistant/message') item.data.callId = 'same-call'
  }
  const result = recoverTurn(events, 'req-1')
  assert.equal(result.usage.prompt_tokens, 22)
  assert.equal(result.usage.diagnostics.modelCallCount, 1)
  assert.equal(Object.hasOwn(result.usage.diagnostics, 'sumPromptTokens'), false)
  assert.equal(Object.hasOwn(result.usage.diagnostics, 'maxPromptTokens'), false)
})

test('partial call IDs and cache reporting stay partial', () => {
  const events = turnLog()
  const first = events.find(item => item.type === 'assistant/message')
  first.data.callId = 'one-known-call'
  first.data.usage.prompt_cache_hit_tokens = 0
  const d = recoverTurn(events, 'req-1').usage.diagnostics
  assert.equal(Object.hasOwn(d, 'modelCallCount'), false)
  assert.equal(Object.hasOwn(d, 'cacheHitTokens'), false)
  assert.equal(d.cacheReporting, 'reported')
  assert.equal(d.cacheCoverage, 'partial')
})

test('missing prompt counts stay unknown even with independent call IDs', () => {
  const d = normalizeUsage([{ completion_tokens: 2 }], ['call-1']).diagnostics
  assert.equal(d.modelCallCount, 1)
  assert.equal(Object.hasOwn(d, 'sumPromptTokens'), false)
  assert.equal(Object.hasOwn(d, 'maxPromptTokens'), false)
})

test('diagnostic records exclude arbitrary usage metadata', () => {
  const d = normalizeUsage([{
    inputTokens: 8, cache_read_input_tokens: 0, metadata: 'PRIVATE',
  }], ['call-1']).diagnostics
  assert.equal(d.cacheHitTokens, 0)
  assert.equal(JSON.stringify(d).includes('PRIVATE'), false)
  assert.deepEqual(d.usageRecords[0].usage, {
    prompt_tokens: 8, prompt_tokens_details: { cached_tokens: 0 },
  })
})

test('DSH turn and step identify calls without using message IDs', () => {
  const events = turnLog()
  const messages = events.filter(item => item.type === 'assistant/message')
  messages[0].data.step = 1
  messages[1].data.step = 2
  let d = recoverTurn(events, 'req-1').usage.diagnostics
  assert.equal(d.modelCallCount, 2)
  assert.equal(d.sumPromptTokens, 22)
  assert.deepEqual(d.usageRecords.map(record => record.callId), ['step:7:1', 'step:7:2'])
  messages[1].data.step = 1
  d = recoverTurn(events, 'req-1').usage.diagnostics
  assert.equal(d.modelCallCount, 1)
  assert.equal(Object.hasOwn(d, 'sumPromptTokens'), false)
  messages[1].data.step = -1
  d = recoverTurn(events, 'req-1').usage.diagnostics
  assert.equal(Object.hasOwn(d, 'modelCallCount'), false)
})

test('native DSH input accounting includes cache when the total confirms it', () => {
  const native = { inputTokens: 673, outputTokens: 1185, totalTokens: 755394,
    cacheReadTokens: 753536, cacheWriteTokens: 0 }
  const events = turnLog({ toolFirst: false, usage: native })
  events.find(item => item.type === 'assistant/message').data.step = 1
  const u = recoverTurn(events, 'req-1').usage
  assert.equal(u.prompt_tokens, 754209)
  assert.equal(u.completion_tokens, 1185)
  assert.equal(u.total_tokens, 755394)
  assert.equal(u.prompt_tokens_details.cached_tokens, 753536)
  assert.equal(u.diagnostics.maxPromptTokens, 754209)
  assert.equal(u.diagnostics.cacheHitTokens, 753536)
  assert.deepEqual(u.diagnostics.usageRecords[0].adapterUsage, native)
  assert.equal(normalizeUsage([{ inputTokens: 10, cacheReadTokens: 20,
    cacheWriteTokens: 5, outputTokens: 2, totalTokens: 37 }]).prompt_tokens, 35)
})

test('inclusive adapter input and explicit OpenAI input do not double count cache', () => {
  assert.equal(normalizeUsage([{ inputTokens: 100, cacheReadTokens: 80,
    outputTokens: 2, totalTokens: 102 }]).prompt_tokens, 100)
  assert.equal(normalizeUsage([{ prompt_tokens: 100, inputTokens: 20,
    cacheReadTokens: 80, outputTokens: 2, totalTokens: 102 }]).prompt_tokens, 100)
  assert.equal(normalizeUsage([{ inputTokens: 20, cacheReadTokens: 80 }]).prompt_tokens, 20)
  assert.equal(normalizeUsage([{ inputTokens: 20, cacheReadTokens: 80,
    outputTokens: 2, totalTokens: 999 }]).prompt_tokens, 20)
})

test('normalizeUsage omits absent fields instead of fabricating zero', () => {
  assert.equal(normalizeUsage([]), undefined)
  assert.equal(normalizeUsage([{}]), undefined)
  assert.deepEqual(normalizeUsage([{ promptTokens: 8 }]), { prompt_tokens: 8 })
  assert.deepEqual(normalizeUsage([{ completion_tokens: 2 }]), { completion_tokens: 2 })
})

test('recoverTurn reports a failed turn', () => {
  const events = turnLog()
  events[events.length - 1] = event('turn/end', {
    turn: 7,
    reason: { kind: 'error', error: { message: 'context length exceeded' } },
  })
  const result = recoverTurn(events, 'req-1')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'agent_turn_error')
  assert.match(result.message, /context length/)
})

test('recoverTurn returns undefined for a different request id', () => {
  assert.equal(recoverTurn(turnLog(), 'other'), undefined)
})

test('recoverTurn does not settle before turn/end', () => {
  const events = turnLog()
  events.pop()
  assert.equal(recoverTurn(events, 'req-1'), undefined)
})

function rejectedInboxTurn(id = 'req-blocked', kind = 'blocked') {
  return [
    event('agent/inbox/spliced', { target: 'next-turn', start: 0,
      inserted: [{ id, role: 'user', source: { kind: 'user', rpcId: id } }] }),
    event('turn/start', { turn: 25 }),
    event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    event('turn/end', { turn: 25, reason: { kind } }),
  ]
}

test('recoverTurn matches a rejected claimed inbox request without user/message', () => {
  const result = recoverTurn(rejectedInboxTurn(), 'req-blocked')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'agent_turn_blocked')
  assert.equal(result.turn, 25)
  assert.equal(result.turnEndKind, 'blocked')
  assert.match(result.message, /blocked/)
  assert.equal(result.usage, undefined)
})

test('inbox recovery does not attribute other or canceled requests', () => {
  assert.equal(recoverTurn(rejectedInboxTurn('other'), 'req-blocked'), undefined)
  const canceled = rejectedInboxTurn()
  canceled[2].data.outcome = 'canceled'
  assert.equal(recoverTurn(canceled, 'req-blocked'), undefined)
  const incomplete = rejectedInboxTurn()
  incomplete.pop()
  assert.equal(recoverTurn(incomplete, 'req-blocked'), undefined)
})

test('inbox recovery respects queue positions and exact rpc IDs', () => {
  const events = rejectedInboxTurn('other')
  events[0].data.inserted.push({ id: 'sanitized-id', source: { rpcId: 'req-blocked' } })
  events[2].data.start = 1
  assert.equal(recoverTurn(events, 'other'), undefined)
  assert.equal(recoverTurn(events, 'req-blocked').code, 'agent_turn_blocked')
})

test('ended turns do not claim later out-of-turn inbox removals', () => {
  const events = rejectedInboxTurn()
  events.splice(2, 1)
  events.push(event('agent/inbox/spliced', {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [],
  }))
  assert.equal(recoverTurn(events, 'req-blocked'), undefined)
})

test('finalAssistantText keeps visible text even when the message also has a tool call', () => {
  const events = [
    event('turn/start', { turn: 9 }),
    event('user/message', { id: 'req-9', source: { rpcId: 'req-9' } }),
    event('assistant/message', {
      turn: 9,
      message: {
        content: [
          { type: 'text', text: '本轮正文' },
          { type: 'tool-call', name: 'tableEdit', arguments: '{}' },
        ],
      },
    }),
    event('turn/end', { turn: 9, reason: { kind: 'completed' } }),
  ]
  const result = recoverTurn(events, 'req-9')
  assert.equal(result.ok, true)
  assert.equal(result.answer, '本轮正文')
})

test('finalAssistantText still returns empty when every assistant step is text-less', () => {
  const events = [
    event('turn/start', { turn: 10 }),
    event('user/message', { id: 'req-10', source: { rpcId: 'req-10' } }),
    event('assistant/message', {
      turn: 10,
      message: { content: [{ type: 'tool-call', name: 'tableEdit', arguments: '{}' }] },
    }),
    event('turn/end', { turn: 10, reason: { kind: 'completed' } }),
  ]
  const result = recoverTurn(events, 'req-10')
  assert.equal(result.ok, true)
  assert.equal(result.answer, '')
})
