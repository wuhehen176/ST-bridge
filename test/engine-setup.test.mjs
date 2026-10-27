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
  return new BridgeEngine(ctx, { agentPreset: 'baobaohui-bridge' }, { listChats: () => [] }, () => {})
}

test('bridge setup strips inherited tools/contexts and injects fixed rules', async () => {
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
    'baobaohui:fixed-rules',
    'baobaohui:dynamic-system',
  ])
  assert.match(result.sections[1].text, /PREFIX_RULE/)
  assert.match(result.sections[1].text, /SPEC_RULE/)
  assert.match(result.sections[2].text, /DYNAMIC_WORLDBOOK/)
  assert.deepEqual(result.contexts, [])
  assert.deepEqual(result.tools, [])

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

  const fallback = engine.augmentProtocolAssembly(assembled, 'session-bbh-manual')
  assert.deepEqual(fallback.sections.map(section => section.name), [
    'deployment:persona-prefix',
    'baobaohui:turn-policy',
  ])
  assert.deepEqual(fallback.tools, [])
  assert.deepEqual(fallback.contexts, [])
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
