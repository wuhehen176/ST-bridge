import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { messageHash } from '../lib/context.js'
import {
  PRESET_MARKER_BEGIN,
  PresetConfigs,
  carriesManagedPreset,
  formatManagedPreset,
  identifyPreset,
  presetHashOf,
  presetSpansWithin,
  reuseDecision,
  stripPresetForRendering,
  validatePresetConfig,
} from '../lib/preset-policy.js'

const hashOf = text => messageHash('system', text)

function preset(exactTexts, extra = {}) {
  return {
    id: 'p1',
    label: '数据库固定预设',
    client_id: 'shujuku',
    task_id: 'database',
    mode: 'exact',
    exact_hashes: exactTexts.map(hashOf),
    ...extra,
  }
}

function messages(...texts) {
  return texts.map(text => ({ role: 'system', text, hash: hashOf(text) }))
}

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'preset-policy-'))
  t.after(() => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

test('exact mode identifies one contiguous confirmed block and hashes role+order', () => {
  const found = identifyPreset(messages('PRESET_A', 'PRESET_B'), preset(['PRESET_A', 'PRESET_B']))
  assert.equal(found.status, 'identified')
  assert.equal(found.matched_messages, 2)
  assert.equal(found.hash, presetHashOf([{ role: 'system', text: 'PRESET_A' }, { role: 'system', text: 'PRESET_B' }]))
  // Same text in a different role is a different identity.
  const otherRole = [{ role: 'user', text: 'PRESET_A', hash: hashOf('PRESET_A') }]
  assert.equal(identifyPreset(otherRole, preset(['PRESET_A'])).status, 'identified')
  assert.notEqual(presetHashOf([{ role: 'user', text: 'PRESET_A' }]), presetHashOf([{ role: 'system', text: 'PRESET_A' }]))
})

test('unconfirmed, partial, duplicated or reordered matches keep everything verbatim', () => {
  const config = preset(['PRESET_A', 'PRESET_B'])
  assert.equal(identifyPreset(messages('WORLDBOOK'), config).status, 'not-found')
  assert.equal(identifyPreset(messages('PRESET_A'), config).status, 'ambiguous')
  assert.equal(identifyPreset(messages('PRESET_A', 'PRESET_B', 'PRESET_A'), config).status, 'ambiguous')
  assert.equal(identifyPreset(messages('PRESET_A', 'WORLDBOOK', 'PRESET_B'), config).status, 'ambiguous')
  assert.equal(identifyPreset(messages('PRESET_B', 'PRESET_A'), preset(['PRESET_A', 'PRESET_B'])).status, 'ambiguous')
  const off = identifyPreset(messages('PRESET_A'), { ...config, mode: 'off' })
  assert.equal(off.status, 'disabled')
})

test('marker mode requires exactly one closed system block', () => {
  const config = {
    id: 'm1', label: 'marker', client_id: 'baibai-image', task_id: 'default', mode: 'marker',
    marker: { begin: '<<<PRESET>>>', end: '<<<END_PRESET>>>' },
  }
  const whole = identifyPreset(messages('<<<PRESET>>>\nBODY\n<<<END_PRESET>>>'), config)
  assert.equal(whole.status, 'identified')
  assert.equal(whole.texts[0].text, '<<<PRESET>>>\nBODY\n<<<END_PRESET>>>')
  assert.equal(whole.spans[0].whole, true)

  const mixed = identifyPreset(messages('LEAD\n<<<PRESET>>>BODY<<<END_PRESET>>>\nTAIL'), config)
  assert.equal(mixed.status, 'identified')
  assert.equal(mixed.spans[0].whole, false)
  const kept = stripPresetForRendering([{ role: 'system', text: 'LEAD\n<<<PRESET>>>BODY<<<END_PRESET>>>\nTAIL' }], mixed.spans)
  assert.equal(kept.length, 1)
  assert.match(kept[0].text, /LEAD/)
  assert.match(kept[0].text, /TAIL/)
  assert.doesNotMatch(kept[0].text, /BODY/)

  assert.equal(identifyPreset(messages('<<<PRESET>>>BODY'), config).status, 'ambiguous')
  assert.equal(identifyPreset(messages('<<<PRESET>>>A<<<END_PRESET>>>', '<<<PRESET>>>B<<<END_PRESET>>>'), config).status, 'ambiguous')
  const asUser = [{ role: 'user', text: '<<<PRESET>>>BODY<<<END_PRESET>>>', hash: 'x' }]
  assert.equal(identifyPreset(asUser, config).status, 'ambiguous')
})

test('boundaries outside the dynamic system block are never deduplicated', () => {
  // The confirmed block spans one system message plus the user turn; only the
  // system part may be trimmed, so the whole match must be refused.
  const dynamic = [
    { role: 'system', text: 'SYSTEM_A', hash: hashOf('SYSTEM_A') },
    { role: 'user', text: 'USER_TARGET', hash: messageHash('user', 'USER_TARGET') },
  ]
  const config = {
    ...preset(['SYSTEM_A']),
    exact_hashes: [hashOf('SYSTEM_A'), messageHash('user', 'USER_TARGET')],
  }
  const found = identifyPreset(dynamic, config)
  assert.equal(found.status, 'identified')
  assert.equal(presetSpansWithin(found.spans, 1), undefined)
  assert.equal(presetSpansWithin(found.spans, 2)?.length, 2)
})

test('reuse requires the same preset, hash and session', () => {
  const identity = { hash: 'h1', presetId: 'p1', sessionId: 's1' }
  assert.equal(reuseDecision({ hash: 'h1', presetId: 'p1', sessionId: 's1', pending: false }, identity).reuse, true)
  assert.equal(reuseDecision({ hash: 'h1', presetId: 'p1', sessionId: 's1', pending: true }, identity).reason, 'not-installed')
  assert.equal(reuseDecision({ hash: 'h2', presetId: 'p1', sessionId: 's1' }, identity).reason, 'version-changed')
  assert.equal(reuseDecision({ hash: 'h1', presetId: 'p2', sessionId: 's1' }, identity).reason, 'preset-changed')
  assert.equal(reuseDecision({ hash: 'h1', presetId: 'p1', sessionId: 's2' }, identity).reason, 'session-changed')
  assert.equal(reuseDecision(undefined, identity).reuse, false)
})

test('config validation rejects duplicate scopes, bad modes and body-free listing', t => {
  const dir = tmp(t)
  const registry = new PresetConfigs(join(dir, 'fixed-presets.json'))
  assert.deepEqual(registry.list().presets, [])
  registry.save({ version: 1, presets: [preset(['PRESET_A'])] })
  assert.equal(JSON.stringify(registry.list()).includes('PRESET_A'), false)

  assert.throws(() => validatePresetConfig({ version: 1, presets: [preset(['A']), { ...preset(['B']), id: 'p2' }] }), /只能启用一个/)
  assert.throws(() => validatePresetConfig({ version: 1, presets: [preset([], { exact_hashes: [] })] }), /exact_hashes/)
  assert.throws(() => validatePresetConfig({ version: 1, presets: [{ ...preset(['A']), mode: 'guess' }] }), /mode/)
  assert.throws(() => validatePresetConfig({ version: 1, presets: [{ ...preset(['A']), mode: 'marker', marker: { begin: 'x', end: 'y' } }] }), /marker.begin/)
  assert.throws(() => validatePresetConfig({ version: 1, presets: [{ ...preset(['A']), mode: 'marker', marker: { begin: 'same', end: 'same' } }] }), /不能相同/)

  registry.save({ version: 1, presets: [preset(['PRESET_A'], { id: 'p9' })] })
  assert.ok(readdirSync(dir).some(name => name.includes('.bak-')))

  writeFileSync(join(dir, 'fixed-presets.json'), '{not json', 'utf8')
  assert.throws(() => registry.read(), /无法读取/)
})

test('managed preset section carries a marker so snapshot replacement can recognise it', () => {
  const text = formatManagedPreset({ id: 'p1', hash: 'abc', texts: [{ role: 'system', text: 'BODY' }] })
  assert.match(text, /BODY/)
  assert.ok(text.includes(PRESET_MARKER_BEGIN))
  assert.equal(carriesManagedPreset(text), true)
  assert.equal(carriesManagedPreset('FIXED_RULE'), false)
  assert.equal(formatManagedPreset(undefined), '')
})
