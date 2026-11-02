import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { BridgeEngine } from '../lib/engine.js'
import { BridgeStore } from '../lib/store.js'
import { createBridgeServer } from '../lib/server.js'
import { externalToolRequest } from '../lib/external-tools.js'
import { adaptBody } from '../tavern-extension/core.js'

const tools = [{ type: 'function', function: { name: 'insertRow', description: 'Insert a database row', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }]
const initial = (chat = 'db-one', id = 'r1') => ({ model: 'dsh-default', stream: false, tools, parallel_tool_calls: false,
  messages: [{ role: 'system', content: 'Database rules' }, { role: 'user', content: 'Insert a test row' }],
  dsh_session: { protocol_version: 1, client_id: 'shujuku', task_id: 'database', chat_id: chat, request_id: id, action: 'generate', fixed_message_count: 1, fixed_message_types: ['contract'] } })

class ToolAgent {
  constructor(id, ctx, definitions, multi) {
    this.ctx = ctx; this.definitions = definitions; this.events = []; this.turn = 0; this.prompts = []; this.results = []; this.multi = multi
    this.session = { id, snapshotEvents: () => this.events }
    this.abort = new AbortController()
  }
  cancel() { this.abort.abort() }
  followup(message) {
    this.prompts.push(message); const turn = ++this.turn
    this.events.push({ type: 'turn/start', data: { turn } }, { type: 'user/message', data: { turn, message } })
    void (async () => {
      try {
        for (let i = 0; i < (this.multi ? 2 : 1); i++) {
          const name = [...this.definitions.keys()][0]
          const tool = this.definitions.get(name)
          const callId = `call-${turn}-${i}`, args = { value: 'row-value' }
          this.events.push({ type: 'assistant/message', data: { turn, step: i + 1, message: { content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }] } } })
          const returned = await tool.execute(args, { callId, name, signal: this.abort.signal })
          this.results.push(returned)
          this.events.push({ type: 'tool/result', data: { turn, callId, content: [{ type: 'text', text: returned }] } })
        }
        this.events.push({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: 'DATABASE_DONE' }] }, usage: { prompt_tokens: 10, completion_tokens: 3 } } }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
      } catch (error) { this.events.push({ type: 'turn/end', data: { turn, reason: { kind: 'error', message: error.message } } }) }
    })()
  }
}

async function start(t, { multi = false, unavailable = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-tools-')), sessions = new Map()
  const host = { agents: {
    get: id => sessions.get(id),
    create: async options => {
      const definitions = new Map(), listeners = new Map()
      const ctx = { on: (name, fn) => { listeners.set(name, fn); return () => {} }, tools: unavailable ? {} : {
        presentAs: mode => { assert.equal(mode, 'native'); return () => {} },
        restrict: filter => { assert.deepEqual(filter, { allow: [] }); return () => {} },
        guard: fn => { assert.ok(fn({ name: 'shell' })); assert.equal(fn({ name: 'insertRow' }), undefined); return () => {} },
        register: definition => { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
      } }
      await options.setup(ctx)
      const agent = new ToolAgent(options.sessionId, ctx, definitions, multi)
      sessions.set(options.sessionId, agent)
      return { agent, dispose() { agent.cancel() } }
    },
  }, get: name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'test', model: 'mock' }) } : undefined }
  const config = { host: '127.0.0.1', port: 0, cwd: dir, authToken: '', maxBodyBytes: 1_000_000, requestTimeoutMs: 3000 }
  const store = new BridgeStore(join(dir, 'state.json'))
  const engine = new BridgeEngine(host, config, store, () => {})
  const server = createBridgeServer({ engine, config, log() {} })
  const port = await server.listen()
  t.after(async () => { engine.dispose(); await server.close(); rmSync(dir, { recursive: true, force: true }) })
  const post = body => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let s = ''; res.on('data', c => { s += c }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s) }))
    }); req.on('error', reject); req.end(JSON.stringify(body))
  })
  return { engine, store, sessions, post }
}

function reply(first, requestBody, id = 'r2', text = '{"inserted":true}') {
  return { ...requestBody, messages: [...requestBody.messages, first.body.choices[0].message, { role: 'tool', tool_call_id: first.body.choices[0].message.tool_calls[0].id, content: text }],
    dsh_session: { ...requestBody.dsh_session, request_id: id, session_id: first.body.dsh_session.session_id } }
}

test('native async tool -> caller executes -> same Agent turn resumes; both HTTP legs are idempotent', async t => {
  const app = await start(t), input = initial()
  const first = await app.post(input)
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.choices[0].finish_reason, 'tool_calls')
  assert.equal(first.body.choices[0].message.content, null)
  assert.equal(first.body.choices[0].message.tool_calls[0].function.name, 'insertRow')
  const agent = app.sessions.get(first.body.dsh_session.session_id)
  assert.equal(agent.results.length, 0) // The bridge never pretends to execute the database tool.
  const retry = await app.post(input)
  assert.deepEqual(retry.body.choices, first.body.choices)
  assert.equal(retry.body.bridge.idempotent, true)
  const wrong = reply(first, input); wrong.messages.at(-1).tool_call_id = 'foreign'
  assert.equal((await app.post(wrong)).status, 409)
  const completion = await app.post(reply(first, input))
  assert.equal(completion.status, 200, JSON.stringify(completion.body))
  assert.equal(completion.body.choices[0].message.content, 'DATABASE_DONE')
  assert.equal(completion.body.dsh_session.session_id, first.body.dsh_session.session_id)
  assert.equal(agent.turn, 1); assert.equal(agent.prompts.length, 1)
  assert.deepEqual(agent.results, ['{"inserted":true}'])
  assert.equal((await app.post(reply(first, input))).body.bridge.idempotent, true)
  assert.equal((await app.post(reply(first, input, 'r3'))).status, 409)
  const changed = reply(first, input, 'r2', 'different-result')
  assert.equal((await app.post(changed)).body.error.code, 'request_id_conflict')
})

test('multiple native calls are handed off one at a time; full tool history is accepted for later turns', async t => {
  const app = await start(t, { multi: true }), input = initial()
  const a = await app.post(input), bInput = reply(a, input), b = await app.post(bInput)
  assert.equal(b.status, 200, JSON.stringify(b.body)); assert.equal(b.body.choices[0].finish_reason, 'tool_calls')
  assert.notEqual(a.body.choices[0].message.tool_calls[0].id, b.body.choices[0].message.tool_calls[0].id)
  const cInput = reply(b, bInput, 'r3'), c = await app.post(cInput)
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body.choices[0].message.content, 'DATABASE_DONE')
  const next = { ...cInput, messages: [...cInput.messages, c.body.choices[0].message, { role: 'user', content: 'Next row' }], dsh_session: { ...cInput.dsh_session, request_id: 'r4' } }
  const d = await app.post(next)
  assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.choices[0].finish_reason, 'tool_calls')
  const agent = app.sessions.get(d.body.dsh_session.session_id)
  assert.ok(!JSON.stringify(agent.prompts[1]).includes('Insert a test row'))
  assert.ok(JSON.stringify(agent.prompts[1]).includes('Next row'))
})

test('schema/session/echo changes cannot redirect a pending call; normal text is blocked until result or reset', async t => {
  const app = await start(t), input = initial(), first = await app.post(input)
  const pending = reply(first, input)
  const badSchema = structuredClone(pending); badSchema.tools[0].function.name = 'other'
  assert.equal((await app.post(badSchema)).body.error.code, 'tool_schema_changed')
  const badSession = structuredClone(pending); badSession.dsh_session.chat_id = 'another-chat'
  assert.equal((await app.post(badSession)).status, 410)
  const badEcho = structuredClone(pending); badEcho.messages.at(-2).tool_calls[0].function.arguments = '{}'
  assert.equal((await app.post(badEcho)).body.error.code, 'tool_call_mismatch')
  const normal = { ...input, tools: undefined, dsh_session: { ...input.dsh_session, request_id: 'plain' } }
  assert.equal((await app.post(normal)).body.error.code, 'tool_result_required')
  const reset = await app.post({ ...normal, messages: [], dsh_session: { ...normal.dsh_session, action: 'reset', request_id: 'reset', fixed_message_count: 0, fixed_message_types: [] } })
  assert.equal(reset.status, 200, JSON.stringify(reset.body))
  assert.notEqual(reset.body.dsh_session.session_id, first.body.dsh_session.session_id)
})

test('lost runtime fails closed after returning the cached call, never recreates or repeats external execution', async t => {
  const app = await start(t), input = initial(), first = await app.post(input)
  app.engine.externalTools.cancel([...app.store.listChats()][0].scopeKey)
  assert.equal((await app.post(input)).body.bridge.idempotent, true)
  const second = await app.post(reply(first, input))
  assert.equal(second.body.error.code, 'tool_continuation_unavailable')
  assert.equal(app.sessions.size, 1)
})

test('unsupported streaming/forced/parallel/strict schemas fail explicitly before the Agent runs', async t => {
  const app = await start(t)
  for (const delta of [{ stream: true }, { tool_choice: 'required' }, { tool_choice: 'none' }, { parallel_tool_calls: true }, { tools: [{ ...tools[0], function: { ...tools[0].function, strict: true } }] }, { tools: [tools[0], tools[0]] }, { messages: [{ role: 'assistant', tool_calls: {} }] }, { functions: {} }]) {
    assert.equal((await app.post({ ...initial(), ...delta })).status, 400)
  }
  assert.equal(app.sessions.size, 0)
  assert.throws(() => externalToolRequest({ ...initial(), tools: [{}] }))
})

test('two chats wait independently and cannot submit each other’s result', async t => {
  const app = await start(t), one = initial('one'), two = initial('two')
  const [a, b] = await Promise.all([app.post(one), app.post(two)])
  assert.equal(a.status, 200); assert.equal(b.status, 200)
  assert.notEqual(a.body.dsh_session.session_id, b.body.dsh_session.session_id)
  const alien = reply(a, one)
  alien.dsh_session.chat_id = 'two'
  assert.equal((await app.post(alien)).status, 410)
  const backfill = reply(a, one)
  delete backfill.tools // Existing native registration remains authoritative.
  assert.equal((await app.post(backfill)).body.choices[0].message.content, 'DATABASE_DONE')
  assert.equal(app.sessions.get(b.body.dsh_session.session_id).results.length, 0)
  assert.equal((await app.post(reply(b, two))).body.choices[0].message.content, 'DATABASE_DONE')
})

test('edited full text history is rejected without cancelling the valid Agent', async t => {
  const app = await start(t), input = initial(), a = await app.post(input)
  const backfill = reply(a, input), b = await app.post(backfill)
  const next = { ...backfill, messages: [...backfill.messages, b.body.choices[0].message, { role: 'user', content: 'Next row' }], dsh_session: { ...backfill.dsh_session, request_id: 'next' } }
  const changed = structuredClone(next)
  changed.messages[1].content = 'Rewritten old request'
  assert.equal((await app.post(changed)).body.error.code, 'tool_context_changed')
  assert.equal((await app.post(next)).status, 200)
  assert.equal(app.sessions.get(a.body.dsh_session.session_id).turn, 2)
})

test('missing native tool registry returns 501 instead of fabricating tool calls', async t => {
  const app = await start(t, { unavailable: true })
  const response = await app.post(initial())
  assert.equal(response.status, 501)
  assert.equal(response.body.error.code, 'external_tools_unavailable')
})

test('browser adapter preserves native tool protocol while injecting paired credentials and scope', async () => {
  const body = initial()
  const args = { base: 'http://127.0.0.1:43121/v1', pageOrigin: 'http://localhost:8000', url: 'http://127.0.0.1:43121/v1/chat/completions', body, deviceToken: 'paired', materials: () => { throw new Error('Must not filter tool protocol') } }
  const adapted = await adaptBody(args)
  assert.deepEqual(adapted.body.tools, tools); assert.deepEqual(adapted.body.messages, body.messages)
  assert.equal(adapted.preview, null); assert.equal(adapted.deviceToken, 'paired')
})
