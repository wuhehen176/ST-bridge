import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLayoutAtlas } from '../lib/layout-atlas.js'

test('layout atlas metadata accepts only explicit dynamic user image indices in dedicated mode', () => {
  const messages = [{ role: 'system', images: [] }, { role: 'user', images: [{}] }, { role: 'user', images: [] }]
  const input = { hash: 'a'.repeat(64), message_indices: [1] }
  assert.equal(parseLayoutAtlas(undefined, messages, 1, true), null)
  assert.deepEqual(parseLayoutAtlas(input, messages, 1, true).messages, [messages[1]])
  assert.deepEqual(parseLayoutAtlas({ ...input, message_indices: [] }, messages, 1, true).messages, [])
  for (const value of [null, {}, { ...input, hash: '../bad' }, { ...input, message_indices: [0] },
    { ...input, message_indices: [1, 1] }, { ...input, message_indices: [2] }, { ...input, message_indices: [10] },
    { ...input, message_indices: [1.5] }]) {
    assert.throws(() => parseLayoutAtlas(value, messages, 1, true), error => error.code === 'invalid_layout_atlas')
  }
  assert.throws(() => parseLayoutAtlas(input, messages, 1, false), error => error.code === 'invalid_layout_atlas')
})
