import assert from 'node:assert/strict'
import test from 'node:test'
import { clientEndpoints, clientEndpointPath, endpointSession } from '../lib/client-endpoints.js'
import { createBridgeServer } from '../lib/server.js'
import { normalizeConfig } from '../index.js'
import { sanitizeSettings } from '../lib/panel.js'
import { adaptBody, installAdapter, localBase } from '../tavern-extension/core.js'

const base = 'http://192.168.3.47:43121/v1'
const origin = 'http://tauri.localhost'
const proxy = `${origin}/api/backends/chat-completions/generate`
const routes = clientEndpoints()
const resolveEndpoint = async id => routes.find(entry => entry.id === id)
const options = { url: proxy, pageOrigin: origin, base, autoInject: { enabled: true, clientId: 'legacy', prefix: 'stb-' }, chatId: 'chat-one', deviceToken: 'device-test', resolveEndpoint }
const messages = [{ role: 'user', content: 'Synthetic test only.' }]
const yuzi = { chat_completion_source: 'openai', reverse_proxy: 'http://192.168.3.47:43121/clients/yuzi-phone/v1', proxy_password: 'old-test-key', model: 'dsh-default', messages }
const database = { chat_completion_source: 'custom', custom_url: 'http://192.168.3.47:43121/clients/shujuku/v1', model: 'dsh-default', messages }

test('endpoint registry validates unique stable IDs, preserves an empty registry and excludes admin aliases', () => {
  assert.deepEqual(normalizeConfig({}).clientEndpoints, routes)
  assert.deepEqual(clientEndpoints([]), [])
  const entry = { id: 'new-plugin', label: '新插件', taskId: 'summary', enabled: true }
  assert.deepEqual(sanitizeSettings({ clientEndpoints: [entry] }, {}).settings.clientEndpoints, [entry])
  for (const value of [[entry, entry], [{ ...entry, id: '../bad' }], [{ ...entry, id: 'Upper' }], [{ ...entry, enabled: 'false' }], [{ ...entry, label: '' }], {}, null]) {
    assert.throws(() => clientEndpoints(value))
  }
  assert.deepEqual(clientEndpointPath('/clients/new-plugin/v1/models'), { id: 'new-plugin', canonical: '/v1/models' })
  assert.equal(clientEndpointPath('/clients/new-plugin/v1/bridge/status'), null)
  assert.equal(clientEndpointPath('/clients/%2f/v1/models'), null)
  assert.equal(localBase(yuzi.reverse_proxy + '/'), yuzi.reverse_proxy)
})

test('route identity rejects conflicting declarations without erasing existing protocol fields', () => {
  const entry = routes[0]
  const existing = { protocol_version: 1, client_id: entry.id, chat_id: 'chat', session_id: 'keep', request_id: 'same-retry', fixed_message_count: 1, fixed_message_types: ['contract'], action: 'sync_rules' }
  const result = endpointSession(entry, {}, existing)
  assert.equal(result.task_id, 'phone')
  assert.equal(result.request_id, existing.request_id)
  assert.equal(result.session_id, existing.session_id)
  assert.equal(result.action, 'sync_rules')
  assert.throws(() => endpointSession(entry, { client_id: 'shujuku' }, existing), error => error.code === 'client_endpoint_conflict')
  assert.throws(() => endpointSession(entry, {}, undefined), error => error.code === 'missing_chat_id')
})

test('Yuzi OpenAI and database Custom proxy requests get separate plugin and chat scopes', async () => {
  const before = JSON.stringify([yuzi, database])
  for (const [body, id, task] of [[yuzi, 'yuzi-phone', 'phone'], [database, 'shujuku', 'database']]) {
    const output = await adaptBody({ ...options, body })
    const include = JSON.parse(output.body.custom_include_body)
    assert.equal(output.body.chat_completion_source, 'custom')
    assert.equal(output.body.custom_url, body.reverse_proxy || body.custom_url)
    assert.deepEqual(JSON.parse(output.body.custom_include_headers), { Authorization: 'Bearer device-test' })
    assert.equal(include.dsh_session.client_id, id)
    assert.equal(include.dsh_session.task_id, task)
    assert.equal(include.dsh_session.chat_id, 'stb-chat-one')
    assert.equal(output.preview.client_id, id)
    const second = await adaptBody({ ...options, body, chatId: 'chat-two' })
    assert.notEqual(output.preview.scope, second.preview.scope)
  }
  assert.equal(JSON.stringify([yuzi, database]), before)
})

test('namespace adapter refuses unknown routes, identity conflicts and a missing current chat', async () => {
  await assert.rejects(adaptBody({ ...options, body: { ...yuzi, reverse_proxy: base.replace('/v1', '/clients/unknown/v1') } }), /未登记/)
  await assert.rejects(adaptBody({ ...options, body: yuzi, resolveEndpoint: async () => ({ ...routes[0], enabled: false }) }), /已停用/)
  const conflict = { ...database, custom_include_body: JSON.stringify({ dsh_session: { client_id: 'yuzi-phone', protocol_version: 1, chat_id: 'chat' } }) }
  await assert.rejects(adaptBody({ ...options, body: conflict }), /冲突/)
  await assert.rejects(adaptBody({ ...options, body: yuzi, chatId: '' }), /聊天ID/)
  assert.equal(await adaptBody({ ...options, body: { ...yuzi, reverse_proxy: 'https://external.example/v1' } }), null)
})

test('status/model-list requests use the same paired endpoint without creating sessions', async () => {
  const result = await adaptBody({ ...options, url: `${origin}/api/backends/chat-completions/status`, body: { chat_completion_source: 'openai', reverse_proxy: yuzi.reverse_proxy, proxy_password: 'old-test-key' } })
  assert.equal(result.preview, null)
  assert.equal(result.body.custom_url, yuzi.reverse_proxy)
  assert.equal(result.body.dsh_session, undefined)
  assert.deepEqual(JSON.parse(result.body.custom_include_headers), { Authorization: 'Bearer device-test' })
  const calls = []
  const host = { location: { origin, href: `${origin}/` }, fetch: async (url, init) => { calls.push({ url, init }); return new Response('{}') } }
  const dispose = installAdapter(host, { enabled: () => true, base: () => base, deviceToken: () => 'device-test', selections: () => ({}), entries: () => [], resolveEndpoint })
  await host.fetch(`${yuzi.reverse_proxy}/models`)
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer device-test')
  await host.fetch(`${origin}/api/backends/chat-completions/status`, { method: 'POST', body: JSON.stringify(yuzi) })
  assert.equal(JSON.parse(calls[1].init.body).custom_url, yuzi.reverse_proxy)
  dispose()
})

async function server(t, patch = {}) {
  const calls = []
  const config = { host: '127.0.0.1', port: 0, authToken: 'shared-test', maxBodyBytes: 1024 * 1024, allowLegacyPlain: false, clientEndpoints: clientEndpoints(routes), ...patch }
  const engine = {
    models: () => ({ object: 'list', data: [{ id: 'dsh-default' }] }), capabilities: () => ({}),
    handleDshSession: async request => { calls.push(request); return { action: request.action || 'generate', answer: 'TEST_OK', sessionId: `${request.clientId}:${request.chatId}:${request.taskId}`, turn: calls.length } },
  }
  const app = createBridgeServer({ engine, config, log() {}, pairing: { authenticate: token => token === 'device-test' ? { id: 'test-device' } : null } })
  const port = await app.listen()
  t.after(() => app.close())
  const request = async (path, body, token = 'device-test') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, data: await response.json() }
  }
  return { request, calls, config }
}

test('real HTTP aliases use device authentication and retain client/chat isolation end-to-end', async t => {
  const app = await server(t)
  assert.equal((await app.request('/clients/yuzi-phone/v1/models')).status, 200)
  assert.equal((await app.request('/clients/yuzi-phone/v1/models', undefined, 'wrong')).status, 401)
  for (const [body, client, chat] of [[yuzi, 'yuzi-phone', 'chat-one'], [database, 'shujuku', 'chat-one'], [yuzi, 'yuzi-phone', 'chat-two']]) {
    const adapted = await adaptBody({ ...options, body, chatId: chat })
    const result = await app.request(`/clients/${client}/v1/chat/completions`, { messages, model: 'dsh-default', ...JSON.parse(adapted.body.custom_include_body) })
    assert.equal(result.status, 200)
    assert.equal(result.data.dsh_session.client_id, client)
  }
  assert.equal(new Set(app.calls.map(call => `${call.clientId}:${call.chatId}:${call.taskId}`)).size, 3)
  const capabilities = await app.request('/v1/bridge/capabilities')
  assert.deepEqual(capabilities.data.client_endpoints, routes)
  app.config.clientEndpoints = [...routes, { id: 'summary', label: '总结', taskId: 'summary', enabled: true }]
  assert.equal((await app.request('/clients/summary/v1/models')).status, 200)
})

test('HTTP aliases never fall back on missing chat, unknown/disabled registration or conflicting client', async t => {
  const app = await server(t, { plainCompat: { enabled: true, chatId: 'must-not-use', clientId: 'yuzi-phone' } })
  const body = { messages, chat_id: 'chat' }
  assert.equal((await app.request('/clients/unknown/v1/chat/completions', body)).status, 404)
  const noChat = await app.request('/clients/yuzi-phone/v1/chat/completions', { messages })
  assert.equal(noChat.data.error.code, 'missing_chat_id')
  const conflict = await app.request('/clients/yuzi-phone/v1/chat/completions', { ...body, dsh_session: { protocol_version: 1, chat_id: 'chat', client_id: 'shujuku' } })
  assert.equal(conflict.status, 409)
  assert.equal((await app.request('/clients/yuzi-phone/v1/bridge/status')).status, 403)
  app.config.clientEndpoints[0] = { ...routes[0], enabled: false }
  assert.equal((await app.request('/clients/yuzi-phone/v1/models')).status, 403)
  assert.equal(app.calls.length, 0)
})
