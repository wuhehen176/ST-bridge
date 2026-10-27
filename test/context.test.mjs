import assert from 'node:assert/strict'
import test from 'node:test'
import {
  baseMessagesFor,
  buildKnownMessages,
  classifyContext,
  composeAppendPrompt,
  composeInitialPrompt,
  normalizeMessages,
  withAssistant,
} from '../lib/context.js'

const system = { role: 'system', content: 'SPEC-A' }
const system2 = { role: 'system', content: 'SPEC-B' }
const user1 = { role: 'user', content: 'Hello' }
const assistant1 = { role: 'assistant', content: 'Hi there' }

function norm(items) {
  return normalizeMessages(items).messages
}

test('normalizeMessages preserves order, multiple system messages, and exact text', () => {
  const { messages } = normalizeMessages([system, system2, user1, assistant1])
  assert.deepEqual(messages.map(message => message.role), ['system', 'system', 'user', 'assistant'])
  assert.equal(messages[0].text, 'SPEC-A')
  assert.equal(messages[1].text, 'SPEC-B')
  assert.equal(messages[2].text, 'Hello')
  assert.equal(messages[3].text, 'Hi there')
})

test('normalizeMessages flattens text parts without dropping content', () => {
  const { messages } = normalizeMessages([
    { role: 'user', content: [{ type: 'text', text: 'foo' }, { type: 'text', text: 'bar' }] },
  ])
  assert.equal(messages[0].text, 'foo\nbar')
})

test('normalizeMessages rejects non-text parts instead of silently dropping them', () => {
  assert.throws(() => normalizeMessages([
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
  ]), /只支持文本/)
})

test('classifyContext starts a new session', () => {
  const result = classifyContext([], norm([system, user1]))
  assert.equal(result.kind, 'initial')
})

test('classifyContext appends a new full-history suffix', () => {
  const known = norm([system, user1, assistant1])
  const incoming = norm([system, user1, assistant1, { role: 'user', content: 'Next' }])
  const result = classifyContext(known, incoming)
  assert.equal(result.kind, 'append')
  assert.equal(result.delta, false)
  assert.deepEqual(result.newMessages.map(message => message.text), ['Next'])
})

test('classifyContext treats a system-less new turn as delta append', () => {
  const known = norm([system, user1, assistant1])
  const incoming = norm([{ role: 'user', content: 'Next' }])
  const result = classifyContext(known, incoming)
  assert.equal(result.kind, 'append')
  assert.equal(result.delta, true)
  assert.deepEqual(result.newMessages.map(message => message.text), ['Next'])
})

test('classifyContext branches when an old floor is rewritten', () => {
  const known = norm([system, user1, assistant1])
  const incoming = norm([system, { role: 'user', content: 'Rewritten' }])
  const result = classifyContext(known, incoming)
  assert.equal(result.kind, 'branch')
  assert.equal(result.reason, 'divergence')
})

test('classifyContext branches when the transcript is rolled back', () => {
  const known = norm([system, user1, assistant1])
  const incoming = norm([system, user1])
  const result = classifyContext(known, incoming)
  assert.equal(result.kind, 'branch')
  assert.equal(result.reason, 'rollback_or_truncation')
})

test('classifyContext treats same context as regenerate', () => {
  const known = norm([system, user1, assistant1])
  const incoming = norm([system, user1, assistant1])
  const result = classifyContext(known, incoming)
  assert.equal(result.kind, 'regenerate')
})

test('classifyContext can be forced to delta or branch', () => {
  const known = norm([system, user1, assistant1])
  const incoming = norm([{ role: 'user', content: 'Next' }])
  assert.equal(classifyContext(known, incoming, 'delta').kind, 'append')
  assert.equal(classifyContext(known, incoming, 'branch').kind, 'branch')
})

test('composeInitialPrompt keeps system text and separates the final user turn', () => {
  const messages = norm([system, system2, { role: 'user', content: 'Old' }, assistant1, { role: 'user', content: 'New target' }])
  const prompt = composeInitialPrompt(messages)
  assert.match(prompt, /SPEC-A/)
  assert.match(prompt, /SPEC-B/)
  assert.match(prompt, /Old/)
  assert.match(prompt, /Hi there/)
  assert.match(prompt, /<st_bridge_current_request>\nNew target/)
  assert.doesNotMatch(prompt, /<st_bridge_current_request>\nOld/)
})

test('composeAppendPrompt sends a single user turn verbatim', () => {
  const messages = norm([{ role: 'user', content: '  exactly this  ' }])
  assert.equal(composeAppendPrompt(messages), '  exactly this  ')
})

test('buildKnownMessages appends the assistant answer to delta context', () => {
  const known = norm([system, user1, assistant1])
  const incoming = norm([{ role: 'user', content: 'Next' }])
  const classification = classifyContext(known, incoming)
  const base = baseMessagesFor({ classification, previousKnown: known, incoming })
  assert.equal(base.length, 4)
  const next = buildKnownMessages({ classification, previousKnown: known, incoming, answer: 'Answer' })
  assert.equal(next.at(-1).role, 'assistant')
  assert.equal(next.at(-1).text, 'Answer')
  assert.equal(withAssistant(base, 'Answer').length, 5)
})

test('composeAppendPrompt nonce format is short and collision-resistant', () => {
  const messages = [
    { role: 'assistant', text: 'A_TEXT' },
    { role: 'user', text: 'B_TEXT' },
  ]
  const out = composeAppendPrompt(messages, { format: 'nonce', nonce: 'ABCDEF12' })
  assert.match(out, /<<<STB-ABCDEF12>>>/)
  assert.equal(out.includes('ST_BRIDGE_MESSAGE'), false)
  assert.equal(out.includes('st_bridge_append'), false)
  assert.match(out, /角色顺序：assistant、user/)
  assert.ok(out.length < composeAppendPrompt(messages, { format: 'tagged' }).length)
})
