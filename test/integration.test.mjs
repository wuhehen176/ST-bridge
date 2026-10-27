import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BridgeEngine } from '../lib/engine.js'
import { createBridgeServer } from '../lib/server.js'
import { BridgeStore } from '../lib/store.js'

class MockAgent {
  constructor(sessionId) {
    this.events = []
    this.turn = 0
    this.prompts = []
    this.session = {
      id: sessionId,
      snapshotEvents: () => this.events,
    }
  }

  followup(message) {
    const prompt = message?.content?.[0]?.text ?? ''
    this.prompts.push(prompt)
    const turn = ++this.turn
    setTimeout(() => {
      this.events.push({ type: 'turn/start', data: { turn } })
      this.events.push({ type: 'user/message', data: { id: message.id, source: message.source } })
      const marker = prompt.includes('REWRITTEN')
        ? 'REWRITTEN'
        : prompt.includes('stream me')
          ? 'stream me'
          : prompt.slice(0, 30)
      this.events.push({
        type: 'assistant/message',
        data: {
          turn,
          message: { content: [{ type: 'text', text: `ANSWER(${marker})` }] },
          usage: { prompt_tokens: 11, completion_tokens: 7, prompt_cache_hit_tokens: 3 },
        },
      })
      this.events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    }, 10)
  }
}

function makeHost() {
  const agents = new Map()
  const host = {
    agents: {
      async create(options) {
        const agent = new MockAgent(options.sessionId)
        agents.set(options.sessionId, agent)
        await options.setup?.({}, agent)
        return { agent, dispose: async () => {} }
      },
      get(id) {
        return agents.get(id)
      },
      async resume(options) {
        const agent = agents.get(options.resumeSessionId)
        if (!agent) throw new Error('session not found')
        await options.setup?.({}, agent)
        return { agent, dispose: async () => {} }
      },
      withoutInitiator(operation) {
        return operation()
      },
    },
    services: {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'mock', model: 'mock-model' }),
      },
      agentPresets: {
        mount: async () => {},
      },
      sessionController: {
        inspect: async sessionId => ({ events: agents.get(sessionId)?.events ?? [] }),
      },
      sessionTitle: {
        rename: () => {},
      },
      workspaceRegistry: {
        list: () => [{ path: process.cwd(), attachSession: async () => {} }],
      },
    },
    get(name) {
      return this.services[name]
    },
    logger: () => ({ info: () => {}, error: () => {} }),
  }
  return host
}

function config(cwd) {
  return {
    host: '127.0.0.1',
    port: 0,
    cwd,
    agentPreset: 'test-preset',
    provider: '',
    model: '',
    maxTokens: undefined,
    requestTimeoutMs: 8_000,
    maxBodyBytes: 2 * 1024 * 1024,
    authToken: '',
    corsOrigins: undefined,
    allowExtensionOrigins: true,
    allowNullOrigin: false,
    allowLegacyPlain: true,
  }
}

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'bbh-bridge-'))
  const cfg = config(dir)
  const store = new BridgeStore(join(dir, 'state.json'))
  const log = (line) => {
    if (process.env.BBH_DEBUG) console.error(line)
  }
  const engine = new BridgeEngine(makeHost(), cfg, store, log)
  const bridge = createBridgeServer({ engine, config: cfg, log })
  const port = await bridge.listen()
  const base = `http://127.0.0.1:${port}`
  return {
    base,
    dir,
    engine,
    store,
    close: async () => {
      await bridge.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { response, json }
}

test('models endpoint exposes dsh-default', async () => {
  const app = await start()
  try {
    const response = await fetch(`${app.base}/v1/models`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.object, 'list')
    assert.deepEqual(body.data, [{ id: 'dsh-default', object: 'model' }])
  } finally {
    await app.close()
  }
})

test('chat completion creates a session, is idempotent, appends, and branches', async () => {
  const app = await start()
  try {
    const firstMessages = [
      { role: 'system', content: 'SPEC' },
      { role: 'user', content: 'U1' },
    ]
    const first = await post(app.base, '/v1/chat/completions', {
      model: 'dsh-default',
      chat_id: 'chat-1',
      request_id: 'req-1',
      messages: firstMessages,
      temperature: 0.6,
      max_tokens: 8192,
    })
    assert.equal(first.response.status, 200, JSON.stringify(first.json))
    assert.match(first.json.choices[0].message.content, /^ANSWER\(/)
    assert.equal(first.json.model, 'dsh-default')
    assert.ok(first.json.bridge.session_id.startsWith('session-'))
    assert.equal(first.json.usage.prompt_tokens, 11)
    const sessionId = first.json.bridge.session_id

    const duplicate = await post(app.base, '/v1/chat/completions', {
      model: 'dsh-default',
      chat_id: 'chat-1',
      request_id: 'req-1',
      messages: firstMessages,
    })
    assert.equal(duplicate.response.status, 200)
    assert.equal(duplicate.json.bridge.idempotent, true)
    assert.equal(duplicate.json.bridge.session_id, sessionId)
    assert.equal(duplicate.json.choices[0].message.content, first.json.choices[0].message.content)

    const secondMessages = [
      ...firstMessages,
      { role: 'assistant', content: first.json.choices[0].message.content },
      { role: 'user', content: 'U2' },
    ]
    const second = await post(app.base, '/v1/chat/completions', {
      chat_id: 'chat-1',
      request_id: 'req-2',
      messages: secondMessages,
    })
    assert.equal(second.response.status, 200, JSON.stringify(second.json))
    assert.equal(second.json.bridge.session_id, sessionId)
    assert.match(second.json.choices[0].message.content, /^ANSWER\(U2\)/)

    const branchMessages = [
      { role: 'system', content: 'SPEC' },
      { role: 'user', content: 'REWRITTEN' },
    ]
    const branch = await post(app.base, '/v1/chat/completions', {
      chat_id: 'chat-1',
      request_id: 'req-3',
      messages: branchMessages,
    })
    assert.equal(branch.response.status, 200, `${branch.response.status} ${JSON.stringify(branch.json)}`)
    assert.equal(branch.json.bridge.branch, true)
    assert.notEqual(branch.json.bridge.session_id, sessionId)
    assert.match(branch.json.choices[0].message.content, /^ANSWER\(REWRITTEN\)/)

    const status = await fetch(`${app.base}/v1/bridge/status?chat_id=chat-1`)
    assert.equal(status.status, 200)
    const statusBody = await status.json()
    assert.equal(statusBody.session_id, branch.json.bridge.session_id)
    assert.ok(statusBody.previous_sessions.includes(sessionId))
  } finally {
    await app.close()
  }
})

test('reset removes the binding and the next request starts a new session', async () => {
  const app = await start()
  try {
    const first = await post(app.base, '/v1/chat/completions', {
      chat_id: 'chat-reset',
      request_id: 'r1',
      messages: [{ role: 'user', content: 'one' }],
    })
    assert.equal(first.response.status, 200)
    const oldSession = first.json.bridge.session_id

    const reset = await post(app.base, '/v1/bridge/reset', { chat_id: 'chat-reset' })
    assert.equal(reset.response.status, 200)
    assert.equal(reset.json.removed, true)

    const second = await post(app.base, '/v1/chat/completions', {
      chat_id: 'chat-reset',
      request_id: 'r2',
      messages: [{ role: 'user', content: 'two' }],
    })
    assert.equal(second.response.status, 200)
    assert.notEqual(second.json.bridge.session_id, oldSession)
  } finally {
    await app.close()
  }
})

test('missing identifiers and unknown models are rejected clearly', async () => {
  const app = await start()
  try {
    const missingChat = await post(app.base, '/v1/chat/completions', {
      request_id: 'r1',
      messages: [{ role: 'user', content: 'x' }],
    })
    assert.equal(missingChat.response.status, 400)
    assert.match(missingChat.json.error.message, /chat_id/)

    const missingRequest = await post(app.base, '/v1/chat/completions', {
      chat_id: 'c1',
      messages: [{ role: 'user', content: 'x' }],
    })
    assert.equal(missingRequest.response.status, 400)
    assert.match(missingRequest.json.error.message, /request_id/)

    const unknownModel = await post(app.base, '/v1/chat/completions', {
      model: 'not-a-model',
      chat_id: 'c1',
      request_id: 'r2',
      messages: [{ role: 'user', content: 'x' }],
    })
    assert.equal(unknownModel.response.status, 400)
    assert.match(unknownModel.json.error.message, /dsh-default/)
  } finally {
    await app.close()
  }
})

test('stream=true returns OpenAI-style SSE chunks and [DONE]', async () => {
  const app = await start()
  try {
    const response = await fetch(`${app.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: 'chat-stream',
        request_id: 'stream-1',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'stream me' }],
      }),
    })
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /data: \{"id":"chatcmpl-stream-1"/)
    assert.match(text, /"delta":\{"content":"ANSWER\(/)
    assert.match(text, /"usage":\{"prompt_tokens":11/)
    assert.match(text, /data: \[DONE\]/)
  } finally {
    await app.close()
  }
})

test('a second request with a different request_id is serialized per chat', async () => {
  const app = await start()
  try {
    const [a, b] = await Promise.all([
      post(app.base, '/v1/chat/completions', {
        chat_id: 'chat-serial',
        request_id: 's1',
        messages: [{ role: 'user', content: 'first' }],
      }),
      post(app.base, '/v1/chat/completions', {
        chat_id: 'chat-serial',
        request_id: 's2',
        messages: [{ role: 'user', content: 'second' }],
      }),
    ])
    assert.equal(a.response.status, 200)
    assert.equal(b.response.status, 200)
    assert.ok(a.json && b.json)
  } finally {
    await app.close()
  }
})
