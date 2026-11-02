// Optional local DSH runtime probe. No model, network request, or real database write.
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
if (!root) throw new Error('Usage: node tools/probe-native-tools.mjs <DSH node_modules/@deepseek-ai>')
const load = name => import(pathToFileURL(join(resolve(root), name, 'lib/index.js')).href)
const { Context } = await load('cordis')
const { createScope } = await load('dsh-scope')
const { ToolRuntime } = await load('dsh-tools')
const ctx = new Context()
ctx.provide('systemPrompt', { tools() { return () => {} } })
const runtime = new ToolRuntime(ctx)
const agent = { id: 'bridge-native-probe' }
const scope = createScope(ctx, agent)
agent.ctx = scope.ctx
let release
let invoked = 0
const definition = {
  name: 'insertRow', description: 'Synthetic fixture only',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
  isConcurrencySafe: () => false,
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async (args, exec) => {
    invoked++
    assert.equal(args.value, 'fixture')
    assert.equal(exec.callId, 'probe-call')
    return new Promise(resolve => { release = resolve })
  },
}
const offGlobal = ctx.tools.register({ ...definition, name: 'inherited_shell', execute: () => { throw new Error('Inherited tools must stay hidden') } })
const offMode = scope.ctx.tools.presentAs('native')
const offMask = scope.ctx.tools.restrict({ allow: [] })
const offTool = scope.ctx.tools.register(definition)
assert.deepEqual(runtime.wireSchemas(agent).schemas.map(s => s.name), ['insertRow'])
assert.equal(runtime.executionMode({ name: 'insertRow', agent, arguments: { value: 'fixture' } }).kind, 'exclusive')
const denied = await scope.ctx.tools.execute({ name: 'inherited_shell', callId: 'blocked-call', arguments: {}, agent, signal: new AbortController().signal })
assert.equal(denied.isError, true)
let done = false
const pending = scope.ctx.tools.execute({ name: 'insertRow', callId: 'probe-call', arguments: { value: 'fixture' }, agent, signal: new AbortController().signal }).then(result => { done = true; return result })
for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10))
assert.equal(invoked, 1)
assert.equal(done, false)
release('{"inserted":true}')
const result = await pending
assert.equal(result.isError, false, JSON.stringify(result))
assert.equal(result.value, '{"inserted":true}')
offTool()
assert.deepEqual(runtime.wireSchemas(agent).schemas, [])
offMask(); offMode(); offGlobal()
await scope.dispose()
console.log('PASS: native scoped schema / inherited-tool isolation / async wait / caller-result return / cleanup')
