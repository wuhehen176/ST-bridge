import assert from 'node:assert/strict'
import test from 'node:test'
import { SystemSnapshot, normalizeSystemSnapshotMode } from '../lib/system-snapshot.js'

function systemNode(text) {
  return {
    type: 'system/message',
    data: { message: { role: 'system', content: [{ type: 'text', text }] } },
  }
}

function fakeSession(events) {
  const appended = []
  return {
    appended,
    session: {
      surface: { nodes: events.map((_, index) => index + 1) },
      eventAt(seq) { return events[seq - 1] },
      append(type, data, options) { appended.push({ type, data, options }) },
    },
  }
}

function runtime(overrides = {}) {
  return {
    protocol: true,
    sessionId: 'session-st-test',
    dynamicSystem: [{ role: 'system', text: 'WORLDBOOK' }],
    fixedRules: [],
    ...overrides,
  }
}

test('native mode repairs an empty node left by the old bridge', () => {
  const { session, appended } = fakeSession([systemNode('')])
  const result = new SystemSnapshot({ mode: 'native' }).apply({
    runtime: runtime(),
    position: { turn: 2, step: 1 },
    session,
    renderedText: 'FULL SYSTEM',
  })
  assert.equal(result.replaced, 1)
  assert.equal(appended[0].data.message.content[0].text, 'FULL SYSTEM')
})

test('native mode leaves the DSH-owned system node untouched', () => {
  const { session, appended } = fakeSession([systemNode('<<<DYNAMIC_SYSTEM index="0">>>\nWORLDBOOK')])
  const result = new SystemSnapshot({ mode: 'native' }).apply({
    runtime: runtime(),
    position: { turn: 2, step: 1 },
    session,
    renderedText: 'FULL SYSTEM',
  })
  assert.equal(result.replaced, 0)
  assert.equal(appended.length, 0)
})

test('filled mode writes the rendered system text instead of an empty node', () => {
  const { session, appended } = fakeSession([systemNode('<<<DYNAMIC_SYSTEM index="0">>>\nWORLDBOOK')])
  const result = new SystemSnapshot({ mode: 'filled' }).apply({
    runtime: runtime(),
    position: { turn: 2, step: 1 },
    session,
    renderedText: 'FULL SYSTEM\n\nWORLDBOOK',
  })
  assert.equal(result.replaced, 1)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].type, 'system/message')
  assert.equal(appended[0].data.message.content[0].type, 'text')
  assert.equal(appended[0].data.message.content[0].text, 'FULL SYSTEM\n\nWORLDBOOK')
  assert.deepEqual(appended[0].options.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 1 })
  assert.deepEqual(appended[0].options.sourceEventSeqs, [1])
})

test('empty mode remains available only as an explicit diagnostic', () => {
  const { session, appended } = fakeSession([systemNode('<<<DYNAMIC_SYSTEM index="0">>>\nWORLDBOOK')])
  const result = new SystemSnapshot({ mode: 'empty' }).apply({
    runtime: runtime(),
    position: { turn: 2, step: 1 },
    session,
    renderedText: 'FULL SYSTEM',
  })
  assert.equal(result.replaced, 1)
  assert.deepEqual(appended[0].data.message.content, [])
})

test('filled mode refuses to replace with an empty render and native is the default', () => {
  const { session, appended } = fakeSession([systemNode('<<<DYNAMIC_SYSTEM index="0">>>\nWORLDBOOK')])
  const result = new SystemSnapshot({ mode: 'filled' }).apply({
    runtime: runtime(),
    position: { turn: 2, step: 1 },
    session,
    renderedText: '   ',
  })
  assert.equal(result.replaced, 0)
  assert.equal(appended.length, 0)
  assert.equal(normalizeSystemSnapshotMode('unknown'), 'native')
})

test('unchanged rendered text is not replaced twice', () => {
  const { session, appended } = fakeSession([systemNode('<<<DYNAMIC_SYSTEM index="0">>>\nWORLDBOOK')])
  const snapshot = new SystemSnapshot({ mode: 'filled' })
  const rt = runtime()
  const first = snapshot.apply({ runtime: rt, position: { turn: 2, step: 1 }, session, renderedText: 'FULL' })
  const second = snapshot.apply({ runtime: rt, position: { turn: 3, step: 1 }, session, renderedText: 'FULL' })
  assert.equal(first.replaced, 1)
  assert.equal(second.replaced, 0)
  assert.equal(appended.length, 1)
})
