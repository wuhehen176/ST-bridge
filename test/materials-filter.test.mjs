import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptBody, cleanImageMessages, filterWorldMessages, messageText, nameMatcher, validateMaterialsPolicy } from '../tavern-extension/core.js'
import { normalizeMessages } from '../lib/context.js'
import { parseContextRequest } from '../lib/context-policy.js'

const entry = (uid, content, other = {}) => ({ uid, world: '设定', comment: '角色资料', content, constant: false, disable: false, ...other })
const policy = value => validateMaterialsPolicy(value)

test('worldbook filtering removes only full dynamic system matches, protects fixed rules and conversations', () => {
  const catalog = [entry(1, 'PRIVATE_WORLDBOOK')]
  const raw = [{ role: 'system', content: '固定 PRIVATE_WORLDBOOK' }, { role: 'system', name: 'material', content: '前PRIVATE_WORLDBOOK后' }, { role: 'user', content: '正文引用PRIVATE_WORLDBOOK' }]
  const saved = structuredClone(raw)
  const result = filterWorldMessages(raw, 1, catalog, [], false, policy({ excluded: ['设定'] }))
  assert.deepEqual(raw, saved)
  assert.equal(result.messages[0], raw[0])
  assert.equal(result.messages[2], raw[2])
  assert.equal(result.messages[1].content, '前后')
  assert.equal(result.messages[1].name, 'material')
  assert.equal(result.audit.changes[0].reason, 'excluded-book')
  assert.equal(JSON.stringify(result.audit).includes('PRIVATE_WORLDBOOK'), false)
  assert.equal(result.audit.protected_matches.length, 2)
})

test('green books retain activated, blue-light and unknown entries; missing activation preserves content', () => {
  const catalog = [entry(1, 'ACTIVE_GREEN'), entry(2, 'IDLE_GREEN'), entry(3, 'BLUE_RULE', { constant: true }), entry(4, 'UNKNOWN_MODE', { constant: undefined })]
  const raw = [{ role: 'system', content: catalog.map(e => e.content).join('\n') }]
  const selected = policy({ green: ['设定'] })
  const unknown = filterWorldMessages(raw, 0, catalog, [catalog[0]], false, selected)
  assert.equal(unknown.messages, raw)
  assert.match(unknown.audit.warnings.join(''), /没有可关联/)
  const known = filterWorldMessages(raw, 0, catalog, [catalog[0]], true, selected)
  assert.equal(known.messages[0].content, 'ACTIVE_GREEN\n\nBLUE_RULE\nUNKNOWN_MODE')
  const excluded = filterWorldMessages(raw, 0, catalog, [catalog[0]], true, policy({ ...selected, excluded: ['设定'] }))
  assert.equal(excluded.messages[0].content.trim(), '')
})

test('ambiguous identical or overlapping worldbook texts stay; partial/rendered text does not get guessed', () => {
  const catalog = [entry(1, 'SHARED_TEXT'), entry(2, 'SHARED_TEXT', { world: '另一书' }), entry(3, 'part'), entry(4, 'long part')]
  const raw = [{ role: 'system', content: 'SHARED_TEXT long part rendered-macro' }]
  const result = filterWorldMessages(raw, 0, catalog, [], false, policy({ excluded: ['设定'] }))
  assert.equal(result.messages, raw)
  assert.match(result.audit.warnings.join(''), /重复/)
})

test('custom tag cleanup handles nested different tags, text parts, orphan and similarly named tags without mutating rules', () => {
  const raw = [{ role: 'system', content: '<snow>RULE_EXAMPLE</snow>' }, { role: 'user', content: ['A<SNOW class="x">private', { type: 'text', text: '<bbi_image>old</bbi_image></snow>B<snower>KEEP</snower><snow/>C</snow>D', cache_control: { type: 'ephemeral' } }] }]
  const saved = structuredClone(raw)
  const result = cleanImageMessages(raw, 1, ['snow'])
  assert.deepEqual(raw, saved)
  assert.equal(result.messages[0], raw[0])
  assert.equal(messageText(result.messages[1]), 'A\nB<snower>KEEP</snower>CD')
  assert.deepEqual(result.messages[1].content[1].cache_control, { type: 'ephemeral' })
  assert.equal(cleanImageMessages(result.messages, 1, ['snow']).cleanup.removed_chars, 0)
  assert.throws(() => cleanImageMessages(raw, 0, ['snow|.*']), /标签名/)
})

test('entry-name filters are explicit plain text or bounded simple regex, unsafe patterns fail visibly', () => {
  assert.equal(nameMatcher('规则')('新增规则'), true)
  assert.equal(nameMatcher('/^规则/')('新增规则'), false)
  assert.equal(nameMatcher('/^规则/')('规则说明'), true)
  assert.equal(nameMatcher('/\\[mvu[\\s\\S]*?\\]/i')('[MVU 框架]'), true)
  for (const invalid of ['/(a+)+$/', '/(a|aa)+$/', '/a*a*a*/', '/[bad/']) assert.throws(() => nameMatcher(invalid))
  assert.throws(() => validateMaterialsPolicy({ tags: ['<snow>'] }), /标签/)
})

test('local adapter applies selected scope, rebuilds source hashes after filtering, and never reads books for unrelated requests', async () => {
  const base = 'http://127.0.0.1:43121/v1'
  const activated = [entry(1, 'REMOVE_THIS', { comment: '规则条目' }), entry(2, 'KEEP_THIS', { world: '保留书' })]
  const session = { protocol_version: 1, client_id: 'shujuku', chat_id: 'chat', task_id: 'database', action: 'generate', fixed_message_count: 0 }
  const body = { messages: [{ role: 'system', content: 'REMOVE_THIS KEEP_THIS' }, { role: 'user', content: '本轮正文<snow>HIDDEN_NOTE</snow>' }], dsh_session: session }
  let reads = 0
  const args = { url: base + '/chat/completions', pageOrigin: 'http://localhost:8000', base, body, materials: async value => {
    reads++; assert.equal(value.client_id, 'shujuku')
    return { entries: activated, catalog: activated, activationKnown: true, policy: { patterns: ['规则'], tags: ['snow'] } }
  } }
  assert.equal(await adaptBody({ ...args, url: 'https://external.test/v1/chat/completions' }), null)
  assert.equal(reads, 0)
  const result = await adaptBody(args)
  assert.equal(reads, 1)
  assert.equal(result.body.messages[0].content, ' KEEP_THIS')
  assert.equal(result.body.messages[1].content, '本轮正文')
  assert.equal(body.messages[0].content, 'REMOVE_THIS KEEP_THIS')
  const metadata = parseContextRequest(result.body.dsh_context, normalizeMessages(result.body.messages).messages)
  assert.equal(metadata.sources[0].start, 1)
  assert.equal(result.preview.worldbook_filter.removed_chars, 'REMOVE_THIS'.length)
  assert.ok(result.preview.cleanup.removed_chars > 0)
})
