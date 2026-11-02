import assert from 'node:assert/strict'
import test from 'node:test'
import { messageHash, normalizeMessages } from '../lib/context.js'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII='

test('user image parts are preserved and included in the message hash', () => {
  const raw = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: PNG } }] },
  ]
  const { messages, images } = normalizeMessages(raw)
  assert.equal(messages[1].text, 'look')
  assert.equal(messages[1].images.length, 1)
  assert.equal(messages[1].images[0].mediaType, 'image/png')
  assert.equal(images.length, 1)
  assert.notEqual(messages[1].hash, messageHash('user', 'look'))
})

test('image input rejects remote URLs, non-user roles and invalid payloads', () => {
  assert.throws(() => normalizeMessages([{ role: 'system', content: [{ type: 'image_url', image_url: { url: PNG } }] }]), /只有 user/)
  assert.throws(() => normalizeMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] }]), /data:/)
  assert.throws(() => normalizeMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:text/plain;base64,QQ==' } }] }]), /MIME/)
  assert.throws(() => normalizeMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,@@@' } }] }]), /MIME/)
})
