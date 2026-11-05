import assert from 'node:assert/strict'
import test from 'node:test'
import { BridgeEngine } from '../lib/engine.js'

function engineWithPresets() {
  const ctx = {
    agents: {},
    get(name) {
      if (name === 'agentPresets') {
        return { mount: async () => {} }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      }
      if (name === 'llm') {
        return { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }] } }) }
      }
      return undefined
    },
  }
  return new BridgeEngine(ctx, { agentPreset: 'st-bridge' }, { listChats: () => [] }, () => {})
}

test('bridge setup keeps preset tools, strips runtime contexts, and injects fixed rules', async () => {
  const engine = engineWithPresets()
  const sessionId = 'session-test'
  engine.runtimeFor(sessionId, [
    { type: 'prefix', role: 'system', text: 'PREFIX_RULE' },
    { type: 'spec', role: 'system', text: 'SPEC_RULE' },
  ]).dynamicSystem = [{ role: 'system', text: 'DYNAMIC_WORLDBOOK' }]
  const setup = engine.setupPreset(sessionId)
  assert.equal(typeof setup, 'function')

  const listeners = new Map()
  const agentCtx = {
    on(name, listener) {
      listeners.set(name, listener)
    },
  }
  await setup(agentCtx)
  const assemble = listeners.get('system-prompt/assemble')
  const request = listeners.get('agent/request')
  assert.equal(typeof assemble, 'function')
  assert.equal(typeof request, 'function')

  const assembled = {
    sections: [
      { name: 'deployment:persona-prefix', text: 'BRIDGE' },
      { name: 'harness:identity', text: 'SHOULD_BE_DROPPED' },
      { name: 'tool:bash', text: 'TOOL_SECTION' },
    ],
    contexts: [{ name: 'working-directory', text: 'D:\\AIGC\\MOSS' }],
    tools: [{ name: 'ops_bash' }, { name: 'ffmpeg_probe' }],
  }
  const result = await assemble({}, {}, async () => assembled)
  assert.deepEqual(result.sections.map(section => section.name), [
    'deployment:persona-prefix',
    'st-bridge:fixed-rules',
    'st-bridge:dynamic-system',
  ])
  assert.match(result.sections[1].text, /PREFIX_RULE/)
  assert.match(result.sections[1].text, /SPEC_RULE/)
  assert.match(result.sections[2].text, /DYNAMIC_WORLDBOOK/)
  assert.deepEqual(result.contexts, [])
  assert.deepEqual(result.tools, assembled.tools)
  const execute = listeners.get('tools/pre-execute')
  assert.equal(typeof execute, 'function')
  assert.deepEqual(await execute({ name: 'ops_bash' }, async () => ({ kind: 'allow' })), { kind: 'allow' })

  engine.runtimeFor(sessionId).params = { temperature: 0.6, maxTokens: 512 }
  const requestResult = await request({}, async () => ({ provider: 'p', model: 'm' }))
  assert.equal(requestResult.temperature, 0.6)
  assert.equal(requestResult.maxTokens, 512)

  engine.runtimeFor(sessionId).params = { reasoningEffort: 'max' }
  const unsupported = await request({}, async () => ({ provider: 'p', model: 'm' }))
  assert.equal(unsupported.reasoningEffort, undefined)

  engine.runtimeFor(sessionId).params = { reasoningEffort: 'high' }
  const supported = await request({}, async () => ({ provider: 'p', model: 'm' }))
  assert.equal(supported.reasoningEffort, 'high')

  const fallback = engine.augmentProtocolAssembly(assembled, 'session-st-manual')
  assert.deepEqual(fallback.sections.map(section => section.name), [
    'deployment:persona-prefix',
    'st-bridge:turn-policy',
  ])
  assert.deepEqual(fallback.tools, assembled.tools)
  assert.deepEqual(fallback.contexts, [])

  const externalRuntime = engine.runtimeFor('session-external')
  externalRuntime.externalTools = { schemas: [{ name: 'caller_tool' }], stopped: false }
  const externalListeners = new Map()
  await engine.setupPreset('session-external')({
    on(name, listener) { externalListeners.set(name, listener) },
  })
  const external = await externalListeners.get('system-prompt/assemble')({}, {}, async () => assembled)
  assert.deepEqual(external.tools, [{ name: 'caller_tool' }])
})

test('earlyTurnFailure detects a policy error that has no user message event', () => {
  const engine = engineWithPresets()
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'turn/end',
      data: {
        turn: 1,
        reason: {
          kind: 'error',
          error: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'does not support reasoning effort "max"' },
        },
      },
    },
  ]
  const failure = engine.earlyTurnFailure(events, 0)
  assert.equal(failure.ok, false)
  assert.equal(failure.code, 'UNSUPPORTED_REASONING_EFFORT')
  assert.equal(engine.earlyTurnFailure(events, 2), undefined)
})

test('turnFailure maps unsupported reasoning effort to a clear 400', () => {
  const engine = engineWithPresets()
  const error = engine.turnFailure({
    ok: false,
    message: 'provider "lunaroute" model "deepseek-4.1-flash" does not support reasoning effort "max"',
    code: 'UNSUPPORTED_REASONING_EFFORT',
  })
  assert.equal(error.status, 400)
  assert.equal(error.code, 'unsupported_reasoning_effort')
})

test('protocol snapshots shadow only owned system nodes and retain conversations', () => {
  const engine = engineWithPresets()
  const id = 'session-st-snapshot-test'
  const runtime = engine.runtimeFor(id)
  runtime.protocol = true
  runtime.dynamicSystem = [{ role: 'system', text: 'LATEST' }]
  const events = [
    { type: 'system/message', data: { message: { content: [{ type: 'text', text: '<<<FIXED_RULE old' }] } } },
    { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'USER' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ANSWER' }] } } },
    { type: 'system/message', data: { message: { content: [{ type: 'text', text: '<<<DYNAMIC_SYSTEM old' }] } } },
  ]
  const initial = structuredClone(events)
  const session = {
    surface: { nodes: [0, 1, 2, 3] },
    eventAt: seq => events[seq],
    append(type, data, options) {
      const target = options.surfaceOp.startSeq
      assert.equal(options.surfaceOp.endSeq, target)
      assert.deepEqual(options.sourceEventSeqs, [target])
      assert.equal(events[target].type, 'system/message')
      const index = this.surface.nodes.indexOf(target)
      assert.ok(index >= 0)
      this.surface.nodes[index] = events.length
      events.push({ type, data })
    },
  }
  engine.handles.set(id, { agent: { session } })
  assert.equal(engine.replaceProtocolSystemSnapshot(runtime, { turn: 8, step: 1 }), 2)
  assert.deepEqual(events.slice(0, initial.length), initial)
  assert.ok(session.surface.nodes.includes(1))
  assert.ok(session.surface.nodes.includes(2))
  // Simulate the native projection installing one leading current system node.
  const first = session.surface.nodes[0]
  session.append('system/message', { message: { content: [{ type: 'text', text: '<<<DYNAMIC_SYSTEM latest' }] } }, {
    surfaceOp: { op: 'replace', startSeq: first, endSeq: first }, sourceEventSeqs: [first],
  })
  assert.equal(engine.replaceProtocolSystemSnapshot(runtime, { turn: 9, step: 1 }), 0)
  runtime.dynamicSystem = []
  assert.equal(engine.replaceProtocolSystemSnapshot(runtime, { turn: 10, step: 1 }), 1)
  const install = text => {
    const head = session.surface.nodes[0]
    session.append('system/message', { message: { content: [{ type: 'text', text }] } }, {
      surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head],
    })
  }
  install('<skill_content name="test">SKILL_A</skill_content>')
  runtime.skillText = '<skill_content name="test">SKILL_B</skill_content>'
  runtime.skillHash = 'version-b'
  assert.equal(engine.replaceProtocolSystemSnapshot(runtime, { turn: 11, step: 1 }), 1)
  install(runtime.skillText)
  const assembled = engine.augmentProtocolAssembly({ sections: [] }, id)
  assert.equal(assembled.sections.filter(section => section.name === 'st-bridge:skill').length, 1)
  runtime.skillText = ''; runtime.skillHash = ''
  assert.equal(engine.replaceProtocolSystemSnapshot(runtime, { turn: 12, step: 1 }), 1)
  const visible = session.surface.nodes.map(seq => JSON.stringify(events[seq])).join('\n')
  assert.doesNotMatch(visible, /SKILL_A|SKILL_B/)
  assert.match(visible, /USER/)
  assert.match(visible, /ANSWER/)
})

test('legacy sessions are untouched and unsupported native projection fails explicitly', () => {
  const engine = engineWithPresets()
  assert.equal(engine.replaceProtocolSystemSnapshot(engine.runtimeFor('session-legacy'), {}), 0)
  const runtime = engine.runtimeFor('session-st-unsupported')
  runtime.protocol = true
  engine.handles.set(runtime.sessionId, { agent: { session: {} } })
  assert.throws(() => engine.replaceProtocolSystemSnapshot(runtime, { turn: 1, step: 1 }),
    error => error.code === 'system_snapshot_unavailable')
})

test('dedicated surface compacts the conversation tail separately from a protected system head',()=>{
 const engine=engineWithPresets(),events=[{type:'system/message',data:{text:'OLD_RULES'}},{type:'user/message',data:{text:'OLD_TASK'}},{type:'assistant/message',data:{text:'OLD_RESULT'}}]
 const original=structuredClone(events),nodes=[0,1,2]
 const session={surface:{nodes},eventAt:seq=>events[seq],append(type,data,options){
  if(type==='system/message') {
    assert.ok(data.turn>0,'format v4 system/message turn must be positive')
    assert.ok(Number.isInteger(data.step)&&data.step>0,'format v4 system/message step must be positive')
  }
  const op=options.surfaceOp,start=nodes.indexOf(op.startSeq),end=nodes.indexOf(op.endSeq)
  if(start===0 && events[nodes[0]].type==='system/message') assert.equal(end,0)
  const seq=events.length;events.push({type,data});nodes.splice(start,end-start+1,seq)
 }}
 engine.handles.set('session-st-dedicated-unit',{agent:{session}})
 engine.clearDedicatedHistory('session-st-dedicated-unit')
 assert.deepEqual(events.slice(0,3),original)
 assert.ok(nodes.every(seq=>seq>=3))
 assert.throws(()=>engine.assertDedicatedSurface('missing'),error=>error.code==='dedicated_surface_unavailable')
})
