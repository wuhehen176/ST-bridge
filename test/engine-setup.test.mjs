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

  const fallback = engine.augmentProtocolAssembly(assembled, 'session-bbh-manual')
  assert.deepEqual(fallback.sections.map(section => section.name), [
    'deployment:persona-prefix',
    'baobaohui:turn-policy',
  ])
  assert.deepEqual(fallback.tools, [])
  assert.deepEqual(fallback.contexts, [])
})
