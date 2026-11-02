// Run after deployment. Creates an isolated DSH chat and uses synthetic results only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const base = (process.argv[2] || 'http://127.0.0.1:43121/v1').replace(/\/$/, '')
const token = process.env.ST_BRIDGE_TOKEN
if (!token) throw new Error('Set ST_BRIDGE_TOKEN to the paired bridge device token before running.')
const chatId = `external-tools-smoke-${randomUUID()}`
const body = {
  model: 'dsh-default', stream: false, tool_choice: 'auto', parallel_tool_calls: false,
  tools: [{ type: 'function', function: { name: 'insertRowFixture', description: 'Synthetic test. Caller simulates insertion; no real database.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }],
  messages: [{ role: 'user', content: 'This is a protocol test. Call insertRowFixture exactly once with value BRIDGE_TOOL_FIXTURE. After the tool result, reply exactly TOOL_BRIDGE_OK. Do not describe or simulate a call in text.' }],
  dsh_session: { protocol_version: 1, client_id: 'shujuku', task_id: 'tool-smoke', chat_id: chatId, action: 'generate', fixed_message_count: 0, fixed_message_types: [] },
}
let callCount = 0, sid
for (let step = 0; step < 5; step++) {
  body.dsh_session.request_id = `smoke-${step}`
  const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result.error ?? result))
  if (sid) assert.equal(result.dsh_session?.session_id, sid)
  sid = result.dsh_session?.session_id
  assert.ok(sid)
  const choice = result.choices[0]
  if (choice.finish_reason !== 'tool_calls') {
    assert.equal(callCount, 1)
    assert.equal(choice.message.content?.trim(), 'TOOL_BRIDGE_OK')
    console.log(`PASS: one native call and final answer, same session ${sid}; no real database modified.`)
    process.exit(0)
  }
  assert.equal(choice.message.tool_calls.length, 1)
  const call = choice.message.tool_calls[0]
  assert.equal(call.function.name, 'insertRowFixture')
  assert.deepEqual(JSON.parse(call.function.arguments), { value: 'BRIDGE_TOOL_FIXTURE' })
  callCount++
  assert.equal(callCount, 1)
  body.messages.push(choice.message, { role: 'tool', tool_call_id: call.id, content: '{"synthetic":true,"inserted":true}' })
  body.dsh_session.session_id = sid
}
throw new Error('Tool round-trip did not finish within 5 requests')
