import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BridgeEngine } from '../lib/engine.js'
import { BridgeError } from '../lib/errors.js'
import { createBridgeServer } from '../lib/server.js'
import { BridgeStore } from '../lib/store.js'
import { PairingService } from '../lib/pairing.js'
import { messageHash } from '../lib/context.js'
import { adaptBody } from '../tavern-extension/core.js'
import { inject } from '../index.js'

class MockAgent {
  constructor(sessionId) {
    this.session = { id: sessionId, snapshotEvents: () => this.events }
    this.events = []
    const hidden = new Set()
    Object.defineProperty(this.session, 'surface', { configurable:true, value: {
      get nodes() { return agent.events.flatMap((event,index)=>!hidden.has(index) && ['system/message','user/message','assistant/message'].includes(event.type) ? [index] : []) },
    } })
    const agent = this
    this.session.eventAt = index => this.events[index]
    this.session.append = (type,data,options) => {
      const current=this.session.surface.nodes,op=options.surfaceOp
      if (type==='system/message') assert.ok(data.turn > 0, 'format v4 system/message turn must be positive')
      if (op==='append') { this.events.push({type,data});return }
      const start=current.indexOf(op.startSeq),end=current.indexOf(op.endSeq)
      assert.ok(start>=0 && end>=start)
      if (start===0 && this.events[current[0]].type==='system/message') assert.equal(end,0)
      for(const index of current.slice(start,end+1)) hidden.add(index)
      this.events.push({type,data})
    }
    this.turn = 0
    this.prompts = []
    this.contents = []
    this.failMode = null
  }

  followup(message) {
    const prompt = message?.content?.filter(part => part?.type === 'text').map(part => part.text).join('\n') ?? ''
    this.prompts.push(prompt)
    this.contents.push(message?.content ?? [])
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
      agentPresets: {
        mount: async () => {},
        acquireScope: async () => ({ key: {}, [Symbol.asyncDispose]: async () => {} }),
      },
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

async function start(hostPatch = {}, configPatch = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bbh-session-'))
  // Cordis rejects undeclared service reads; plain object mocks hid this in production.
  const host = new Proxy(Object.assign(makeHost(), hostPatch), {
    get(target, key, receiver) {
      if (['skills', 'attachments'].includes(key) && !inject.includes(key)) {
        throw new Error(`cannot get property "${key}" without inject`)
      }
      return Reflect.get(target, key, receiver)
    },
  })
  const cfg = { ...makeConfig(dir), ...configPatch }
  const store = new BridgeStore(join(dir, 'state.json'))
  const engine = new BridgeEngine(host, cfg, store, () => {})
  const pairing = new PairingService({ file: join(dir, 'devices.json') })
  const bridge = createBridgeServer({ engine, config: cfg, log: () => {}, pairing })
  const port = await bridge.listen()
  return {
    base: `http://127.0.0.1:${port}`,
    engine,
    host,
    pairing,
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

test('canceled queued generation releases a following protocol sync without resubmitting', async () => {
  const app = await start({}, { transientRetry: 1 })
  try {
    const initial = await postDsh(app.base, blockedRequest('cancel-queue', 'initial'))
    const id = initial.json.dsh_session.session_id
    const agent = app.sessions.get(id)
    let accepted
    const ready = new Promise(resolve => { accepted = resolve })
    let submissions = 0
    agent.followup = message => {
      submissions++
      agent.events.push({ type: 'agent/inbox/spliced', data: {
        target: 'next-turn', start: 0, inserted: [message],
      } })
      accepted()
    }
    const generating = postDsh(app.base, blockedRequest('cancel-queue', 'canceled', id))
    await ready
    const syncing = postDsh(app.base, {
      model: 'dsh-default', messages: fixedMessages().slice(0, 2),
      dsh_session: dsh({ chat_id: 'cancel-queue', request_id: 'sync-after-cancel',
        action: 'sync_rules', session_id: id, fixed_message_count: 2,
        fixed_message_types: ['prefix', 'spec'] }),
    })
    const deadline = Date.now() + 1000
    while (app.engine.pending.size < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(app.engine.pending.size, 2, 'sync is queued behind the running request')
    agent.events.push({ type: 'agent/inbox/spliced', data: {
      target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
    } })
    const result = await generating
    assert.equal(result.response.status, 499, result.text)
    assert.equal(result.json.error.code, 'agent_request_canceled')
    const synced = await syncing
    assert.equal(synced.response.status, 200, synced.text)
    assert.equal(synced.json.dsh_session.session_id, id)
    assert.equal(submissions, 1)
    const retried = await postDsh(app.base, blockedRequest('cancel-queue', 'canceled', id))
    assert.equal(retried.response.status, 499)
    assert.equal(submissions, 1)
    assert.equal(app.engine.queues.size, 0)
  } finally { await app.close() }
})

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

test('invalid tool protocol and strict JSON schema are rejected explicitly', async () => {
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
    assert.equal(tools.json.error.code, 'invalid_tools')

    const toolRole = await postDsh(app.base, {
      messages: [{ role: 'tool', content: 'x' }],
      dsh_session: dsh({
        chat_id: 'tool-chat', request_id: 'r2', action: 'generate',
        fixed_message_count: 0, fixed_message_types: [],
      }),
    })
    assert.equal(toolRole.response.status, 400, toolRole.text)
    assert.equal(toolRole.json.error.code, 'invalid_tool_result')

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
    assert.equal(body.tool_calls, true)
    assert.deepEqual(body.external_tools, { streaming: false, execution: 'caller', tool_choice: ['auto'], parallel_execution: false })
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

test('archived session id falls back to the current valid binding', async () => {
  const app = await start()
  try {
    app.engine.config.sessionOnStale = 'recreate'
    app.engine.config.sessionOnArchived = 'recreate'
    const first = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'arch-fallback', request_id: 'af-1', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(first.response.status, 200, first.text)
    const oldId = first.json.dsh_session.session_id
    app.host.services.workspaceRegistry.archivedSessionIds = [oldId]
    const second = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'arch-fallback', request_id: 'af-2', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(second.response.status, 200, second.text)
    const newId = second.json.dsh_session.session_id
    assert.notEqual(newId, oldId)
    const third = await postDsh(app.base, { messages: fixedMessages(), dsh_session: dsh({ chat_id: 'arch-fallback', request_id: 'af-3', action: 'generate', session_id: oldId, fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) })
    assert.equal(third.response.status, 200, third.text)
    assert.equal(third.json.dsh_session.session_id, newId)
  } finally { await app.close() }
})

test('effective cwd falls back to the first DSH workspace', async () => {
  const app = await start()
  try {
    app.engine.config.cwd = 'C:/definitely-not-a-dsh-workspace'
    assert.equal(app.engine.effectiveCwd(), process.cwd())
    app.engine.config.cwd = process.cwd()
    assert.equal(app.engine.effectiveCwd(), process.cwd())
  } finally { await app.close() }
})

test('selftest endpoints exercise JSON, auth and SSE without requiring a token', async () => {
  const app = await start()
  try {
    app.engine.config.authToken = 'secret-token'
    const headers = {
      origin: 'http://tauri.localhost',
      'content-type': 'application/json',
      'x-stb-selftest': '1',
      authorization: 'Bearer secret-token',
    }
    const post = await fetch(`${app.base}/v1/bridge/selftest`, { method: 'POST', headers, body: JSON.stringify({ ping: 1 }) })
    assert.equal(post.status, 200)
    const body = await post.json()
    assert.equal(body.ok, true)
    assert.equal(body.auth_ok, true)
    assert.equal(body.test_header, '1')
    assert.deepEqual(body.body_keys, ['ping'])
    assert.equal(body.origin, 'http://tauri.localhost')

    const unauth = await fetch(`${app.base}/v1/bridge/selftest`)
    assert.equal(unauth.status, 200)
    assert.equal((await unauth.json()).auth_ok, false)

    const stream = await fetch(`${app.base}/v1/bridge/selftest/stream`)
    assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/)
    assert.match(await stream.text(), /"stream":true/)
  } finally { await app.close() }
})

test('CORS preflight allows the self-test and future pairing headers', async () => {
  const app = await start()
  try {
    const response = await fetch(`${app.base}/v1/bridge/selftest`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://tauri.localhost',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,x-stb-selftest,x-stb-pair-request,x-stb-poll-token',
      },
    })
    assert.equal(response.status, 204)
    const allowed = response.headers.get('access-control-allow-headers') ?? ''
    for (const name of ['authorization', 'content-type', 'x-stb-selftest', 'x-stb-pair-request', 'x-stb-poll-token']) {
      assert.match(allowed, new RegExp(name, 'i'))
    }
  } finally { await app.close() }
})

test('pairing endpoints deliver a device token that can chat but cannot manage', async () => {
  const app = await start()
  try {
    app.engine.config.authToken = 'shared-secret'
    const invite = app.pairing.startInvite()
    const requested = await fetch(`${app.base}/v1/bridge/pair/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: invite.code, deviceName: 'Test Phone' }),
    })
    assert.equal(requested.status, 200)
    const pending = await requested.json()
    assert.equal(pending.status, 'pending')
    app.pairing.approve(pending.pairId)

    const polled = await fetch(`${app.base}/v1/bridge/pair/status`, {
      headers: { 'x-stb-pair-request': pending.pairId, 'x-stb-poll-token': pending.pollToken },
    })
    assert.equal(polled.status, 200)
    const delivered = await polled.json()
    assert.ok(delivered.deviceToken)
    assert.equal(polled.headers.get('cache-control'), 'no-store')

    const acked = await fetch(`${app.base}/v1/bridge/pair/ack`, {
      method: 'POST',
      headers: { 'x-stb-pair-request': pending.pairId, 'x-stb-poll-token': pending.pollToken },
    })
    assert.equal((await acked.json()).status, 'active')

    const chat = await fetch(`${app.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${delivered.deviceToken}` },
      body: JSON.stringify({ messages: fixedMessages(), dsh_session: dsh({ chat_id: 'paired-chat', request_id: 'paired-1', action: 'generate', fixed_message_count: 2, fixed_message_types: ['prefix', 'spec'] }) }),
    })
    assert.equal(chat.status, 200, await chat.text())

    const status = await fetch(`${app.base}/v1/bridge/status?chat_id=paired-chat`, {
      headers: { authorization: `Bearer ${delivered.deviceToken}` },
    })
    assert.equal(status.status, 403)
    assert.equal((await status.json()).error.code, 'device_forbidden')
  } finally { await app.close() }
})

test('dedicated generation refuses missing fixed rules before creating or prompting an Agent', async () => {
  const app = await start({}, { sessionOnStale: 'recreate' })
  try {
    const session = { protocol_version: 1, session_mode: 'dedicated', chat_id: 'dedicated-unsynced',
      request_id: 'missing-rules', action: 'generate', fixed_message_count: 0, fixed_message_types: [] }
    const body = { model: 'dsh-default', messages: [{ role: 'user', content: 'Synthetic target P1' }], dsh_session: session }
    const missing = await postDsh(app.base, body)
    assert.equal(missing.response.status, 409, missing.text)
    assert.equal(missing.json.error.code, 'fixed_rules_required')
    assert.equal(app.sessions.size, 0)
    const stale = await postDsh(app.base, { ...body, dsh_session: { ...session,
      request_id: 'stale-rules', session_id: 'another-scope-session' } })
    assert.equal(stale.response.status, 409, stale.text)
    assert.equal(stale.json.error.code, 'fixed_rules_required')
    assert.equal(app.sessions.size, 0)
    const synced = await postDsh(app.base, { model: 'dsh-default',
      messages: [{ role: 'system', content: 'HOST_CONTRACT' }],
      dsh_session: { ...session, request_id: 'sync-rules', action: 'sync_rules',
        fixed_message_count: 1, fixed_message_types: ['contract'] } })
    assert.equal(synced.response.status, 200, synced.text)
    const generated = await postDsh(app.base, { ...body, dsh_session: { ...session,
      request_id: 'after-sync', session_id: synced.json.dsh_session.session_id } })
    assert.equal(generated.response.status, 200, generated.text)
    assert.equal(app.engine.runtimeFor(generated.json.dsh_session.session_id).fixedRules[0].text, 'HOST_CONTRACT')
  } finally { await app.close() }
})

test('adapter routes sync and generation to the same dedicated scope with automatic chat isolation enabled', async () => {
  const app = await start({}, { clientEndpoints: [{ id: 'baibaohui', label: '柏宝绘', taskId: 'manga', enabled: true }] })
  try {
    const session = { protocol_version: 1, session_mode: 'dedicated', client_id: 'baibaohui',
      chat_id: 'baibai-dedicated:regression', task_id: 'manga' }
    const submit = async (dsh, messages, chatId) => {
      const output = await adaptBody({ url: 'http://localhost:8000/api/backends/chat-completions/generate',
        pageOrigin: 'http://localhost:8000', base: app.base + '/v1', deviceToken: 'test-device',
        resolveEndpoint: async id => ({ id, taskId: 'manga', enabled: true }),
        autoInject: { enabled: true, prefix: 'stb-', overrideChatId: true, clients: ['baibaohui'] }, chatId,
        body: { chat_completion_source: 'custom', custom_url: app.base + '/clients/baibaohui/v1',
          model: 'dsh-default', messages, custom_include_body: JSON.stringify({ dsh_session: { ...session, ...dsh } }) } })
      const body = { ...output.body, ...JSON.parse(output.body.custom_include_body) }
      assert.equal(body.dsh_session.chat_id, session.chat_id)
      return postDsh(app.base, body)
    }
    const synced = await submit({ action: 'sync_rules', request_id: 'adapter-sync',
      fixed_message_count: 1, fixed_message_types: ['contract'] }, [{ role: 'system', content: 'HOST_CONTRACT_position_tag' }], 'chat-one')
    assert.equal(synced.response.status, 200, synced.text)
    const id = synced.json.dsh_session.session_id
    for (const source of ['chat-one', 'chat-two']) {
      const generated = await submit({ action: 'generate', request_id: 'adapter-' + source,
        session_id: id, source_chat_id: source, fixed_message_count: 0, fixed_message_types: [] },
      [{ role: 'user', content: 'Synthetic target P1' }], source)
      assert.equal(generated.response.status, 200, generated.text)
      assert.equal(generated.json.dsh_session.session_id, id)
      assert.equal(app.engine.runtimeFor(id).fixedRules[0].text, 'HOST_CONTRACT_position_tag')
    }
    assert.equal(app.sessions.size, 1)
    assert.equal(app.sessions.get(id).prompts.length, 2)
  } finally { await app.close() }
})

test('dedicated handshake, cross-chat reuse and native task surfaces keep histories isolated',async()=>{
 const app=await start()
 try {
  const session={protocol_version:1,chat_id:'baibai-dedicated:test',request_id:'dedicated-sync',action:'sync_rules',session_mode:'dedicated',fixed_message_count:1,fixed_message_types:['spec']}
  const synced=await postDsh(app.base,{model:'dsh-default',messages:[{role:'system',content:'KEEP_RULES'}],dsh_session:session})
  assert.equal(synced.response.status,200,synced.text)
  assert.deepEqual(synced.json.dsh_session.capabilities,['dedicated-v1'])
  const id=synced.json.dsh_session.session_id,agent=app.sessions.get(id)
  assert.equal(agent.prompts.length,0)
  const anotherTab=await postDsh(app.base,{model:'dsh-default',messages:[{role:'system',content:'KEEP_RULES'}],dsh_session:{...session,request_id:'dedicated-sync-tab2'}})
  assert.equal(anotherTab.response.status,200,anotherTab.text);assert.equal(anotherTab.json.dsh_session.session_id,id)
  const generate=(request,source,body)=>postDsh(app.base,{model:'dsh-default',messages:[{role:'system',content:'CURRENT_WORLD_'+source},{role:'user',content:body}],dsh_session:{...session,session_id:id,request_id:request,action:'generate',fixed_message_count:0,fixed_message_types:[],source_chat_id:source}})
  const a=await generate('dedicated-a','chat-a','STORY_A')
  assert.equal(a.response.status,200,a.text)
  const oldEvents=structuredClone(agent.events)
  const b=await generate('dedicated-b','chat-b','STORY_B')
  assert.equal(b.response.status,200,b.text)
  assert.equal(b.json.dsh_session.session_id,id)
  assert.deepEqual(agent.events.slice(0,oldEvents.length),oldEvents)
  assert.ok(agent.events.some(e=>e.data?.id==='dedicated-a'))
  assert.ok(!agent.session.surface.nodes.some(i=>agent.events[i].data?.id==='dedicated-a'))
  assert.ok(agent.session.surface.nodes.some(i=>agent.events[i].data?.id==='dedicated-b'))
  assert.equal(app.engine.runtimeFor(id).fixedRules[0].text,'KEEP_RULES')
  const repeated=await generate('dedicated-b','chat-b','STORY_B')
  assert.equal(repeated.response.status,200);assert.equal(agent.prompts.length,2)
  const conflicting=await generate('dedicated-b','chat-a','STORY_B')
  assert.equal(conflicting.response.status,409)
 } finally {await app.close()}
})

test('dedicated mode refuses unavailable native isolation and unbound Skill requests',async()=>{
 const app=await start()
 try {
  const create=app.host.agents.create.bind(app.host.agents)
  app.host.agents.create=async options=>{const result=await create(options);delete result.agent.session.surface;return result}
  const input={model:'dsh-default',messages:[{role:'system',content:'RULES'}],dsh_session:{protocol_version:1,chat_id:'dedicated-unsupported',request_id:'sync',action:'sync_rules',session_mode:'dedicated',fixed_message_count:1,fixed_message_types:['spec']}}
  const unavailable=await postDsh(app.base,input)
  assert.equal(unavailable.response.status,502,unavailable.text)
  assert.equal(unavailable.json.error.code,'dedicated_surface_unavailable')
  const skill=await postDsh(app.base,{...input,dsh_session:{...input.dsh_session,request_id:'skill',skill_id:'future-user-skill'}})
  assert.equal(skill.response.status,409);assert.equal(skill.json.error.code,'skill_binding_mismatch')
  assert.ok([...app.sessions.values()].every(agent=>agent.prompts.length===0))
 } finally {await app.close()}
})

test('bound Skill refreshes for a new request, freezes retries, and can be disabled without reset', async () => {
  let content = 'SKILL_VERSION_A'
  const presetScope = {}
  let acquired = 0
  let released = 0
  const skillRegistry = {
    get: async (name, options) => {
      // The real registry caches scope identities in a WeakMap.
      new WeakMap().set(options.scope, true)
      assert.equal(options.scope, presetScope)
      assert.ok(acquired > released)
      return { name, description: 'test', provider: 'filesystem', invocation: { userInvocable: true, modelInvocable: true }, content }
    },
  }
  const app = await start({ skills: skillRegistry }, {
    clientEndpoints: [{ id: 'yuzi-phone', label: '玉子', taskId: 'phone', skillId: 'tavern-lite', enabled: true }],
  })
  app.host.services.agentPresets.acquireScope = async id => {
    assert.equal(id, 'test-preset')
    acquired++
    return { key: presetScope, [Symbol.asyncDispose]: async () => { released++ } }
  }
  try {
    const dsh = requestId => ({ protocol_version: 1, client_id: 'yuzi-phone', chat_id: 'skill-chat', request_id: requestId, fixed_message_count: 0, fixed_message_types: [] })
    const body = requestId => ({ model: 'dsh-default', messages: [{ role: 'user', content: 'skill test' }], dsh_session: dsh(requestId) })
    const first = await postDsh(app.base, body('skill-1'))
    assert.equal(first.response.status, 200, first.text)
    assert.equal(first.json.dsh_session.skill_id, 'tavern-lite')
    assert.equal(first.json.dsh_session.skill_hash.length, 64)

    content = 'SKILL_VERSION_B'
    const changed = await postDsh(app.base, body('skill-2'))
    assert.equal(changed.response.status, 200, changed.text)
    assert.equal(changed.json.dsh_session.session_id, first.json.dsh_session.session_id)
    assert.notEqual(changed.json.dsh_session.skill_hash, first.json.dsh_session.skill_hash)
    const updated = app.engine.augmentProtocolAssembly({ sections: [] }, first.json.dsh_session.session_id)
    const activeSkills = updated.sections.filter(section => section.name === 'st-bridge:skill')
    assert.equal(activeSkills.length, 1)
    assert.match(activeSkills[0].text, /SKILL_VERSION_B/)
    assert.doesNotMatch(activeSkills[0].text, /SKILL_VERSION_A/)
    const reads = acquired
    const lookup = skillRegistry.get
    skillRegistry.get = async () => { throw new Error('file temporarily unavailable') }
    app.engine.store = new BridgeStore(app.engine.store.file) // Persisted retries also survive a fresh store instance.
    const retry = await postDsh(app.base, body('skill-1'))
    assert.equal(retry.response.status, 200, retry.text)
    assert.equal(retry.json.dsh_session.skill_hash, first.json.dsh_session.skill_hash)
    assert.equal(acquired, reads, 'cached retries must not read the current Skill file')
    skillRegistry.get = lookup
    const rewritten = await postDsh(app.base, { ...body('skill-1'), messages: [{ role: 'user', content: 'rewritten target' }] })
    assert.equal(rewritten.response.status, 409)
    assert.equal(rewritten.json.error.code, 'request_id_conflict')
    const disabled = await postDsh(app.base, { ...body('skill-off'), dsh_session: { ...dsh('skill-off'), skill_enabled: false } })
    assert.equal(disabled.response.status, 200, disabled.text)
    assert.equal(disabled.json.dsh_session.session_id, first.json.dsh_session.session_id)
    assert.equal(disabled.json.dsh_session.skill_id, undefined)
    assert.equal(acquired, reads, 'disabled requests must not read the Skill')
    const sid = first.json.dsh_session.session_id
    assert.ok(!app.engine.augmentProtocolAssembly({ sections: [] }, sid).sections.some(section => section.name === 'st-bridge:skill'))
    const enabled = await postDsh(app.base, { ...body('skill-on'), dsh_session: { ...dsh('skill-on'), skill_enabled: true, skill_id: 'tavern-lite' } })
    assert.equal(enabled.response.status, 200, enabled.text)
    assert.equal(enabled.json.dsh_session.skill_hash, changed.json.dsh_session.skill_hash)
    assert.equal(Object.keys(app.engine.store.data.skillSnapshots).length, 2, 'one stored text per version, not per request')
    const auto = body('auto'); delete auto.dsh_session.request_id
    auto.dsh_session.skill_enabled = true
    const autoOn = await postDsh(app.base, auto)
    const autoOff = await postDsh(app.base, { ...auto, dsh_session: { ...auto.dsh_session, skill_enabled: false } })
    assert.equal(autoOn.response.status, 200, autoOn.text)
    assert.equal(autoOff.response.status, 200, autoOff.text)
    assert.notEqual(autoOn.json.dsh_session.request_id, autoOff.json.dsh_session.request_id)
    assert.equal(autoOff.json.dsh_session.skill_id, undefined)

    const mismatch = await postDsh(app.base, { ...body('skill-3'), dsh_session: { ...dsh('skill-3'), skill_id: 'other-skill' } })
    assert.equal(mismatch.response.status, 409)
    assert.equal(mismatch.json.error.code, 'skill_binding_mismatch')

    const reset = await postDsh(app.base, { model: 'dsh-default', messages: [], dsh_session: { ...dsh('skill-reset'), action: 'reset' } })
    assert.equal(reset.response.status, 200, reset.text)
    const afterReset = await postDsh(app.base, body('skill-4'))
    assert.equal(afterReset.response.status, 200, afterReset.text)
    assert.equal(afterReset.json.dsh_session.skill_id, 'tavern-lite')

    app.engine.runtimes.set('session-st-skill-injected', {
      sessionId: 'session-st-skill-injected', fixedRules: [], dynamicSystem: [], params: {},
      protocol: true, skillText: '<skill_content name="tavern-lite">TEST_SKILL</skill_content>', skillHash: 'hash',
    })
    const assembled = app.engine.augmentProtocolAssembly({ sections: [] }, 'session-st-skill-injected')
    assert.ok(assembled.sections.some(section => section.name === 'st-bridge:skill' && section.text.includes('TEST_SKILL')))
    assert.equal(acquired, released)
  } finally { await app.close() }
})

test('simultaneous retries keep the accepted Skill version while new requests read updates', async () => {
  let content = 'VERSION_A', reads = 0
  const app = await start({ skills: { get: async name => {
    reads++
    return { name, provider: 'filesystem', invocation: { userInvocable: true }, content }
  } } }, { clientEndpoints: [{ id: 'yuzi-phone', label: 'test', taskId: 'phone', skillId: 'tavern-lite', enabled: true }] })
  app.host.services.agentPresets.acquireScope = async () => ({ key: {}, [Symbol.asyncDispose]: async () => {} })
  const body = id => ({ model: 'dsh-default', messages: [{ role: 'user', content: 'target' }], dsh_session: {
    protocol_version: 1, client_id: 'yuzi-phone', chat_id: 'skill-concurrency', request_id: id,
    skill_enabled: true, skill_id: 'tavern-lite', fixed_message_count: 0, fixed_message_types: [],
  } })
  try {
    const firstPromise = postDsh(app.base, body('same'))
    for (let i = 0; i < 100 && !app.engine.pendingSkills.size; i++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(app.engine.pendingSkills.size, 1)
    content = 'VERSION_B'
    const [first, duplicate] = await Promise.all([firstPromise, postDsh(app.base, body('same'))])
    assert.equal(first.response.status, 200, first.text)
    assert.equal(duplicate.response.status, 200, duplicate.text)
    assert.equal(first.json.dsh_session.skill_hash, duplicate.json.dsh_session.skill_hash)
    assert.equal(reads, 1)
    assert.equal(app.engine.pendingSkills.size, 0)
    const next = await postDsh(app.base, body('next'))
    assert.equal(next.response.status, 200, next.text)
    assert.notEqual(next.json.dsh_session.skill_hash, first.json.dsh_session.skill_hash)
    assert.equal(app.sessions.size, 1)
    assert.equal(reads, 2)
    const invalid = body('invalid'); invalid.dsh_session.skill_enabled = 'false'
    assert.equal((await postDsh(app.base, invalid)).response.status, 400)
  } finally { await app.close() }
})

test('bound skill lookup releases preset leases on failure and fails closed without scope support', async () => {
  const app = await start({ skills: { get: async () => { throw new Error('provider failed') } } }, {
    clientEndpoints: [{ id: 'yuzi-phone', label: '玉子', taskId: 'phone', skillId: 'tavern-lite', enabled: true }],
  })
  let released = 0
  app.host.services.agentPresets.acquireScope = async () => ({
    key: {}, [Symbol.asyncDispose]: async () => { released++ },
  })
  const body = requestId => ({ model: 'dsh-default', messages: [{ role: 'system', content: 'RULES' }],
    dsh_session: { protocol_version: 1, client_id: 'yuzi-phone', chat_id: 'skill-error', request_id: requestId,
      action: 'sync_rules', fixed_message_count: 1, fixed_message_types: ['spec'] } })
  try {
    const failed = await postDsh(app.base, body('failed'))
    assert.equal(failed.response.status, 503)
    assert.equal(failed.json.error.code, 'skill_load_failed')
    assert.equal(released, 1)
    delete app.host.services.agentPresets.acquireScope
    const unsupported = await postDsh(app.base, body('unsupported'))
    assert.equal(unsupported.response.status, 503)
    assert.equal(unsupported.json.error.code, 'skill_scope_unavailable')
    assert.equal(app.sessions.size, 0)
  } finally { await app.close() }
})

test('dedicated atlas prefix survives history clearing and restart, updates revisions and rejects a lost prefix', async () => {
  let admitted = 0
  const app = await start({ attachments: { admitPromptContent: async content => { admitted++;return content } } })
  const png = 'data:image/png;base64,AAAA'
  const base = { protocol_version: 1, session_mode: 'dedicated', chat_id: 'atlas-retention', action: 'generate',
    fixed_message_count: 0, fixed_message_types: [] }
  const atlasMessage = text => ({ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: png } }] })
  const generate = (request, hash, messages, indices = []) => postDsh(app.base, { model: 'dsh-default', messages,
    dsh_session: { ...base, request_id: request, layout_atlas: { hash, message_indices: indices } } })
  try {
    const initial = await postDsh(app.base, { model: 'dsh-default', messages: [{ role: 'system', content: 'RULES' },
      atlasMessage('FULL_ATLAS_A'), { role: 'system', content: 'WHITELIST_A' }, { role: 'user', content: 'STORY_A' }],
    dsh_session: { ...base, request_id: 'atlas-first', fixed_message_count: 1, fixed_message_types: ['contract'],
      layout_atlas: { hash: 'a'.repeat(64), message_indices: [1] } } })
    assert.equal(initial.response.status, 200, initial.text)
    assert.equal(initial.json.dsh_session.layout_atlas_hash, 'a'.repeat(64))
    const id = initial.json.dsh_session.session_id, agent = app.sessions.get(id)
    const active = () => agent.session.surface.nodes.map(seq => agent.session.eventAt(seq))
    const prefix = active().find(event => event.type === 'user/message' && event.data.id.startsWith('layout-atlas:'))
    assert.ok(prefix)
    assert.equal(admitted, 1)
    assert.ok(agent.contents[0].every(block => block.type === 'text'))
    const second = await generate('atlas-second', 'a'.repeat(64), [{ role: 'system', content: 'WHITELIST_B' }, { role: 'user', content: 'STORY_B' }])
    assert.equal(second.response.status, 200, second.text)
    assert.equal(admitted, 1)
    assert.ok(active().includes(prefix))
    assert.ok(!active().some(event => event.data.id === 'atlas-first'))
    assert.equal(app.engine.runtimeFor(id).fixedRules[0].text, 'RULES')
    app.engine.store = new BridgeStore(app.engine.store.file)
    app.engine.runtimes.clear()
    const resumed = await generate('atlas-resume', 'a'.repeat(64), [{ role: 'user', content: 'STORY_C' }])
    assert.equal(resumed.response.status, 200, resumed.text)
    assert.ok(active().includes(prefix))
    assert.equal(admitted, 1)
    const updated = await generate('atlas-update', 'b'.repeat(64), [atlasMessage('FULL_ATLAS_B'), { role: 'user', content: 'STORY_D' }], [0])
    assert.equal(updated.response.status, 200, updated.text)
    assert.equal(admitted, 2)
    assert.ok(!active().includes(prefix))
    const newer = active().find(event => event.type === 'user/message' && event.data.id.startsWith('layout-atlas:'))
    assert.ok(newer)
    const seq = agent.session.surface.nodes.find(seq => agent.session.eventAt(seq) === newer)
    agent.session.append('system/message', { turn: 4, step: 1, message: { id: 'compaction', role: 'system', content: [], source: { kind: 'system-prompt' } } },
      { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    const count = agent.prompts.length
    const missing = await generate('atlas-missing', 'b'.repeat(64), [{ role: 'user', content: 'STORY_E' }])
    assert.equal(missing.response.status, 410, missing.text)
    assert.equal(missing.json.error.code, 'layout_atlas_required')
    assert.equal(agent.prompts.length, count)
    const chat = app.engine.store.listChats().find(chat => chat.sessionId === id)
    const done = app.engine.store.getRequest(chat.scopeKey, 'atlas-second')
    app.engine.store.putRequest(chat.scopeKey, 'atlas-second', { ...done, status: 'pending' })
    const repeated = await generate('atlas-second', 'a'.repeat(64), [{ role: 'system', content: 'WHITELIST_B' }, { role: 'user', content: 'STORY_B' }])
    assert.equal(repeated.response.status, 200, repeated.text)
    assert.equal(repeated.json.dsh_session.layout_atlas_hash, 'a'.repeat(64))
  } finally { await app.close() }
})

test('user image parts are admitted and passed to the DSH Agent', async () => {
  const app = await start({ attachments: { admitPromptContent: async content => content } })
  try {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII='
    const result = await postDsh(app.base, {
      model: 'dsh-default',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'see image' }, { type: 'image_url', image_url: { url: png } }] }],
      dsh_session: { protocol_version: 1, chat_id: 'image-chat', request_id: 'image-1', fixed_message_count: 0, fixed_message_types: [] },
    })
    assert.equal(result.response.status, 200, result.text)
    const content = [...app.sessions.values()].flatMap(agent => agent.contents).at(-1)
    assert.ok(content.some(part => part.type === 'image'))
    assert.ok(content.some(part => part.type === 'text' && part.text.includes('see image')))
  } finally { await app.close() }
})


for (const [mode,explicit] of [['dedicated',true],['dedicated',false],[undefined,true]]) {
  test(`sync_rules recreates archived ${mode ?? 'ordinary'} sessions, explicit=${explicit}`,async()=>{
    const app=await start({}, {sessionOnArchived:'recreate'})
    try {
      const sync=(id,content,sessionId)=>({model:'dsh-default',messages:[{role:'system',content}],
        dsh_session:dsh({chat_id:'archive-sync',request_id:id,action:'sync_rules',
          ...(mode ? {session_mode:mode} : {}),...(sessionId ? {session_id:sessionId} : {}),
          fixed_message_count:1,fixed_message_types:['spec']})})
      const first=await postDsh(app.base,sync('archive-initial','OLD_RULES'))
      assert.equal(first.response.status,200,first.text)
      const oldId=first.json.dsh_session.session_id,oldAgent=app.sessions.get(oldId)
      const oldEvents=structuredClone(oldAgent.events)
      app.host.services.workspaceRegistry.archivedSessionIds=[oldId]
      const request=sync('archive-recover','NEW_RULES',explicit ? oldId : undefined)
      const repaired=await postDsh(app.base,request)
      assert.equal(repaired.response.status,200,repaired.text)
      const newId=repaired.json.dsh_session.session_id
      assert.notEqual(newId,oldId);assert.equal(app.sessions.size,2)
      assert.deepEqual(app.host.services.workspaceRegistry.archivedSessionIds,[oldId])
      assert.deepEqual(oldAgent.events,oldEvents)
      assert.equal(app.sessions.get(newId).prompts.length,0)
      assert.equal(app.engine.runtimeFor(newId).fixedRules[0].text,'NEW_RULES')
      const chat=Object.values(app.engine.store.data.chats).find(entry=>entry.chatId==='archive-sync')
      assert.equal(chat.sessionId,newId)
      assert.ok(chat.previousSessions.some(entry=>entry.sessionId===oldId && entry.reason==='sync_rules'))
      const retried=await postDsh(app.base,request)
      assert.equal(retried.response.status,200,retried.text)
      assert.equal(retried.json.dsh_session.session_id,newId)
      assert.equal(app.sessions.size,2)
      const generated=await postDsh(app.base,{model:'dsh-default',messages:[{role:'user',content:'CURRENT_STORY'}],
        dsh_session:{...request.dsh_session,request_id:'archive-generate',action:'generate',session_id:newId,fixed_message_count:0,fixed_message_types:[]}})
      assert.equal(generated.response.status,200,generated.text)
      assert.equal(generated.json.dsh_session.session_id,newId)
      assert.equal(app.sessions.get(newId).prompts.length,1)
    } finally {await app.close()}
  })
}

test('sync_rules keeps archive rejection when automatic recreation is disabled',async()=>{
  const app=await start({}, {sessionOnArchived:'error'})
  try {
    const request={model:'dsh-default',messages:[{role:'system',content:'RULES'}],dsh_session:dsh({chat_id:'archive-deny',request_id:'initial',action:'sync_rules',session_mode:'dedicated',fixed_message_count:1,fixed_message_types:['spec']})}
    const first=await postDsh(app.base,request),oldId=first.json.dsh_session.session_id
    app.host.services.workspaceRegistry.archivedSessionIds=[oldId]
    const result=await postDsh(app.base,{...request,dsh_session:{...request.dsh_session,request_id:'denied',session_id:oldId}})
    assert.equal(result.response.status,409,result.text);assert.equal(result.json.error.code,'session_archived')
    assert.equal(app.sessions.size,1)
    assert.equal(Object.values(app.engine.store.data.chats)[0].sessionId,oldId)
  } finally {await app.close()}
})

test('failed archived sync replacement preserves the previous binding and fixed rules',async()=>{
  const app=await start({}, {sessionOnArchived:'recreate'})
  try {
    const request={model:'dsh-default',messages:[{role:'system',content:'ORIGINAL_RULES'}],dsh_session:dsh({chat_id:'archive-failed',request_id:'initial',action:'sync_rules',session_mode:'dedicated',fixed_message_count:1,fixed_message_types:['spec']})}
    const first=await postDsh(app.base,request),oldId=first.json.dsh_session.session_id
    const before=structuredClone(Object.values(app.engine.store.data.chats)[0])
    app.host.services.workspaceRegistry.archivedSessionIds=[oldId]
    app.host.agents.create=async()=>{throw new Error('simulated create failure')}
    const result=await postDsh(app.base,{...request,messages:[{role:'system',content:'REPLACEMENT_RULES'}],dsh_session:{...request.dsh_session,request_id:'failed',session_id:oldId}})
    assert.equal(result.response.status,500,result.text)
    assert.equal(result.json.error.code,'session_create_failed')
    const {requests,...after}=Object.values(app.engine.store.data.chats)[0]
    const {requests:previousRequests,...unchanged}=before
    assert.deepEqual(after,unchanged)
    assert.equal(requests.failed.errorCode,'session_create_failed')
    assert.equal(app.sessions.size,1)
  } finally {await app.close()}
})


test('sync_rules does not recreate a session for an unrelated 409 conflict',async()=>{
  const app=await start({}, {sessionOnArchived:'recreate'})
  try {
    const request={model:'dsh-default',messages:[{role:'system',content:'RULES'}],dsh_session:dsh({chat_id:'other-conflict',request_id:'initial',action:'sync_rules',session_mode:'dedicated',fixed_message_count:1,fixed_message_types:['spec']})}
    const first=await postDsh(app.base,request)
    assert.equal(first.response.status,200,first.text)
    const oldId=first.json.dsh_session.session_id
    app.engine.ensureSession=async()=>{throw new BridgeError(409,'session_unavailable','simulated unrelated conflict')}
    const result=await postDsh(app.base,{...request,dsh_session:{...request.dsh_session,request_id:'conflict',session_id:oldId}})
    assert.equal(result.response.status,409,result.text);assert.equal(result.json.error.code,'session_unavailable')
    assert.equal(app.sessions.size,1)
    assert.equal(Object.values(app.engine.store.data.chats)[0].sessionId,oldId)
  } finally {await app.close()}
})
