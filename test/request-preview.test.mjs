import assert from 'node:assert/strict'
import test from 'node:test'
import { request } from 'node:http'
import { createBridgeServer } from '../lib/server.js'
import { RequestReceipts } from '../lib/request-receipts.js'
import { messagesDigest, adaptBody, installAdapter, sendingPreview, PreviewCopies } from '../tavern-extension/core.js'

const base = 'http://127.0.0.1:43121/v1'
const session = { protocol_version: 1, client_id: 'shujuku', task_id: 'database', chat_id: 'private-chat', request_id: 'one', action: 'generate', fixed_message_count: 0, fixed_message_types: [] }
const original = { messages: [{ role: 'user', content: 'TARGET<bbi_image>OLD_LAYOUT</bbi_image>END' }], dsh_session: session }

test('outgoing digest agrees with bridge normalization; each attempt has a unique trace without changing request identity', async () => {
  const args = { url: base + '/chat/completions', pageOrigin: 'http://localhost:8000', body: original, base }
  const a = await adaptBody(args), b = await adaptBody(args)
  assert.notEqual(a.preview.trace_id, b.preview.trace_id)
  assert.equal(a.body.dsh_session, session)
  assert.equal(a.body.dsh_session.request_id, 'one')
  assert.equal(original.messages[0].content.includes('OLD_LAYOUT'), true)
  const ledger = new RequestReceipts()
  const record = ledger.begin(a.body)
  assert.equal(record.messages_match, true)
  assert.equal(record.dynamic_image_markers, 0)
  assert.equal(record.messages_digest, a.preview.messages_digest)
  const changed = ledger.begin({ ...a.body, messages: [{ role: 'user', content: 'proxy-modified' }] })
  assert.equal(changed.messages_match, false)
  const parts = [{ role: 'assistant', name: '姓名', content: ['one', { type: 'text', text: 'two' }] }]
  const digest = await messagesDigest(parts)
  assert.equal(ledger.begin({ messages: parts, dsh_context: { transport: { messages_digest: digest } } }).messages_match, true)
})

test('display copies contain before/after and exact change range, redact credentials including serialized body, never modify transport', async () => {
  const auth = 'Bearer PRIVATE_KEY_1234'
  const before = { ...original, api_key: 'ANOTHER_PRIVATE_KEY', custom_include_headers: JSON.stringify({ authorization: auth }), custom_include_body: JSON.stringify({ api_key: 'ANOTHER_PRIVATE_KEY' }) }
  const args = { url: base + '/chat/completions', pageOrigin: 'http://localhost:8000', body: before, base }
  const result = await adaptBody(args)
  const saved = structuredClone(result.body)
  const display = sendingPreview(before, result.body, before.messages, result.body.messages)
  const parsed = JSON.parse(display)
  assert.equal(display.includes('PRIVATE_KEY_1234'), false)
  assert.equal(display.includes('ANOTHER_PRIVATE_KEY'), false)
  assert.equal(display.includes('OLD_LAYOUT'), true) // Private prompt visible only in the explicit local display copy.
  assert.equal(parsed.after_messages[0].content, 'TARGETEND')
  assert.equal(parsed.changes[0].before_fragment, '<bbi_image>OLD_LAYOUT</bbi_image>')
  assert.equal(parsed.changes[0].after_fragment, '')
  assert.deepEqual(result.body, saved)
  const copies = new PreviewCopies(2, 100)
  copies.set('a', 'a'); copies.set('b', 'b'); copies.set('c', 'c')
  assert.equal(copies.get('a'), undefined)
  copies.set('huge', 'x'.repeat(101))
  assert.match(copies.get('huge'), /未保留全文/)
  copies.clear()
  assert.equal(copies.copies.size, 0)
})

test('same-scope concurrent fetch responses correlate by attempt, not scope, and preserve original responses', async () => {
  const waiting = [], sent = [], previews = [], results = []
  const host = { location: { origin: 'http://localhost:8000', href: 'http://localhost:8000/' }, fetch: async (_url, init) => {
    sent.push(JSON.parse(init.body)); return new Promise(resolve => waiting.push(resolve))
  } }
  const dispose = installAdapter(host, { enabled: () => true, base: () => base, selections: () => ({}), entries: () => [], onPreview: p => previews.push(p), onResult: (...args) => results.push(args) })
  const first = host.fetch(base + '/chat/completions', { method: 'POST', body: JSON.stringify(original) })
  const second = host.fetch(base + '/chat/completions', { method: 'POST', body: JSON.stringify(original) })
  while (waiting.length < 2) await new Promise(resolve => setTimeout(resolve, 1))
  waiting[1](new Response(JSON.stringify({ bridge: { receipt: { trace_id: previews[1].trace_id } }, dsh_session: { request_id: 'one' } })))
  const response2 = await second
  waiting[0](new Response(JSON.stringify({ bridge: { receipt: { trace_id: previews[0].trace_id } } })))
  await first
  while (results.length < 2) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(results[0][0], previews[1].trace_id)
  assert.equal(results[1][0], previews[0].trace_id)
  assert.equal(response2.bodyUsed, false)
  assert.equal((await response2.json()).dsh_session.request_id, 'one')
  assert.equal(sent[0].messages[0].content, 'TARGETEND')
  dispose()
})

test('receipt ledger is bounded, copies are isolated and contains no prompt, answers, keys or headers', () => {
  const ledger = new RequestReceipts(2)
  ledger.begin({ ...original, api_key: 'PRIVATE_KEY', headers: { authorization: 'PRIVATE_AUTH' } })
  ledger.begin({ ...original, request_id: 'two' }); ledger.begin({ ...original, request_id: 'three' })
  assert.equal(ledger.list().length, 2)
  const encoded = JSON.stringify(ledger.list())
  for (const word of ['OLD_LAYOUT', 'TARGET', 'PRIVATE_KEY', 'PRIVATE_AUTH']) assert.equal(encoded.includes(word), false)
  const list = ledger.list(); list[0].status = 'altered'
  assert.equal(ledger.list()[0].status, 'received')
  assert.equal(ledger.list({ chat_id: 'absent' }).length, 0)
})

test('HTTP receipts confirm current attempt even on cached results; expose unmarked/rejected requests without a model call', async t => {
  let calls = 0
  const engine = { handleDshSession: async () => ({ action: 'generate', sessionId: 'mock-session', answer: 'ANSWER_NOT_IN_LEDGER', idempotent: ++calls > 1 }) }
  const bridge = createBridgeServer({ engine, config: { host: '127.0.0.1', port: 0, authToken: 'test-secret', maxBodyBytes: 1_000_000 }, log: () => {} })
  const port = await bridge.listen()
  t.after(() => bridge.close())
  const endpoint = `http://127.0.0.1:${port}/v1`
  const headers = { authorization: 'Bearer test-secret', 'content-type': 'application/json' }
  // Ephemeral fixture ports can be on fetch's browser forbidden-port list on Windows.
  const http = (url, options = {}) => new Promise((resolve, reject) => {
    const req = request(url, { method: options.method || 'GET', headers: options.headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }))
    })
    req.on('error', reject); req.end(options.body)
  })
  const send = async body => {
    const response = await http(endpoint + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const a = await adaptBody({ url: base + '/chat/completions', pageOrigin: 'http://localhost:8000', body: original, base })
  const first = await send(a.body)
  assert.equal(first.status, 200)
  assert.equal(first.body.bridge.receipt.messages_match, true)
  const b = await adaptBody({ url: base + '/chat/completions', pageOrigin: 'http://localhost:8000', body: original, base })
  const second = await send(b.body)
  assert.equal(second.body.bridge.idempotent, true)
  assert.equal(second.body.bridge.receipt.trace_id, b.preview.trace_id)
  assert.notEqual(second.body.bridge.receipt.receipt_id, first.body.bridge.receipt.receipt_id)
  const rejected = await send({ messages: original.messages })
  assert.equal(rejected.status, 400)
  assert.equal(rejected.body.bridge.receipt.adapter_state, 'absent')
  assert.equal(rejected.body.bridge.receipt.error_code, 'persistent_protocol_required')
  assert.equal(calls, 2)
  const listing = await http(endpoint + '/bridge/context/receipts', { headers })
  const ledger = await listing.json()
  assert.equal(ledger.receipts.length, 3)
  assert.equal(calls, 2)
  assert.equal(JSON.stringify(ledger).includes('OLD_LAYOUT'), false)
  assert.equal(JSON.stringify(ledger).includes('ANSWER_NOT_IN_LEDGER'), false)
  const filtered = await (await http(endpoint + '/bridge/context/receipts?trace_id=' + a.preview.trace_id, { headers })).json()
  assert.equal(filtered.receipts.length, 1)
  assert.equal((await http(endpoint + '/bridge/context/receipts')).status, 401)
})
