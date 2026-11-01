import assert from 'node:assert/strict'
import test from 'node:test'
import { installAdapter } from '../tavern-extension/core.js'

const base = 'http://127.0.0.1:43121/v1'
const origin = 'http://localhost:8000'

for (const action of ['sync_rules', 'reset']) {
  for (const kind of ['direct', 'request-object', 'custom-proxy', 'openai-proxy', 'client-endpoint']) {
    test(`paired ${action} credentials reach ${kind} without modifying control content or scope`, async t => {
      const session = { protocol_version: 1, client_id: 'shujuku', chat_id: 'exact-original-chat', session_id: 'existing-session', request_id: 'original-request', action, fixed_message_count: action === 'reset' ? 0 : 1, fixed_message_types: action === 'reset' ? [] : ['spec'] }
      const messages = action === 'reset' ? [] : [{ role: 'system', content: 'KEEP<bbi_image>SPEC_LITERAL</bbi_image>UNCHANGED' }]
      const include = JSON.stringify({ dsh_session: session, temperature: 0.5 })
      const proxy = kind.endsWith('proxy')
      const body = proxy ? {
        chat_completion_source: kind === 'custom-proxy' ? 'custom' : 'openai',
        ...(kind === 'custom-proxy' ? { custom_url: base } : { reverse_proxy: base }),
        proxy_password: 'stale-channel-key', custom_include_body: include,
        custom_include_headers: JSON.stringify({ authorization: 'Bearer stale', 'X-Keep': 'yes' }), messages,
      } : { dsh_session: session, messages }
      const before = JSON.stringify(body)
      const sent = []
      const host = { location: { href: origin + '/', origin }, fetch: async (input, init) => {
        sent.push({ input, init }); return new Response('{}')
      } }
      const forbidden = () => { throw new Error('Control must not invoke generation filtering/routing') }
      const dispose = installAdapter(host, {
        enabled: () => true, base: () => base, deviceToken: () => 'paired-device-token',
        autoInject: () => ({ enabled: true, overrideChatId: true, clients: ['shujuku'], prefix: 'changed-' }), chatId: () => 'different-chat',
        entries: () => [], selections: () => ({}), materials: forbidden, resolveEndpoint: forbidden, onPreview: forbidden,
      })
      t.after(dispose)
      const url = proxy ? origin + '/api/backends/chat-completions/generate'
        : kind === 'client-endpoint' ? base.replace('/v1', '/clients/shujuku/v1') + '/chat/completions' : base + '/chat/completions'
      const init = { method: 'POST', headers: { authorization: 'Bearer wrong', 'X-Original': 'keep' }, body: before }
      if (kind === 'request-object') await host.fetch(new Request(url, init))
      else await host.fetch(url, init)
      assert.equal(sent.length, 1)
      const actual = JSON.parse(sent[0].init.body)
      if (proxy) {
        assert.equal(actual.chat_completion_source, 'custom')
        assert.equal(actual.custom_url, base)
        assert.equal(actual.custom_include_body, include)
        assert.deepEqual(JSON.parse(actual.custom_include_headers), { 'X-Keep': 'yes', Authorization: 'Bearer paired-device-token' })
      } else {
        assert.deepEqual(actual, body)
        const headers = new Headers(sent[0].init.headers)
        assert.equal(headers.get('authorization'), 'Bearer paired-device-token')
        assert.equal(headers.get('x-original'), 'keep')
      }
      assert.deepEqual(actual.messages, messages)
      assert.equal(actual.dsh_context, undefined)
      assert.equal(JSON.stringify(body), before)
    })
  }
}

test('controls without pairing and unrelated destinations remain byte-for-byte unchanged', async t => {
  const sent = []
  let token = ''
  const host = { location: { href: origin + '/', origin }, fetch: async (...args) => { sent.push(args); return new Response('{}') } }
  const dispose = installAdapter(host, { enabled: () => true, base: () => base, deviceToken: () => token, entries: () => [], selections: () => ({}) })
  t.after(dispose)
  const init = { method: 'POST', headers: { authorization: 'Bearer caller-token' }, body: JSON.stringify({ dsh_session: { protocol_version: 1, chat_id: 'chat', action: 'sync_rules' }, messages: [] }) }
  await host.fetch(base + '/chat/completions', init)
  assert.equal(sent[0][1], init)
  token = 'paired-secret'
  await host.fetch('https://external.example/v1/chat/completions', init)
  assert.equal(sent[1][1], init)
  assert.equal(JSON.stringify(sent[1]).includes('paired-secret'), false)
})
