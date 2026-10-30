import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import test from 'node:test'
import { installAdapter, messagesDigest, sourceParts } from '../tavern-extension/core.js'
import { RequestReceipts } from '../lib/request-receipts.js'

const base = 'http://192.168.31.60:43121/v1'
const origin = 'http://192.168.31.109:48130'
const session = { protocol_version: 1, client_id: 'shujuku', task_id: 'database', chat_id: 'http-test', request_id: 'same-request', action: 'generate', fixed_message_count: 0, fixed_message_types: [] }
const sha = text => createHash('sha256').update(text).digest('hex')
function useCrypto(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'crypto', original); else delete globalThis.crypto })
}

test('HTTP SHA-256 matches Node for padding boundaries, Unicode, surrogate and large input', async t => {
  useCrypto(t, {})
  for (const text of ['', 'abc', '\0中文😀\ud800', ...[55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1_000_000].map(n => 'a'.repeat(n))]) {
    const expected = sha(JSON.stringify([sha(`user\0\0${text}`)]))
    assert.equal(await messagesDigest([{ role: 'user', content: text }]), expected)
  }
  assert.equal(await messagesDigest([]), sha('[]'))
})

for (const mode of ['no-subtle-or-uuid', 'no-crypto', 'getRandomValues-only', 'native']) {
  test(`HTTP adapter sends direct and Tavern-proxied requests with verified receipts: ${mode}`, async t => {
    let nativeCalls = 0
    const crypto = mode === 'native' ? { subtle: webcrypto.subtle, randomUUID: () => `native-${++nativeCalls}` }
      : mode === 'getRandomValues-only' ? { getRandomValues: bytes => webcrypto.getRandomValues(bytes) }
      : mode === 'no-crypto' ? undefined : {}
    useCrypto(t, crypto)
    const messages = [{ role: 'system', name: '世界书', content: '前文\n角色条目\n后文' }, { role: 'user', content: '继续<bbi_image>OLD_JSON</bbi_image>。' }]
    const original = { messages, dsh_session: session }
    const entries = [{ content: '角色条目', uid: 7, world: 'test-book', comment: '角色' }]
    const sources = await sourceParts(messages, entries)
    assert.equal(sources[0].message_hash, sha('system\0世界书\0前文\n角色条目\n后文'))
    const traces = new Set()
    for (const proxy of [false, true]) {
      const sent = []
      const host = { location: { href: origin + '/', origin }, fetch: async (url, init) => {
        sent.push(JSON.parse(init.body))
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      } }
      const dispose = installAdapter(host, { enabled: () => true, base: () => base, selections: () => ({}), entries: () => entries, onPreview() {} })
      t.after(dispose)
      const body = proxy ? { chat_completion_source: 'custom', custom_url: base, messages, custom_include_body: JSON.stringify({ dsh_session: session }) } : original
      const url = proxy ? origin + '/api/backends/chat-completions/generate' : base + '/chat/completions'
      for (let i = 0; i < 2; i++) {
        await host.fetch(url, { method: 'POST', body: JSON.stringify(body) })
        const outgoing = sent.at(-1)
        const wire = proxy ? { ...outgoing, ...JSON.parse(outgoing.custom_include_body) } : outgoing
        const receipt = new RequestReceipts().begin(wire)
        assert.equal(receipt.messages_match, true)
        assert.equal(wire.messages[1].content, '继续。')
        assert.equal(wire.dsh_session.request_id, session.request_id)
        assert.ok(receipt.trace_id)
        assert.equal(traces.has(receipt.trace_id), false)
        traces.add(receipt.trace_id)
      }
      assert.equal(sent.length, 2)
      dispose()
    }
    assert.equal(original.messages[1].content.includes('OLD_JSON'), true)
    if (mode === 'native') assert.equal(nativeCalls, 4)
  })
}
