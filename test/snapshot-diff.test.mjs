import assert from 'node:assert/strict'
import test from 'node:test'
import { messageHash } from '../lib/context.js'
import {
  diffAgainstSnapshot,
  normalizeSnapshotMarker,
  parseSnapshotBlocks,
  snapshotOf,
  splitAutoBlocks,
  stripMarkersInMessages,
  stripSnapshotMarkers,
} from '../lib/snapshot-diff.js'

const MARKER = '9F3C7A1E5B2D'
const B = `<<<STB-${MARKER}:B>>>`
const E = `<<<STB-${MARKER}:E>>>`
const wrap = (...blocks) => blocks.map(text => `${B}\n${text}\n${E}`).join('\n')
const msg = (role, text) => ({ role, text, hash: messageHash(role, text) })

test('marker normalization only accepts 8-32 uppercase hex', () => {
  assert.equal(normalizeSnapshotMarker('stb-9f3c7a1e5b2d'), '9F3C7A1E5B2D')
  assert.equal(normalizeSnapshotMarker('9f3c7a1e5b2d'), '9F3C7A1E5B2D')
  assert.equal(normalizeSnapshotMarker(''), '')
  assert.equal(normalizeSnapshotMarker('xyz'), '')
  assert.equal(normalizeSnapshotMarker(123), '')
})

test('parse requires paired markers and no text outside', () => {
  const parsed = parseSnapshotBlocks(wrap('A', 'B'), MARKER)
  assert.equal(parsed.kind, 'blocks')
  assert.deepEqual(parsed.blocks, ['A', 'B'])
  assert.equal(stripSnapshotMarkers(wrap('A'), MARKER), 'A')

  assert.equal(parseSnapshotBlocks(`${B}A${E} tail`, MARKER).kind, 'ambiguous')
  assert.equal(parseSnapshotBlocks(`${B}A`, MARKER).kind, 'ambiguous')
  assert.equal(parseSnapshotBlocks(`A${E}`, MARKER).kind, 'ambiguous')
  assert.equal(parseSnapshotBlocks(`${B}A${B}B${E}${E}`, MARKER).kind, 'ambiguous')
  assert.equal(parseSnapshotBlocks('plain text', MARKER).kind, 'unmarked')
})

test('diff trims leading/trailing identical blocks and keeps the middle', () => {
  const previous = [msg('system', wrap('FIXED_A', 'OLD_MIDDLE', 'FIXED_B'))]
  const snapshot = { marker: MARKER, turn: 1, messages: snapshotOf(previous, MARKER) }
  const current = [msg('system', wrap('FIXED_A', 'NEW_MIDDLE', 'FIXED_B'))]
  const result = diffAgainstSnapshot(current, snapshot, MARKER)
  assert.ok(result.diagnostic)
  assert.equal(result.diagnostic.trimmed_blocks, 2)
  assert.equal(result.messages[0].text, 'NEW_MIDDLE')
  assert.equal(JSON.stringify(result.diagnostic).includes('FIXED_A'), false)
})

test('diff trims identical leading messages but never empties the turn', () => {
  const previous = [msg('system', 'S1'), msg('user', 'TARGET')]
  const snapshot = { marker: MARKER, turn: 1, messages: snapshotOf(previous, MARKER) }
  const next = [msg('system', 'S1'), msg('user', 'TARGET2')]
  const result = diffAgainstSnapshot(next, snapshot, MARKER)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].text, 'TARGET2')
  assert.equal(result.diagnostic.trimmed_messages, 1)

  const identical = diffAgainstSnapshot(previous, snapshot, MARKER)
  assert.equal(identical.diagnostic, undefined)
  assert.equal(identical.messages.length, 2)
})

test('no marker, marker change or ambiguous blocks fall back to full', () => {
  const current = [msg('user', 'plain')]
  assert.equal(diffAgainstSnapshot(current, { marker: MARKER, messages: [] }, '').diagnostic, undefined)
  assert.equal(diffAgainstSnapshot(current, { marker: 'STB-AAAAAAAAAAAA', messages: [] }, MARKER).diagnostic, undefined)
  const broken = [msg('system', `${B}only-open`)]
  const snapshot = { marker: MARKER, turn: 1, messages: snapshotOf([msg('system', wrap('X'))], MARKER) }
  const result = diffAgainstSnapshot(broken, snapshot, MARKER)
  assert.equal(result.messages[0].text, `${B}only-open`)
})

test('never trims away every user message', () => {
  const previous = [msg('system', 'S'), msg('user', 'TARGET'), msg('system', 'OLD_TAIL')]
  const snapshot = { marker: MARKER, turn: 1, messages: snapshotOf(previous, MARKER) }
  const current = [msg('system', 'S'), msg('user', 'TARGET'), msg('system', 'NEW_TAIL')]
  const result = diffAgainstSnapshot(current, snapshot, MARKER)
  assert.equal(result.diagnostic.status, 'no-user-after-trim')
  assert.equal(result.messages.length, 3)
  assert.equal(result.messages[1].text, 'TARGET')
})

test('marker tokens are stripped even when blocks are unbalanced', () => {
  const mixed = msg('system', `prefix\n${B}\nA\n${E}\nsuffix`)
  const broken = msg('user', `head ${B} body`)
  const other = msg('system', '<<<STB-AAAAAAAAAAAA:B>>>keep<<<STB-AAAAAAAAAAAA:E>>>')
  const out = stripMarkersInMessages([mixed, broken, other], MARKER)
  assert.equal(out[0].text, 'prefix\n\nA\n\nsuffix')
  assert.equal(out[1].text, 'head  body')
  assert.equal(out[2].text, other.text)
})

test('auto mode splits paragraphs and trims stable head/tail blocks', () => {
  const previous = [msg('system', 'FIXED_A\n\nOLD_MIDDLE\n\nFIXED_B'), msg('user', 'TARGET')]
  const snapshot = { mode: 'auto', marker: '', turn: 1, messages: snapshotOf(previous, { mode: 'auto', maxBlockChars: 2000 }) }
  const current = [msg('system', 'FIXED_A\n\nNEW_MIDDLE\n\nFIXED_B'), msg('user', 'TARGET2')]
  const result = diffAgainstSnapshot(current, snapshot, { mode: 'auto', maxBlockChars: 2000 })
  assert.ok(result.diagnostic)
  assert.equal(result.diagnostic.mode, 'auto')
  assert.equal(result.diagnostic.trimmed_blocks, 2)
  assert.equal(result.messages[0].text, 'NEW_MIDDLE')
})

test('auto mode splits an oversized paragraph into line groups', () => {
  const long = Array.from({ length: 40 }, (_, index) => `line-${index} ${'x'.repeat(120)}`).join('\n')
  const blocks = splitAutoBlocks(long, { maxBlockChars: 500 })
  assert.ok(blocks.length > 1)
  assert.ok(blocks.every(block => block.text.length <= 700))
  assert.equal(blocks[0].start, 0)
  assert.equal(blocks[blocks.length - 1].end, long.length)
})

test('mode change between snapshots falls back to full', () => {
  const previous = [msg('user', 'A\n\nB')]
  const snapshot = { mode: 'marker', marker: MARKER, turn: 1, messages: snapshotOf(previous, MARKER) }
  const current = [msg('user', 'A\n\nC')]
  assert.equal(diffAgainstSnapshot(current, snapshot, { mode: 'auto' }).diagnostic, undefined)
})

test('long paragraphs become one block per line', () => {
  const text = `${'a'.repeat(300)}\n${'b'.repeat(300)}\n${'c'.repeat(300)}`
  const blocks = splitAutoBlocks(text, { maxBlockChars: 500 })
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].text.length, 300)
  assert.equal(blocks[1].text.length, 300)
  assert.equal(blocks[2].text.length, 300)
})

test('an oversized single line is split by sentence boundary', () => {
  const sentence = `${'字'.repeat(90)}。`
  const text = sentence.repeat(20)
  const blocks = splitAutoBlocks(text, { maxBlockChars: 300 })
  assert.ok(blocks.length > 1)
  assert.ok(blocks.every(block => block.text.length <= 300))
  assert.equal(blocks[0].start, 0)
  assert.equal(blocks[blocks.length - 1].end, text.length)
})
