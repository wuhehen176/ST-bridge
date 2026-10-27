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
  assert.deepEqual(result.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    prompt_cache_hit_tokens: 4,
    prompt_tokens_details: { cached_tokens: 3 },
  })
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
