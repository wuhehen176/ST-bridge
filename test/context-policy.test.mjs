import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { normalizeMessages } from '../lib/context.js'
import { ContextProfiles, parseContextRequest, validateProfiles, applyContextProfile, contextAudit } from '../lib/context-policy.js'
import { adaptBody, sourceParts, installAdapter, localBase, scopeKey, cleanImageMessages, messageText } from '../tavern-extension/core.js'

const profile = { id: 'short', label: '测试精简档', client_id: 'baibai-image', task_id: 'default', replace: { spec: 'SHORT_RULE' } }
const session = { protocol_version: 1, chat_id: 'chat-one', request_id: 'r1', fixed_message_count: 0, fixed_message_types: [] }
const base = 'http://127.0.0.1:43121/v1'
const proxy = 'http://localhost:8000/api/backends/chat-completions/generate'

test('profiles are private, scope-bound, protect protocol slots and back up previous definitions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-policy-'))
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }) })
  const registry = new ContextProfiles(join(dir, 'context-profiles.json'))
  assert.equal(registry.resolve('original', {}).id, 'original')
  registry.save({ version: 1, profiles: [profile] })
  const listed = registry.list()
  assert.equal(JSON.stringify(listed).includes('SHORT_RULE'), false)
  assert.equal(registry.resolve('short', { clientId: 'baibai-image', taskId: 'default' }).replace.spec, 'SHORT_RULE')
  assert.throws(() => registry.resolve('short', { clientId: 'shujuku', taskId: 'default' }), /不匹配/)
  assert.throws(() => validateProfiles({ version: 1, profiles: [{ ...profile, replace: { contract: 'break output protocol' } }] }), /spec\/check/)
  registry.save({ version: 1, profiles: [] })
  assert.ok(readdirSync(dir).some(name => name.includes('.bak-')))
})

test('source attribution validates exact ranges, hashes and coverage without copying prompt text into audit', async () => {
  const raw = [{ role: 'system', content: 'before\nPRIVATE_WORLD_TEXT\nafter' }, { role: 'user', content: 'EXACT_TARGET_TEXT' }]
  const entries = [{ content: 'PRIVATE_WORLD_TEXT', uid: 7, world: 'test-book', comment: '人物条目' }]
  const sources = await sourceParts(raw, entries)
  assert.deepEqual(await sourceParts([{ role: 'system', content: null }, ...raw], []), [])
  assert.deepEqual(await sourceParts(raw, [...entries, { ...entries[0], uid: 8 }]), [])
  const { messages } = normalizeMessages(raw)
  const request = parseContextRequest({ version: 1, sources }, messages)
  const audit = contextAudit(messages, 0, request, { id: 'original', label: 'original', replace: {} }, [], [])
  assert.equal(audit.parts.reduce((n, p) => n + p.chars, 0), audit.input_chars)
  assert.ok(audit.parts.every(p => p.action === 'keep'))
  assert.equal(audit.parts.find(p => p.kind === 'worldbook').entry_id, '7')
  assert.equal(JSON.stringify(audit).includes('PRIVATE_WORLD_TEXT'), false)
  assert.equal(JSON.stringify(audit).includes('EXACT_TARGET_TEXT'), false)
  assert.throws(() => parseContextRequest({ version: 1, sources: [{ ...sources[0], message_hash: 'stale' }] }, messages), /Hash/)
  assert.throws(() => parseContextRequest({ version: 1, sources: [...sources, ...sources] }, messages), /重叠/)
  const rules = [{ type: 'prefix', role: 'system', text: 'PREFIX' }, { type: 'contract', role: 'system', text: 'JSON_FORMAT' }, { type: 'spec', role: 'system', text: 'LONG_RULE' }]
  assert.deepEqual(applyContextProfile(rules, profile).map(r => r.text), ['PREFIX', 'JSON_FORMAT', 'SHORT_RULE'])
  assert.throws(() => applyContextProfile([], profile), /不能猜测/)
})

test('adapter targets exact configured local destination only; message bodies and other body fields remain identical', async () => {
  const body = { chat_completion_source: 'custom', custom_url: base, custom_include_body: JSON.stringify({ dsh_session: session, top_k: 50 }), messages: [{ role: 'user', content: 'full body' }], stream: false }
  const original = structuredClone(body)
  for (const custom_url of ['https://api.example.com/v1', 'http://127.0.0.1:8317/v1', 'http://localhost:43121/v1', 'http://127.0.0.1:43121/other']) {
    assert.equal(await adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body: { ...body, custom_url }, base }), null)
  }
  for (const bad of ['https://127.0.0.1:43121/v1', 'http://evil.test/v1', 'http://user:secret@127.0.0.1:43121/v1', base + '?secret=x']) assert.throws(() => localBase(bad))
  const result = await adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body, base, selections: { [scopeKey(session)]: 'short' } })
  assert.deepEqual(body, original)
  assert.equal(result.body.messages, body.messages)
  const included = JSON.parse(result.body.custom_include_body)
  assert.deepEqual(included.dsh_session, session)
  assert.equal(included.top_k, 50)
  assert.equal(included.dsh_context.profile_id, 'short')
  assert.equal(await adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body: { ...body, custom_include_body: '{}' }, base }), null)
  await assert.rejects(adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body: { ...body, custom_exclude_body: '["dsh_context"]' }, base }), /不能排除/)
})

test('adapter honors include-body messages, direct requests, sync/reset exclusions and existing fetch chain', async () => {
  const wire = { messages: [{ role: 'user', content: 'base' }], dsh_session: session }
  const direct = await adaptBody({ url: base + '/chat/completions', pageOrigin: 'http://localhost:8000', body: wire, base })
  assert.equal(direct.body.messages, wire.messages)
  for (const action of ['sync_rules', 'reset']) assert.equal(await adaptBody({ url: base + '/chat/completions', pageOrigin: 'http://localhost:8000', body: { ...wire, dsh_session: { ...session, action } }, base }), null)
  const overridden = await adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body: { chat_completion_source: 'custom', custom_url: base, messages: wire.messages, custom_include_body: JSON.stringify({ ...wire, messages: [{ role: 'user', content: 'override' }] }) }, base })
  assert.equal(overridden.preview.messages[0].chars, 'override'.length)
  const calls = []
  const host = { location: { origin: 'http://localhost:8000', href: 'http://localhost:8000/' }, fetch: async (...args) => { calls.push(args); return new Response('{}', { status: 200 }) } }
  const originalFetch = host.fetch
  const dispose = installAdapter(host, { enabled: () => true, base: () => base, selections: () => ({}), entries: () => [], onPreview() {} })
  const unrelated = { method: 'POST', body: 'private irrelevant request' }
  await host.fetch('https://external.test/v1/chat/completions', unrelated)
  assert.equal(calls[0][1], unrelated)
  const request = new Request(base + '/chat/completions', { method: 'POST', headers: { 'x-custom': 'keep' }, body: JSON.stringify(wire) })
  await host.fetch(request)
  assert.equal(request.bodyUsed, false)
  assert.equal(calls[1][0], request)
  assert.ok(JSON.parse(calls[1][1].body).dsh_context)
  dispose()
  assert.equal(host.fetch, originalFetch)
})

test('Tavern installer changes only its own three code files and keeps user settings intact', t => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-installer-'))
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }) })
  const target = join(root, 'ST-Bridge-Context')
  mkdirSync(target)
  writeFileSync(join(target, 'index.js'), '// previous version')
  writeFileSync(join(root, 'settings.json'), 'PRIVATE_USER_SETTINGS')
  const args = ['install-tavern.mjs', '--extensions-dir', root]
  const check = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }))
  assert.equal(check.readOnly, true)
  assert.equal(readFileSync(join(target, 'index.js'), 'utf8'), '// previous version')
  const installed = JSON.parse(execFileSync(process.execPath, [...args, '--apply'], { encoding: 'utf8' }))
  assert.equal(installed.installed, true)
  assert.equal(installed.files, 3)
  assert.equal(readFileSync(join(root, 'settings.json'), 'utf8'), 'PRIVATE_USER_SETTINGS')
  assert.equal(readFileSync(join(installed.backup, 'index.js'), 'utf8'), '// previous version')
  assert.deepEqual(readFileSync(join(target, 'core.js')), readFileSync('tavern-extension/core.js'))
})

test('image cleanup removes paired/nested/orphan markers without swallowing prose or changing fixed rules', () => {
  const raw = [
    { role: 'system', content: '固定格式示例 <bbi_image>KEEP_RULE_EXAMPLE</bbi_image>' },
    { role: 'assistant', name: '角色', content: '前\n<bbi_image><tag>{"layout":"13","caption":"PRIVATE_LAYOUT"}</tag></bbi_image>\n后' },
    { role: 'system', content: '记忆<bbi_image>a<bbi_image>b</bbi_image></bbi_image>继续' },
    { role: 'user', content: 'A<bbi_image>\n保留正文<bbi_image>old</bbi_image>B</bbi_image_extra><bbi_image/>C' },
    { role: 'user', content: '孤立闭标签</bbi_image>保持' },
  ]
  const saved = structuredClone(raw)
  const result = cleanImageMessages(raw, 1)
  assert.deepEqual(raw, saved)
  assert.equal(result.messages[0], raw[0])
  assert.equal(result.messages[1].content, '前\n\n后')
  assert.equal(result.messages[1].name, '角色')
  assert.equal(result.messages[2].content, '记忆继续')
  assert.equal(result.messages[3].content, 'A\n保留正文B</bbi_image_extra>C')
  assert.equal(result.messages[4].content, '孤立闭标签保持')
  assert.equal(result.cleanup.removed_chars, result.cleanup.before_chars - result.cleanup.after_chars)
  assert.ok(result.cleanup.removed_regions > 0)
  const again = cleanImageMessages(result.messages, 1)
  assert.equal(again.messages, result.messages)
  assert.equal(again.cleanup.removed_chars, 0)
})

test('image cleanup spans text parts, preserves their metadata and computes source hashes after cleanup', async () => {
  const raw = [{ role: 'user', content: [{ type: 'text', text: '前<bbi_image>' }, '{"layout":"4"}', { type: 'text', text: '</bbi_image>后', cache_control: { type: 'ephemeral' } }] }]
  const copy = structuredClone(raw)
  const result = cleanImageMessages(raw)
  assert.deepEqual(raw, copy)
  assert.equal(messageText(result.messages[0]), '前\n\n后')
  assert.deepEqual(result.messages[0].content[2].cache_control, { type: 'ephemeral' })
  const sources = await sourceParts(result.messages, [{ content: '后', uid: 1 }])
  const request = parseContextRequest({ version: 1, sources }, normalizeMessages(result.messages).messages)
  assert.equal(request.sources[0].start, 3)
})

test('one sending boundary cleans database, phone and future clients, including messages overridden by custom body', async () => {
  for (const client_id of ['shujuku', 'yuzi-phone', 'another-plugin']) {
    const messages = [{ role: 'user', content: '正文<bbi_image>{"caption":"PRIVATE_OLD_IMAGE"}</bbi_image>结尾' }]
    const body = { chat_completion_source: 'custom', custom_url: base, messages: [{ role: 'user', content: 'unused old copy' }], temperature: 0.6, custom_include_body: JSON.stringify({ messages, response_format: { type: 'json_object' }, dsh_session: { ...session, client_id } }) }
    const copy = structuredClone(body)
    const result = await adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body, base })
    assert.deepEqual(body, copy)
    const included = JSON.parse(result.body.custom_include_body)
    assert.equal(included.messages[0].content, '正文结尾')
    assert.deepEqual(result.body.messages, included.messages)
    assert.deepEqual(included.dsh_session, { ...session, client_id })
    assert.deepEqual(included.response_format, { type: 'json_object' })
    assert.equal(result.body.temperature, 0.6)
    assert.ok(result.preview.cleanup.removed_chars > 0)
    assert.equal(JSON.stringify(result.body).includes('PRIVATE_OLD_IMAGE'), false)
    const remote = { ...body, custom_url: 'https://external.test/v1' }
    assert.equal(await adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body: remote, base }), null)
    assert.ok(remote.custom_include_body.includes('PRIVATE_OLD_IMAGE'))
    const direct = await adaptBody({ url: `${base}/chat/completions`, pageOrigin: 'http://localhost:8000', body: { messages, dsh_session: { ...session, client_id } }, base })
    assert.equal(direct.body.messages[0].content, '正文结尾')
  }
})

test('auto injection creates a per-chat dsh_session and rewrites listed clients only', async () => {
  const auto = {
    enabled: true,
    clientId: 'yuzi-phone',
    taskId: 'default',
    prefix: 'stb-',
    overrideChatId: true,
    clients: ['shujuku', 'yuzi-phone'],
    fixedMessageCount: 0,
    fixedMessageTypes: [],
  }
  const plain = { messages: [{ role: 'user', content: 'hello' }] }
  const injected = await adaptBody({ url: base + '/chat/completions', pageOrigin: 'http://localhost:8000', body: plain, base, autoInject: auto, chatId: 'chat-42' })
  assert.equal(injected.body.dsh_session.chat_id, 'stb-chat-42')
  assert.equal(injected.body.dsh_session.client_id, 'yuzi-phone')
  assert.equal(plain.dsh_session, undefined)

  const staticSession = { protocol_version: 1, client_id: 'shujuku', chat_id: 'shujuku-db', task_id: 'database', fixed_message_count: 0, fixed_message_types: [] }
  const rewritten = await adaptBody({ url: base + '/chat/completions', pageOrigin: 'http://localhost:8000', body: { messages: [{ role: 'user', content: 'x' }], dsh_session: staticSession }, base, autoInject: auto, chatId: 'chat-42' })
  assert.equal(rewritten.body.dsh_session.chat_id, 'stb-chat-42')
  assert.equal(rewritten.body.dsh_session.task_id, 'database')

  const baibai = { protocol_version: 1, client_id: 'baibai-image', chat_id: 'keep-me', fixed_message_count: 0, fixed_message_types: [] }
  const untouched = await adaptBody({ url: base + '/chat/completions', pageOrigin: 'http://localhost:8000', body: { messages: [{ role: 'user', content: 'x' }], dsh_session: baibai }, base, autoInject: auto, chatId: 'chat-42' })
  assert.equal(untouched.body.dsh_session.chat_id, 'keep-me')

  assert.equal(await adaptBody({ url: base + '/chat/completions', pageOrigin: 'http://localhost:8000', body: plain, base, autoInject: auto, chatId: '' }), null)
})

test('localBase accepts private LAN and Tailscale addresses but rejects public hosts', () => {
  assert.equal(localBase('http://127.0.0.1:43121/v1'), 'http://127.0.0.1:43121/v1')
  assert.equal(localBase('http://192.168.1.20:43121/v1'), 'http://192.168.1.20:43121/v1')
  assert.equal(localBase('http://10.0.0.5:43121/v1'), 'http://10.0.0.5:43121/v1')
  assert.equal(localBase('http://172.20.1.2:43121/v1'), 'http://172.20.1.2:43121/v1')
  assert.equal(localBase('http://100.64.0.1:43121/v1'), 'http://100.64.0.1:43121/v1')
  assert.equal(localBase('http://[fe80::1]:43121/v1'), 'http://[fe80::1]:43121/v1')
  for (const bad of ['http://8.8.8.8:43121/v1', 'http://0.0.0.0:43121/v1', 'https://192.168.1.20:43121/v1', 'http://192.168.1.20:43121/v2']) {
    assert.throws(() => localBase(bad))
  }
})

test('device tokens are forwarded on proxy and direct requests', async () => {
  const body = { chat_completion_source: 'custom', custom_url: base, custom_include_body: JSON.stringify({ dsh_session: session }), messages: [{ role: 'user', content: 'hi' }] }
  const proxied = await adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body, base, deviceToken: 'dev-token' })
  assert.deepEqual(JSON.parse(proxied.body.custom_include_headers), { Authorization: 'Bearer dev-token' })
  assert.equal(proxied.deviceToken, 'dev-token')

  const direct = await adaptBody({ url: `${base}/chat/completions`, pageOrigin: 'http://localhost:8000', body: { messages: [{ role: 'user', content: 'hi' }], dsh_session: session }, base, deviceToken: 'dev-token' })
  assert.equal(direct.deviceToken, 'dev-token')
})

test('paired proxy headers remain one JSON object and replace Authorization case-insensitively', async () => {
  const originalHeaders = { Authorization: 'Bearer old', authorization: 'Bearer stale', AUTHORIZATION: 'Bearer other', 'X-Client': 'baibai: # "test"' }
  const body = { chat_completion_source: 'custom', custom_url: base, custom_include_body: JSON.stringify({ dsh_session: session }), custom_include_headers: JSON.stringify(originalHeaders), messages: [{ role: 'user', content: 'hi' }] }
  const before = JSON.stringify(body)
  const result = await adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body, base, deviceToken: 'device-token' })
  const headers = JSON.parse(result.body.custom_include_headers)
  assert.deepEqual(headers, { 'X-Client': originalHeaders['X-Client'], Authorization: 'Bearer device-token' })
  assert.equal(JSON.stringify(body), before)
  assert.deepEqual(JSON.parse(result.body.custom_include_body).dsh_session, session)
})

test('paired proxy accepts caller-parsed YAML headers but serializes a single JSON map', async () => {
  const yaml = 'authorization: Bearer old\nX-Client: mobile'
  const parseObject = value => value === yaml ? { authorization: 'Bearer old', 'X-Client': 'mobile' } : JSON.parse(value)
  const body = { chat_completion_source: 'custom', custom_url: base, custom_include_body: JSON.stringify({ dsh_session: session }), custom_include_headers: yaml, messages: [{ role: 'user', content: 'hi' }] }
  const result = await adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body, base, parseObject, deviceToken: 'device-token' })
  assert.deepEqual(JSON.parse(result.body.custom_include_headers), { 'X-Client': 'mobile', Authorization: 'Bearer device-token' })
  const unchanged = await adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body, base, parseObject })
  assert.equal(unchanged.body.custom_include_headers, yaml)
})

test('paired proxy rejects invalid header maps before forwarding instead of silently dropping them', async () => {
  const body = { chat_completion_source: 'custom', custom_url: base, custom_include_body: JSON.stringify({ dsh_session: session }), messages: [{ role: 'user', content: 'hi' }] }
  for (const value of ['[]', 'null', '"text"']) {
    await assert.rejects(adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body: { ...body, custom_include_headers: value }, base, deviceToken: 'device-token' }), /附加请求头必须为对象/)
  }
  await assert.rejects(adaptBody({ url: proxy, pageOrigin: 'http://localhost:8000', body: { ...body, custom_include_headers: '{broken' }, base, deviceToken: 'device-token' }), SyntaxError)
})
