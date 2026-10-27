import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanTagBlocks, cleanMessagesForProjection } from '../lib/input-cleanup.js'
import { messageHash } from '../lib/context.js'

const msg = (role, text) => ({ role, text, hash: messageHash(role, text) })

test('only complete tag pairs are removed, attributes and case included', () => {
  assert.equal(cleanTagBlocks('A<bbi_image>X</bbi_image>B', 'bbi_image').text, 'AB')
  assert.equal(cleanTagBlocks('A<BBI_IMAGE class="x">X</BBI_IMAGE>B', 'bbi_image').text, 'AB')
  assert.equal(cleanTagBlocks('A<bbi_image>X<bbi_image>Y</bbi_image>Z</bbi_image>B', 'bbi_image').text, 'AB')
  const result = cleanTagBlocks('A<bbi_image>X</bbi_image>B<bbi_image>Y</bbi_image>C', 'bbi_image')
  assert.equal(result.text, 'ABC')
  assert.equal(result.removed_blocks, 2)
})

test('orphan or truncated tags keep their body and are reported', () => {
  const open = cleanTagBlocks('A<bbi_image>{"summary":1}B', 'bbi_image')
  assert.equal(open.text, 'A<bbi_image>{"summary":1}B')
  assert.equal(open.orphan_open, 1)
  assert.equal(open.removed_blocks, 0)

  const close = cleanTagBlocks('A</bbi_image>B', 'bbi_image')
  assert.equal(close.text, 'A</bbi_image>B')
  assert.equal(close.orphan_close, 1)

  const crossed = cleanTagBlocks('A<bbi_image>X</bbi_image>Y</bbi_image>', 'bbi_image')
  assert.equal(crossed.text, 'AY</bbi_image>')
  assert.equal(crossed.orphan_close, 1)
})

test('cross-message tags are not paired and other tags are untouched', () => {
  const messages = [
    msg('system', 'A<bbi_image>'),
    msg('user', 'X</bbi_image>B'),
  ]
  const result = cleanMessagesForProjection(messages)
  assert.equal(result.messages[0].text, 'A<bbi_image>')
  assert.equal(result.messages[1].text, 'X</bbi_image>B')
  assert.equal(result.diagnostic.removed_blocks, 0)
  assert.equal(result.diagnostic.orphan_open, 1)
  assert.equal(result.diagnostic.orphan_close, 1)

  assert.equal(cleanTagBlocks('A<snow>X</snow>B', 'bbi_image').text, 'A<snow>X</snow>B')
})

test('an emptied user message is preserved instead of breaking the protocol', () => {
  const result = cleanMessagesForProjection([msg('user', '<bbi_image>X</bbi_image>')])
  assert.equal(result.messages[0].text, '<bbi_image>X</bbi_image>')
  assert.equal(result.diagnostic.skipped_user, 1)
})

test('cleanup is disabled without touching any message', () => {
  const messages = [msg('system', 'A<bbi_image>X</bbi_image>B')]
  const result = cleanMessagesForProjection(messages, { enabled: false })
  assert.equal(result.messages, messages)
  assert.equal(result.diagnostic, undefined)
})
