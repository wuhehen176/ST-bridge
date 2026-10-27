import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BridgeEngine } from '../lib/engine.js'
import { createBridgeServer } from '../lib/server.js'
import { BridgeStore } from '../lib/store.js'
import { messageHash } from '../lib/context.js'
import { adaptBody } from '../tavern-extension/core.js'

class MockAgent {
  constructor(sessionId) {
    this.session = { id: sessionId, snapshotEvents: () => this.events }
    this.events = []
    this.turn = 0
    this.prompts = []
    this.failMode = null
  }

  followup(message) {
    const prompt = message?.content?.[0]?.text ?? ''
    this.prompts.push(prompt)
    const turn = ++this.turn
    setTimeout(() => {
      this.events.push({ type: 'turn/start', data: { turn } })
      if (this.failMode === 'transient') {
        this.failMode = null
        this.events.push({ type: 'turn/end', data: { turn, reason: { kind: 'error', error: { code: 'rate_limit_exceeded', message: '429 rate limit' } } } })
        return
      }
      if (this.failMode === 'context') {
        this.failMode = null
        this.events.push({ type: 'turn/end', data: { turn, reason: { kind: 'error', error: { code: 'model_error', message: 'context length exceeded: maximum context is 200000 tokens' } } } })
        return
      }
      if (this.failMode === 'blocked') {
        this.failMode = null
        this.events.push({ type: 'turn/end', data: { turn, reason: { kind: 'error', error: { code: 'model_error', message: 'qoder: Session blocked, Please clear context try again (406/model_error)' } } } })
        return
      }
      this.events.push({ type: 'user/message', data: { id: message.id, source: message.source } })
      this.events.push({
        type: 'assistant/message',
        data: {
          turn,
          message: { content: [{ type: 'text', text: `OK:${prompt.slice(-24)}` }] },
          usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
        },
      })
      this.events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
    }, 10)
  }
}

function makeHost() {
  const sessions = new Map()
  const host = {
    sessions,
    agents: {
      async create(options) {
        if (sessions.has(options.sessionId)) throw new Error(`session ${options.sessionId} already exists`)
        const agent = new MockAgent(options.sessionId)
        sessions.set(options.sessionId, agent)
        await options.setup?.({ on: () => {} }, agent)
        return { agent, dispose: async () => {} }
      },
      get(id) {
        return sessions.get(id)
      },
      async resume(options) {
        const agent = sessions.get(options.resumeSessionId)
        if (!agent) throw new Error(`session ${options.resumeSessionId} not found`)
        await options.setup?.({ on: () => {} }, agent)
        return { agent, dispose: async () => {} }
      },
      withoutInitiator(operation) {
        return operation()
      },
    },
    services: {
      agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) },
      agentPresets: { mount: async () => {} },
      sessionController: {
        inspect: async sessionId => {
          const agent = sessions.get(sessionId)
          if (!agent) throw new Error(`session ${sessionId} not found`)
          return { events: agent.events }
        },
      },
      sessionTitle: { rename: () => {} },
      workspaceRegistry: { list: () => [{ path: process.cwd(), attachSession: async () => {} }] },
    },
    get(name) {
      return this.services[name]
    },
    logger: () => ({ info: () => {}, error: () => {} }),
  }
  return host
}

function makeConfig(cwd) {
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
    allowLegacyPlain: false,
  }
}

async function start() {
  const dir = mkdtempSync(join(tmpdir(), 'bbh-session-'))
  const host = makeHost()
  const cfg = makeConfig(dir)
  const store = new BridgeStore(join(dir, 'state.json'))
  const engine = new BridgeEngine(host, cfg, store, () => {})
  const bridge = createBridgeServer({ engine, config: cfg, log: () => {} })
  const port = await bridge.listen()
  return {
    base: `http://127.0.0.1:${port}`,
    engine,
    host,
    sessions: host.sessions,
    close: async () => {
      await bridge.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function postDsh(base, body) {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { response, json, text }
}

function blockedRequest(chatId, requestId, sessionId) {
  return { model: 'dsh-default', messages: [{ role: 'user', content: 'database update' }],
    dsh_session: dsh({ chat_id: chatId, request_id: requestId, action: 'generate',
      session_id: sessionId, fixed_message_count: 0, fixed_message_types: [] }) }
}

function appendBlockedClaim(agent, requestId) {
  agent.events.push({ type: 'agent/inbox/spliced', data: {
    target: 'next-turn', start: 0,
    inserted: [{ id: requestId, role: 'user', source: { kind: 'user', rpcId: requestId } }],
  } })
  const turn = ++agent.turn
  agent.events.push({ type: 'turn/start', data: { turn } })
  agent.events.push({ type: 'agent/inbox/spliced', data: {
    target: 'next-turn', start: 0, removedCount: 1, inserted: [],
  } })
  agent.events.push({ type: 'turn/end', data: { turn, reason: { kind: 'blocked' } } })
}

test('archived session returns 409 without submitting or creating another session', async () => {
  const app = await start()
  try {
    const initial = await postDsh(app.base, blockedRequest('archive-chat', 'initial'))
    assert.equal(initial.response.status, 200)
    const id = initial.json.dsh_session.session_id
    const agent = app.sessions.get(id)
    app.host.services.workspaceRegistry.archivedSessionIds = [id]
    const result = await postDsh(app.base, blockedRequest('archive-chat', 'archived', id))
    assert.equal(result.response.status, 409)
    assert.equal(result.json.error.code, 'session_archived')
    assert.equal(agent.prompts.length, 1)
    assert.equal(app.sessions.size, 1)
    assert.deepEqual(app.host.services.workspaceRegistry.archivedSessionIds, [id])
  } finally { await app.close() }
})

test('blocked pre-step fails promptly, persists error, and retry does not submit again', async () => {
  const app = await start()
  try {
    const initial = await postDsh(app.base, blockedRequest('blocked-chat', 'initial'))
    assert.equal(initial.response.status, 200)
    const id = initial.json.dsh_session.session_id
    const agent = app.sessions.get(id)
    agent.followup = message => {
      agent.prompts.push('blocked attempt')
      appendBlockedClaim(agent, message.source.rpcId)
    }
    app.engine.config.requestTimeoutMs = 1000
    const request = blockedRequest('blocked-chat', 'blocked', id)
    const result = await postDsh(app.base, request)
    assert.equal(result.response.status, 409)
    assert.equal(result.json.error.code, 'agent_turn_blocked')
    const chat = app.engine.store.listChats().find(item => item.chatId === 'blocked-chat')
    assert.equal(chat.requests.blocked.status, 'error')
    const retry = await postDsh(app.base, request)
    assert.equal(retry.response.status, 409)
    assert.equal(agent.prompts.length, 2)
  } finally { await app.close() }
})

test('pending blocked request recovers after restart and stops reporting in-progress', async () => {
  const app = await start()
  try {
    const initial = await postDsh(app.base, blockedRequest('recover-chat', 'initial'))
    assert.equal(initial.response.status, 200)
    const id = initial.json.dsh_session.session_id
    const agent = app.sessions.get(id)
    appendBlockedClaim(agent, 'old-pending')
    const chat = app.engine.store.listChats().find(item => item.chatId === 'recover-chat')
    app.engine.store.putRequest(chat.scopeKey, 'old-pending', {
      status: 'pending', action: 'generate', sessionId: id,
    })
    app.host.services.workspaceRegistry.archivedSessionIds = [id]
    const result = await postDsh(app.base, blockedRequest('recover-chat', 'old-pending', id))
    assert.equal(result.response.status, 409)
    assert.equal(result.json.error.code, 'session_archived')
    assert.equal(app.engine.store.getRequest(chat.scopeKey, 'old-pending').status, 'error')
    assert.equal(agent.prompts.length, 1)
  } finally { await app.close() }
})

function dsh(extra) {
  return { protocol_version: 1, ...extra }
}

function fixedMessages() {
  return [
    { role: 'system', content: 'PREFIX_SECRET' },
    { role: 'system', content: 'SPEC_SECRET' },
    { role: 'user', content: 'dynamic target' },
  ]
}

test('generate initial stores fixed rules and sends only the dynamic group', async () => {
  const app = await start()
  try {
    const result = await postDsh(app.base, {
      model: 'dsh-default',
      messages: fixedMessages(),
      temperature: 0.6,
      max_tokens: 512,
      dsh_session: dsh({
        chat_id: 'chat-a',
        request_id: 'r1',
        action: 'generate',
        fixed_message_count: 2,
        fixed_message_types: ['prefix', 'spec'],
        target: { floor: 0, swipe_id: null, revision: 'TARGET_SECRET' },
      }),
    })
    assert.equal(result.response.status, 200, result.text)
    assert.match(result.json.choices[0].message.content, /^OK:/)
    assert.equal(result.json.dsh_session.session_id, result.json.bridge?.session_id ?? result.json.dsh_session.session_id)
    const sessionId = result.json.dsh_session.session_id
    assert.ok(sessionId.startsWith('session-st-'))
    assert.equal(app.sessions.size, 1)
    const prompt = [...app.sessions.values()][0].prompts[0]
    assert.match(prompt, /dynamic target/)
    assert.doesNotMatch(prompt, /PREFIX_SECRET|SPEC_SECRET|TARGET_SECRET/)
    assert.deepEqual(app.engine.runtimes.get(sessionId).fixedRules.map(rule => rule.type), ['prefix', 'spec'])
    const { diagnostics, ...usage } = result.json.usage
    assert.deepEqual(usage, {
      prompt_tokens: 12,
      completion_tokens: 4,
      prompt_tokens_details: { cached_tokens: 3 },
    })
    assert.equal(diagnostics.usageEventCount, 1)
    assert.equal(diagnostics.cacheReporting, 'reported')
    assert.equal(Object.hasOwn(diagnostics, 'modelCallCount'), false)
  } finally {
    await app.close()
  }
})

test('generate with session_id appends only dynamic messages and keeps session', async () => {
  const app = await start()
  try {
    const first = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-b', request_id: 'r1', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    const sessionId = first.json.dsh_session.session_id
    const before = app.sessions.get(sessionId).prompts.length

    const second = await postDsh(app.base, {
      messages: [{ role: 'user', content: 'second turn' }],
      dsh_session: dsh({
        chat_id: 'chat-b', request_id: 'r2', action: 'generate',
        session_id: sessionId, fixed_message_count: 0, fixed_message_types: [],
      }),
    })
    assert.equal(second.response.status, 200, second.text)
    assert.equal(second.json.dsh_session.session_id, sessionId)
    assert.equal(app.sessions.get(sessionId).prompts.length, before + 1)
    assert.equal(app.sessions.get(sessionId).prompts.at(-1), 'second turn')
  } finally {
    await app.close()
  }
})

test('sync_rules updates fixed rules without running a model turn', async () => {
  const app = await start()
  try {
    const first = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-c', request_id: 'r1', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    const sessionId = first.json.dsh_session.session_id
    const turns = app.sessions.get(sessionId).turn

    const sync = await postDsh(app.base, {
      messages: [{ role: 'system', content: 'NEW_SPEC' }],
      dsh_session: dsh({
        chat_id: 'chat-c', request_id: 'r2', action: 'sync_rules',
        session_id: sessionId, fixed_message_count: 1, fixed_message_types: ['spec'],
      }),
    })
    assert.equal(sync.response.status, 200, sync.text)
    assert.deepEqual(sync.json.choices, [])
    assert.equal(sync.json.dsh_session.session_id, sessionId)
    assert.equal(app.sessions.get(sessionId).turn, turns)
    assert.deepEqual(app.engine.runtimes.get(sessionId).fixedRules.map(rule => rule.type), ['spec'])
    assert.match(app.engine.runtimes.get(sessionId).fixedRules[0].text, /NEW_SPEC/)
  } finally {
    await app.close()
  }
})

test('dsh_session without request_id gets a stable generated id', async () => {
  const app = await start()
  try {
    const body = {
      model: 'dsh-default',
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-auto',
        action: 'generate',
        fixed_message_count: 0,
        fixed_message_types: [],
      }),
    }
    const first = await postDsh(app.base, body)
    assert.equal(first.response.status, 200, first.text)
    const autoId = first.json.dsh_session.request_id
    assert.match(autoId, /^auto-[a-f0-9]{32}$/)
    const second = await postDsh(app.base, body)
    assert.equal(second.response.status, 200, second.text)
    assert.equal(second.json.dsh_session.request_id, autoId)
    assert.equal(second.json.bridge.idempotent, true)
  } finally {
    await app.close()
  }
})

test('static dsh_session without session_id reuses the chat binding', async () => {
  const app = await start()
  try {
    const first = await postDsh(app.base, {
      messages: [{ role: 'user', content: 'first database call' }],
      dsh_session: dsh({ chat_id: 'db-static', action: 'generate' }),
    })
    assert.equal(first.response.status, 200, first.text)
    const firstId = first.json.dsh_session.session_id

    const second = await postDsh(app.base, {
      messages: [{ role: 'user', content: 'second database call' }],
      dsh_session: dsh({ chat_id: 'db-static', action: 'generate' }),
    })
    assert.equal(second.response.status, 200, second.text)
    assert.equal(second.json.dsh_session.session_id, firstId)
    assert.equal(app.sessions.size, 1)
  } finally {
    await app.close()
  }
})

test('sync_rules without session_id creates an empty bound session', async () => {
  const app = await start()
  try {
    const sync = await postDsh(app.base, {
      messages: [{ role: 'system', content: 'PREFIX' }],
      dsh_session: dsh({
        chat_id: 'chat-d', request_id: 'r1', action: 'sync_rules',
        fixed_message_count: 1, fixed_message_types: ['prefix'],
      }),
    })
    assert.equal(sync.response.status, 200, sync.text)
    assert.deepEqual(sync.json.choices, [])
    const sessionId = sync.json.dsh_session.session_id
    assert.ok(sessionId)
    assert.equal(app.sessions.get(sessionId).turn, 0)
    assert.equal(app.sessions.get(sessionId).prompts.length, 0)
  } finally {
    await app.close()
  }
})

test('reset creates a new session and keeps the old one', async () => {
  const app = await start()
  try {
    const first = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-e', request_id: 'r1', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    const oldId = first.json.dsh_session.session_id
    const reset = await postDsh(app.base, {
      messages: [],
      dsh_session: dsh({ chat_id: 'chat-e', request_id: 'r2', action: 'reset' }),
    })
    assert.equal(reset.response.status, 200, reset.text)
    assert.deepEqual(reset.json.choices, [])
    const newId = reset.json.dsh_session.session_id
    assert.notEqual(newId, oldId)
    assert.ok(app.sessions.has(oldId))
    assert.ok(app.sessions.has(newId))

    const again = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-e', request_id: 'r3', action: 'generate',
        session_id: newId, fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    assert.equal(again.response.status, 200, again.text)
    assert.equal(again.json.dsh_session.session_id, newId)
  } finally {
    await app.close()
  }
})

test('unknown or foreign session_id returns 410', async () => {
  const app = await start()
  try {
    const first = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-f', request_id: 'r1', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    const sessionId = first.json.dsh_session.session_id

    const unknown = await postDsh(app.base, {
      messages: [{ role: 'user', content: 'x' }],
      dsh_session: dsh({
        chat_id: 'chat-f', request_id: 'r2', action: 'generate',
        session_id: 'session-st-does-not-exist', fixed_message_count: 0, fixed_message_types: [],
      }),
    })
    assert.equal(unknown.response.status, 410, unknown.text)
    assert.equal(unknown.json.error.code, 'session_gone')

    const foreign = await postDsh(app.base, {
      messages: [{ role: 'user', content: 'x' }],
      dsh_session: dsh({
        chat_id: 'chat-g', request_id: 'r3', action: 'generate',
        session_id: sessionId, fixed_message_count: 0, fixed_message_types: [],
      }),
    })
    assert.equal(foreign.response.status, 410, foreign.text)
  } finally {
    await app.close()
  }
})

test('410 can be retried with the same request_id and a fresh initialization', async () => {
  const app = await start()
  try {
    const first = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-410', request_id: 'r1', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    const staleId = first.json.dsh_session.session_id
    app.sessions.delete(staleId)

    const gone = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-410', request_id: 'r2', action: 'generate',
        session_id: staleId, fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    assert.equal(gone.response.status, 410, gone.text)

    const retry = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-410', request_id: 'r2', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    assert.equal(retry.response.status, 200, retry.text)
    assert.notEqual(retry.json.dsh_session.session_id, staleId)
  } finally {
    await app.close()
  }
})

test('same request_id returns the same result without a second turn', async () => {
  const app = await start()
  try {
    const body = {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-h', request_id: 'same', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    }
    const first = await postDsh(app.base, body)
    const sessionId = first.json.dsh_session.session_id
    const turns = app.sessions.get(sessionId).turn
    const second = await postDsh(app.base, body)
    assert.equal(second.response.status, 200, second.text)
    assert.equal(second.json.dsh_session.session_id, sessionId)
    assert.equal(second.json.choices[0].message.content, first.json.choices[0].message.content)
    assert.equal(app.sessions.get(sessionId).turn, turns)
  } finally {
    await app.close()
  }
})

test('client_id and task_id isolate sessions even with the same chat_id', async () => {
  const app = await start()
  try {
    const baibai = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        client_id: 'baibai-image', chat_id: 'shared-chat', request_id: 'same-r',
        action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    const yuzi = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        client_id: 'yuzi-phone', chat_id: 'shared-chat', request_id: 'same-r',
        action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    const yuziTask = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        client_id: 'yuzi-phone', chat_id: 'shared-chat', task_id: 'qq',
        request_id: 'same-r', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    assert.equal(baibai.response.status, 200, baibai.text)
    assert.equal(yuzi.response.status, 200, yuzi.text)
    assert.equal(yuziTask.response.status, 200, yuziTask.text)
    const ids = new Set([
      baibai.json.dsh_session.session_id,
      yuzi.json.dsh_session.session_id,
      yuziTask.json.dsh_session.session_id,
    ])
    assert.equal(ids.size, 3)
    assert.equal(baibai.json.dsh_session.client_id, 'baibai-image')
    assert.equal(yuzi.json.dsh_session.task_id, 'default')
    assert.equal(yuziTask.json.dsh_session.task_id, 'qq')
    assert.ok(yuziTask.json.bridge)
  } finally {
    await app.close()
  }
})

test('allowedClientIds blocks other plugins with 403', async () => {
  const app = await start()
  try {
    app.engine.config.allowedClientIds = ['baibai-image']
    const allowed = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        client_id: 'baibai-image', chat_id: 'allow-chat', request_id: 'r1',
        action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    assert.equal(allowed.response.status, 200, allowed.text)
    const blocked = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        client_id: 'yuzi-phone', chat_id: 'allow-chat', request_id: 'r2',
        action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    assert.equal(blocked.response.status, 403, blocked.text)
    assert.equal(blocked.json.error.code, 'client_not_allowed')
  } finally {
    await app.close()
  }
})

test('explicit baibai-image/default keeps the old chat_id binding', async () => {
  const app = await start()
  try {
    const legacy = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'legacy-alias', request_id: 'r1', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    const sessionId = legacy.json.dsh_session.session_id
    const upgraded = await postDsh(app.base, {
      messages: [{ role: 'user', content: 'next' }],
      dsh_session: dsh({
        client_id: 'baibai-image', chat_id: 'legacy-alias', task_id: 'default',
        request_id: 'r2', action: 'generate', session_id: sessionId,
        fixed_message_count: 0, fixed_message_types: [],
      }),
    })
    assert.equal(upgraded.response.status, 200, upgraded.text)
    assert.equal(upgraded.json.dsh_session.session_id, sessionId)
  } finally {
    await app.close()
  }
})

test('tool protocol and strict JSON schema are rejected explicitly', async () => {
  const app = await start()
  try {
    const tools = await postDsh(app.base, {
      tools: [{ type: 'function', function: { name: 'x' } }],
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'tool-chat', request_id: 'r1', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    assert.equal(tools.response.status, 400, tools.text)
    assert.equal(tools.json.error.code, 'unsupported_tool_mode')

    const toolRole = await postDsh(app.base, {
      messages: [{ role: 'tool', content: 'x' }],
      dsh_session: dsh({
        chat_id: 'tool-chat', request_id: 'r2', action: 'generate',
        fixed_message_count: 0, fixed_message_types: [],
      }),
    })
    assert.equal(toolRole.response.status, 400, toolRole.text)
    assert.equal(toolRole.json.error.code, 'unsupported_tool_mode')

    const schema = await postDsh(app.base, {
      response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } },
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'tool-chat', request_id: 'r3', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    assert.equal(schema.response.status, 400, schema.text)
    assert.equal(schema.json.error.code, 'unsupported_response_format')
  } finally {
    await app.close()
  }
})

test('plain completions are rejected by default without creating a session', async () => {
  const app = await start()
  try {
    const response = await postDsh(app.base, {
      model: 'dsh-default',
      messages: [{ role: 'user', content: 'health check' }],
    })
    assert.equal(response.response.status, 400, response.text)
    assert.equal(response.json.error.code, 'persistent_protocol_required')
    assert.equal(app.sessions.size, 0)
  } finally {
    await app.close()
  }
})

test('capabilities endpoint describes the persistent protocol without creating a session', async () => {
  const app = await start()
  try {
    const response = await fetch(`${app.base}/v1/bridge/capabilities`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.object, 'bridge.capabilities')
    assert.deepEqual(body.protocol_versions, [1])
    assert.equal(body.tool_calls, false)
    assert.equal(body.strict_json, false)
    assert.deepEqual(body.scope_keys, ['client_id', 'chat_id', 'task_id'])
    assert.ok(body.control_actions.includes('sync_rules'))
    assert.equal(app.sessions.size, 0)
  } finally {
    await app.close()
  }
})

test('invalid fixed types and non-empty reset are rejected', async () => {
  const app = await start()
  try {
    const badTypes = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-i', request_id: 'r1', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'unknown'],
      }),
    })
    assert.equal(badTypes.response.status, 400, badTypes.text)

    const badReset = await postDsh(app.base, {
      messages: [{ role: 'user', content: 'x' }],
      dsh_session: dsh({ chat_id: 'chat-i', request_id: 'r2', action: 'reset' }),
    })
    assert.equal(badReset.response.status, 400, badReset.text)
  } finally {
    await app.close()
  }
})

test('dsh_session mode ignores stream=true and returns JSON', async () => {
  const app = await start()
  try {
    const result = await postDsh(app.base, {
      stream: true,
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'chat-j', request_id: 'r1', action: 'generate',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    assert.equal(result.response.status, 200)
    assert.match(result.response.headers.get('content-type') ?? '', /application\/json/)
    assert.equal(typeof result.json.choices[0].message.content, 'string')
    assert.ok(result.json.dsh_session.session_id)
  } finally {
    await app.close()
  }
})

test('context preview is read-only; scoped tiers replace rules and restore originals without branching', async () => {
  const app = await start()
  try {
    const profiles = { version: 1, profiles: [{ id: 'manga-short', label: 'Manga compact', client_id: 'baibai-image', task_id: 'default', replace: { spec: 'SHORT_SPEC', check: 'SHORT_CHECK' } }] }
    const imported = await fetch(`${app.base}/v1/bridge/context/profiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(profiles) })
    assert.equal(imported.status, 200)
    const listed = await imported.json()
    assert.equal(JSON.stringify(listed).includes('SHORT_SPEC'), false)
    const payload = {
      messages: [{ role: 'system', content: 'PREFIX_KEEP' }, { role: 'system', content: 'ORIGINAL_LONG_SPEC' }, { role: 'system', content: 'EXACT_JSON_CONTRACT' }, { role: 'system', content: 'ORIGINAL_LONG_CHECK' }, { role: 'system', content: 'FULL_WORLD_MATERIAL' }, { role: 'user', content: 'EXACT_TARGET_AND_STATE' }],
      dsh_session: dsh({ chat_id: 'tier-chat', request_id: 'tier-1', fixed_message_count: 4, fixed_message_types: ['prefix', 'spec', 'contract', 'check'] }),
      dsh_context: { version: 1, profile_id: 'manga-short', profile_hash: listed.profiles[0].hash, sources: [] },
    }
    const original = JSON.stringify(payload)
    const preview = await fetch(`${app.base}/v1/bridge/context/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const report = await preview.json()
    assert.equal(preview.status, 200)
    assert.equal(report.preview_only, true)
    assert.equal(report.materials_mode, 'keep-all')
    assert.ok(report.rule_chars_after < report.rule_chars_before)
    assert.equal(app.sessions.size, 0)
    assert.equal(app.engine.store.listChats().length, 0)
    const first = await postDsh(app.base, payload)
    assert.equal(first.response.status, 200)
    const sid = first.json.dsh_session.session_id
    assert.equal(first.json.bridge.context.profile_id, 'manga-short')
    const chat = app.engine.store.getChat('tier-chat')
    assert.deepEqual(chat.fixedRules.map(r => r.text), ['PREFIX_KEEP', 'SHORT_SPEC', 'EXACT_JSON_CONTRACT', 'SHORT_CHECK'])
    assert.deepEqual(chat.sourceFixedRules.map(r => r.text), ['PREFIX_KEEP', 'ORIGINAL_LONG_SPEC', 'EXACT_JSON_CONTRACT', 'ORIGINAL_LONG_CHECK'])
    assert.ok(app.sessions.get(sid).prompts[0].includes('EXACT_TARGET_AND_STATE'))
    assert.equal(JSON.stringify(payload), original)
    const retry = await postDsh(app.base, payload)
    assert.equal(retry.json.bridge.idempotent, true)
    assert.equal(retry.json.bridge.context.profile_id, 'manga-short')
    assert.equal(app.sessions.get(sid).prompts.length, 1)
    const reattributed = await postDsh(app.base, { ...payload, dsh_context: { ...payload.dsh_context, sources: [{ message_index: 5, start: 0, end: payload.messages[5].content.length, kind: 'target', title: 'new attribution only', message_hash: messageHash('user', payload.messages[5].content) }] } })
    assert.equal(reattributed.response.status, 200)
    assert.equal(reattributed.json.bridge.idempotent, true)
    assert.equal(app.sessions.get(sid).prompts.length, 1)
    const restore = await postDsh(app.base, { messages: [{ role: 'user', content: 'next exact target' }], dsh_session: dsh({ chat_id: 'tier-chat', session_id: sid, request_id: 'tier-2', fixed_message_count: 0, fixed_message_types: [] }), dsh_context: { version: 1, profile_id: 'original', sources: [] } })
    assert.equal(restore.response.status, 200)
    assert.equal(restore.json.dsh_session.session_id, sid)
    assert.equal(app.sessions.size, 1)
    assert.equal(app.engine.store.getChat('tier-chat').fixedRules[1].text, 'ORIGINAL_LONG_SPEC')
    const wrongScope = await postDsh(app.base, { ...payload, dsh_session: { ...payload.dsh_session, client_id: 'shujuku', request_id: 'wrong-client' } })
    assert.equal(wrongScope.response.status, 400)
    assert.equal(app.sessions.size, 1)
    const stale = await postDsh(app.base, { ...payload, dsh_context: { ...payload.dsh_context, profile_hash: '0'.repeat(64) }, dsh_session: { ...payload.dsh_session, request_id: 'stale-profile' } })
    assert.equal(stale.response.status, 400)
    assert.equal(app.sessions.size, 1)
    const staticSession = { ...payload.dsh_session, request_id: undefined }
    const autoOriginal = await postDsh(app.base, { ...payload, dsh_session: staticSession, dsh_context: { version: 1, profile_id: 'original', sources: [] } })
    const autoShort = await postDsh(app.base, { ...payload, dsh_session: staticSession })
    assert.equal(autoOriginal.response.status, 200)
    assert.equal(autoShort.response.status, 200)
    assert.notEqual(autoOriginal.json.dsh_session.request_id, autoShort.json.dsh_session.request_id)
    assert.equal(autoShort.json.dsh_session.session_id, sid)
    assert.equal(app.sessions.size, 1)
  } finally { await app.close() }
})

test('a selected tier cannot guess system slots in plain database requests', async () => {
  const app = await start()
  try {
    app.engine.contextProfiles.save({ version: 1, profiles: [{ id: 'db-short', label: 'Database test', client_id: 'shujuku', task_id: 'database', replace: { spec: 'SHORT' } }] })
    const body = { messages: [{ role: 'system', content: 'JSON_TABLE_PROTOCOL' }, { role: 'user', content: 'FULL_RECORD' }], dsh_session: dsh({ client_id: 'shujuku', task_id: 'database', chat_id: 'db', request_id: 'db-1', fixed_message_count: 0, fixed_message_types: [] }), dsh_context: { version: 1, profile_id: 'db-short', sources: [] } }
    const rejected = await postDsh(app.base, body)
    assert.equal(rejected.response.status, 400)
    assert.match(rejected.text, /固定规则槽/)
    assert.equal(app.sessions.size, 0)
    const original = await postDsh(app.base, { ...body, dsh_session: { ...body.dsh_session, request_id: 'db-2' }, dsh_context: { ...body.dsh_context, profile_id: 'original' } })
    assert.equal(original.response.status, 200)
    assert.equal(original.json.bridge.context.materials_mode, 'keep-all')
    const withoutAdapter = await postDsh(app.base, { ...body, dsh_session: { ...body.dsh_session, request_id: 'db-2' }, dsh_context: undefined })
    assert.equal(withoutAdapter.response.status, 200)
    assert.equal(withoutAdapter.json.bridge.idempotent, true)
  } finally { await app.close() }
})

test('new transport traces preserve real engine idempotency and generated request IDs', async () => {
  const app = await start()
  try {
    const body = { messages: [{ role: 'user', content: 'unchanged target' }], dsh_session: dsh({ chat_id: 'trace-chat', request_id: undefined, fixed_message_count: 0, fixed_message_types: [] }) }
    const args = { url: app.base + '/v1/chat/completions', pageOrigin: 'http://localhost:8000', body, base: app.base + '/v1' }
    const a = await adaptBody(args), b = await adaptBody(args)
    const first = await postDsh(app.base, a.body), second = await postDsh(app.base, b.body)
    assert.equal(first.response.status, 200)
    assert.equal(second.response.status, 200)
    assert.equal(second.json.bridge.idempotent, true)
    assert.equal(first.json.dsh_session.request_id, second.json.dsh_session.request_id)
    assert.notEqual(first.json.bridge.receipt.trace_id, second.json.bridge.receipt.trace_id)
    assert.equal(second.json.bridge.receipt.trace_id, b.preview.trace_id)
    assert.equal(app.sessions.size, 1)
    assert.equal([...app.sessions.values()][0].prompts.length, 1)
  } finally { await app.close() }
})

test('fixed preset is sent in full first, then deduped once the same session confirms it', async () => {
  const app = await start()
  try {
    const presetBody = 'DB_FIXED_PRESET_BODY'
    app.engine.presetConfigs.save({
      version: 1,
      presets: [{
        id: 'db', label: 'DB', client_id: 'shujuku', task_id: 'database', mode: 'exact',
        exact_hashes: [messageHash('system', presetBody)],
      }],
    })
    const body = {
      messages: [
        { role: 'system', content: presetBody },
        { role: 'system', content: 'LIVE_TABLE_STATE' },
        { role: 'user', content: 'TARGET_TEXT' },
      ],
      dsh_session: dsh({ client_id: 'shujuku', task_id: 'database', chat_id: 'db-preset', action: 'generate' }),
    }
    const first = await postDsh(app.base, body)
    assert.equal(first.response.status, 200, first.text)
    assert.equal(first.json.bridge.preset.status, 'first-install')
    const sessionId = first.json.dsh_session.session_id
    const agent = app.sessions.get(sessionId)
    // The dynamic system block is injected as a separate prompt section, so
    // the user prompt itself only carries the target text. The runtime block is
    // cleared once the turn ends, so the audit fields prove the first turn kept
    // the full copy.
    assert.match(agent.prompts[0], /TARGET_TEXT/)
    assert.equal(first.json.bridge.preset.deduped_chars, 0)
    assert.ok(first.json.bridge.preset.kept_chars > 0)

    const second = await postDsh(app.base, {
      messages: [
        { role: 'system', content: presetBody },
        { role: 'system', content: 'LIVE_TABLE_STATE_2' },
        { role: 'user', content: 'TARGET_TEXT_2' },
      ],
      dsh_session: dsh({ client_id: 'shujuku', task_id: 'database', chat_id: 'db-preset', action: 'generate' }),
    })
    assert.equal(second.response.status, 200, second.text)
    assert.equal(second.json.dsh_session.session_id, sessionId)
    assert.equal(second.json.bridge.preset.status, 'reused')
    assert.equal(second.json.bridge.preset.rule_hash.length, 64)
    assert.equal(JSON.stringify(second.json.bridge.preset).includes(presetBody), false)
  } finally { await app.close() }
})

test('preset preview endpoint never installs and unknown boundaries keep everything', async () => {
  const app = await start()
  try {
    const presetBody = 'DB_FIXED_PRESET_BODY'
    app.engine.presetConfigs.save({
      version: 1,
      presets: [{
        id: 'db', label: 'DB', client_id: 'shujuku', task_id: 'database', mode: 'exact',
        exact_hashes: [messageHash('system', presetBody)],
      }],
    })
    const preview = await fetch(`${app.base}/v1/bridge/fixed-presets/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'system', content: presetBody }, { role: 'user', content: 'TARGET' }],
        dsh_session: dsh({ client_id: 'shujuku', task_id: 'database', chat_id: 'preview-chat', action: 'generate' }),
      }),
    })
    const value = await preview.json()
    assert.equal(preview.status, 200)
    assert.equal(value.preview_only, true)
    assert.equal(value.status, 'identified')
    assert.equal(value.deduped_chars, presetBody.length)
    // Preview is read-only: no scope binding and no install record exist yet.
    assert.equal(app.engine.store.listChats().some(chat => chat.chatId === 'preview-chat'), false)

    const unknown = await postDsh(app.base, {
      messages: [{ role: 'system', content: 'UNRELATED_SYSTEM' }, { role: 'user', content: 'TARGET' }],
      dsh_session: dsh({ client_id: 'shujuku', task_id: 'database', chat_id: 'unknown-chat', action: 'generate' }),
    })
    assert.equal(unknown.response.status, 200, unknown.text)
    assert.equal(unknown.json.bridge.preset.status, 'not-found')
    assert.equal(unknown.json.bridge.preset.deduped_chars, 0)
  } finally { await app.close() }
})

test('plain compat maps a plugin without dsh_session into one fixed scope', async () => {
  const app = await start()
  try {
    app.engine.config.plainCompat = { enabled: true, clientId: 'yuzi-phone', chatId: 'yuzi-plain', taskId: 'default' }
    const body = {
      model: 'dsh-default',
      messages: [
        { role: 'system', content: 'YUZI_FIXED_PRESET' },
        { role: 'user', content: 'hello' },
      ],
    }
    const first = await postDsh(app.base, body)
    assert.equal(first.response.status, 200, first.text)
    assert.equal(first.json.dsh_session.client_id, 'yuzi-phone')
    assert.equal(first.json.dsh_session.chat_id, 'yuzi-plain')
    assert.equal(first.json.dsh_session.task_id, 'default')
    assert.match(first.json.dsh_session.session_id, /^session-st-/)

    const second = await postDsh(app.base, body)
    assert.equal(second.response.status, 200, second.text)
    assert.equal(second.json.dsh_session.session_id, first.json.dsh_session.session_id)
    assert.equal(second.json.bridge.idempotent, true)
    assert.equal(app.sessions.size, 1)
  } finally { await app.close() }
})

test('plain compat stays off unless explicitly enabled', async () => {
  const app = await start()
  try {
    const result = await postDsh(app.base, { messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(result.response.status, 400)
    assert.equal(result.json.error.code, 'persistent_protocol_required')
    assert.equal(app.sessions.size, 0)
  } finally { await app.close() }
})

test('plain compat can answer streaming clients with SSE', async () => {
  const app = await start()
  try {
    app.engine.config.plainCompat = { enabled: true, clientId: 'yuzi-phone', chatId: 'yuzi-stream', taskId: 'default' }
    const response = await fetch(`${app.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'dsh-default', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const text = await response.text()
    assert.match(text, /chat\.completion\.chunk/)
    assert.match(text, /data: \[DONE\]/)
  } finally { await app.close() }
})

test('plain compat can install a fixed group from the leading system message', async () => {
  const app = await start()
  try {
    app.engine.config.plainCompat = {
      enabled: true, clientId: 'yuzi-phone', chatId: 'yuzi-fixed', taskId: 'default',
      fixedMessageCount: 1, fixedMessageTypes: ['prefix'],
    }
    const body = {
      model: 'dsh-default',
      messages: [
        { role: 'system', content: 'YUZI_FIXED_PRESET' },
        { role: 'system', content: 'LIVE_WORLDBOOK' },
        { role: 'user', content: 'target' },
      ],
    }
    const first = await postDsh(app.base, body)
    assert.equal(first.response.status, 200, first.text)
    const chat = app.engine.store.listChats().find(item => item.clientId === 'yuzi-phone')
    assert.deepEqual(chat.fixedRules.map(rule => rule.type), ['prefix'])
    assert.match(chat.fixedRules[0].text, /YUZI_FIXED_PRESET/)
    assert.equal(app.sessions.size, 1)
  } finally { await app.close() }
})

test('plain compat never consumes the only message', async () => {
  const app = await start()
  try {
    app.engine.config.plainCompat = {
      enabled: true, clientId: 'yuzi-phone', chatId: 'yuzi-single', taskId: 'default',
      fixedMessageCount: 2, fixedMessageTypes: ['prefix', 'spec'],
    }
    const result = await postDsh(app.base, {
      model: 'dsh-default',
      messages: [{ role: 'user', content: 'only target' }],
    })
    assert.equal(result.response.status, 200, result.text)
    const chat = app.engine.store.listChats().find(item => item.chatId === 'yuzi-single')
    assert.deepEqual(chat.fixedRules, [])
  } finally { await app.close() }
})

test('bridge cleanup projects dynamic messages but protects fixed rules', async () => {
  const app = await start()
  try {
    app.engine.config.inputCleanup = { enabled: true, tags: ['bbi_image'] }
    const result = await postDsh(app.base, {
      model: 'dsh-default',
      messages: [
        { role: 'system', content: 'FIXED<bbi_image>keep-example</bbi_image>' },
        { role: 'system', content: 'LIVE<bbi_image>{"summary":1}</bbi_image>STATE' },
        { role: 'user', content: 'target' },
      ],
      dsh_session: dsh({ chat_id: 'cleanup-chat', fixed_message_count: 1, fixed_message_types: ['prefix'] }),
    })
    assert.equal(result.response.status, 200, result.text)
    assert.equal(result.json.bridge.input_cleanup.removed_blocks, 1)
    assert.match(result.json.bridge.input_cleanup.effective_messages_digest, /^[a-f0-9]{64}$/)
    const chat = app.engine.store.listChats().find(item => item.chatId === 'cleanup-chat')
    assert.match(chat.fixedRules[0].text, /keep-example/)
  } finally { await app.close() }
})

test('snapshot diff trims identical blocks after a successful turn', async () => {
  const app = await start()
  try {
    const marker = '9F3C7A1E5B2D'
    const B = `<<<STB-${marker}:B>>>`
    const E = `<<<STB-${marker}:E>>>`
    app.engine.config.snapshotDiff = { enabled: true, mode: 'marker', marker, clients: ['shujuku'], onDivergence: 'full' }
    const body = (middle, target, id) => ({
      model: 'dsh-default',
      messages: [
        { role: 'system', content: `${B}\nFIXED_A\n${E}\n${B}\n${middle}\n${E}\n${B}\nFIXED_B\n${E}` },
        { role: 'user', content: target },
      ],
      dsh_session: dsh({ client_id: 'shujuku', task_id: 'database', chat_id: 'snap-chat', request_id: id }),
    })
    const first = await postDsh(app.base, body('OLD_MIDDLE', 'target one', 'snap-1'))
    assert.equal(first.response.status, 200, first.text)
    assert.equal(first.json.bridge.dynamic_diff.status, 'no-snapshot')

    const second = await postDsh(app.base, body('NEW_MIDDLE', 'target two', 'snap-2'))
    assert.equal(second.response.status, 200, second.text)
    assert.equal(second.json.bridge.dynamic_diff.status, 'trimmed')
    assert.equal(second.json.bridge.dynamic_diff.trimmed_blocks, 2)
    assert.equal(second.json.dsh_session.session_id, first.json.dsh_session.session_id)
  } finally { await app.close() }
})

test('auto paragraph mode trims a database-style message without markers', async () => {
  const app = await start()
  try {
    app.engine.config.snapshotDiff = { enabled: true, mode: 'auto', maxBlockChars: 2000, clients: ['shujuku'], onDivergence: 'full' }
    const body = (middle, target, id) => ({
      model: 'dsh-default',
      messages: [
        { role: 'system', content: `FIXED_A\n\n${middle}\n\nFIXED_B` },
        { role: 'user', content: target },
      ],
      dsh_session: dsh({ client_id: 'shujuku', task_id: 'database', chat_id: 'auto-chat', request_id: id }),
    })
    const first = await postDsh(app.base, body('OLD_MIDDLE', 'target one', 'auto-1'))
    assert.equal(first.response.status, 200, first.text)
    assert.equal(first.json.bridge.dynamic_diff.status, 'no-snapshot')
    const second = await postDsh(app.base, body('NEW_MIDDLE', 'target two', 'auto-2'))
    assert.equal(second.response.status, 200, second.text)
    assert.equal(second.json.bridge.dynamic_diff.status, 'trimmed')
    assert.equal(second.json.bridge.dynamic_diff.mode, 'auto')
    assert.equal(second.json.bridge.dynamic_diff.trimmed_blocks, 2)
  } finally { await app.close() }
})

test('sessionOnStale recreate ignores a stale session_id after the binding was cleared', async () => {
  const app = await start()
  try {
    app.engine.config.sessionOnStale = 'recreate'
    const result = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({
        chat_id: 'stale-chat', request_id: 'stale-1',
        action: 'generate', session_id: 'session-st-deadbeef',
        fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'],
      }),
    })
    assert.equal(result.response.status, 200, result.text)
    assert.notEqual(result.json.dsh_session.session_id, 'session-st-deadbeef')
    assert.match(result.json.dsh_session.session_id, /^session-st-/)
    assert.equal(app.sessions.size, 1)
  } finally { await app.close() }
})

test('sessionOnStale does not hijack a different existing binding', async () => {
  const app = await start()
  try {
    app.engine.config.sessionOnStale = 'recreate'
    await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({ chat_id: 'bound-chat', request_id: 'b1', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }),
    })
    const result = await postDsh(app.base, {
      messages: fixedMessages(),
      dsh_session: dsh({ chat_id: 'bound-chat', request_id: 'b2', action: 'generate', session_id: 'session-st-other', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }),
    })
    assert.equal(result.response.status, 410, result.text)
    assert.equal(result.json.error.code, 'session_gone')
  } finally { await app.close() }
})

test('transient retry resends only when no user message was recorded', async () => {
  const app = await start()
  try {
    app.engine.config.transientRetry = 1
    const first = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'retry-chat', request_id: 'retry-1', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(first.response.status, 200, first.text)
    const sessionId = first.json.dsh_session.session_id
    const agent = app.sessions.get(sessionId)
    const before = agent.prompts.length
    agent.failMode = 'transient'
    const second = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'retry-chat', request_id: 'retry-2', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(second.response.status, 200, second.text)
    assert.equal(second.json.dsh_session.session_id, sessionId)
    assert.equal(agent.prompts.length, before + 2)
  } finally { await app.close() }
})

test('context overflow can recreate the session and retry the same input', async () => {
  const app = await start()
  try {
    app.engine.config.contextOverflow = 'recreate'
    const first = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'overflow-chat', request_id: 'of-1', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(first.response.status, 200, first.text)
    const oldId = first.json.dsh_session.session_id
    app.sessions.get(oldId).failMode = 'context'
    const second = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'overflow-chat', request_id: 'of-2', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(second.response.status, 200, second.text)
    assert.notEqual(second.json.dsh_session.session_id, oldId)
    assert.match(second.json.dsh_session.session_id, /^session-st-/)
    assert.equal(app.sessions.size, 2)
  } finally { await app.close() }
})

test('archived session can be replaced when enabled', async () => {
  const app = await start()
  try {
    app.engine.config.sessionOnArchived = 'recreate'
    const first = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'archive-chat', request_id: 'ar-1', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(first.response.status, 200, first.text)
    const oldId = first.json.dsh_session.session_id
    app.host.services.workspaceRegistry.archivedSessionIds = [oldId]
    const second = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'archive-chat', request_id: 'ar-2', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(second.response.status, 200, second.text)
    assert.notEqual(second.json.dsh_session.session_id, oldId)
    assert.equal(app.sessions.size, 2)
  } finally { await app.close() }
})

test('engine passes appendFormat=nonce to multi-message appends', async () => {
  const app = await start()
  try {
    app.engine.config.appendFormat = 'nonce'
    app.engine.config.appendNonce = 'ABCDEF12'
    const first = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'append-chat', request_id: 'ap-1', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(first.response.status, 200, first.text)
    const sessionId = first.json.dsh_session.session_id
    const second = await postDsh(app.base, {
      messages: [
        ...fixedMessages(),
        { role: 'assistant', content: 'previous answer' },
        { role: 'user', content: 'new target' },
      ],
      dsh_session: dsh({ chat_id: 'append-chat', request_id: 'ap-2', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }),
    })
    assert.equal(second.response.status, 200, second.text)
    const prompt = app.sessions.get(sessionId).prompts.at(-1)
    assert.match(prompt, /<<<STB-ABCDEF12>>>/)
    assert.equal(prompt.includes('ST_BRIDGE_MESSAGE'), false)
  } finally { await app.close() }
})

test('provider session blocked is not treated as context overflow', async () => {
  const app = await start()
  try {
    app.engine.config.contextOverflow = 'recreate'
    const first = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'blocked-chat', request_id: 'bl-1', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(first.response.status, 200, first.text)
    const oldId = first.json.dsh_session.session_id
    app.sessions.get(oldId).failMode = 'blocked'
    const second = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'blocked-chat', request_id: 'bl-2', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(second.response.status, 502, second.text)
    assert.equal(second.json.error.code, 'provider_session_blocked')
    assert.equal(app.sessions.size, 1)
  } finally { await app.close() }
})
