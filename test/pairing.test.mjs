import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PairingService, normalizePairingCode } from '../lib/pairing.js'

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bbh-pairing-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'devices.json')
}

test('pairing code normalization ignores separators and ambiguous characters', () => {
  assert.equal(normalizePairingCode('a7k9-2m4q-7x'), 'A7K92M4Q7X')
  assert.equal(normalizePairingCode('O0I1L'), '00111')
})

test('invite -> request -> approve -> retry token -> ack -> authenticate -> revoke', t => {
  let time = 1000
  const service = new PairingService({ file: tempFile(t), now: () => time })
  const invite = service.startInvite()
  assert.equal(invite.code.length, 10)

  const submitted = service.submit({ code: invite.code, deviceName: 'iPhone', ip: '192.168.1.33' })
  assert.equal(submitted.status, 'pending')
  assert.ok(submitted.pollToken.length >= 32)

  const approved = service.approve(submitted.pairId)
  assert.equal(approved.status, 'approved_pending_delivery')
  assert.equal(service.listDevices().length, 0)

  const first = service.status({ pairId: submitted.pairId, pollToken: submitted.pollToken })
  assert.equal(first.status, 'approved_pending_delivery')
  assert.ok(first.deviceToken)
  const second = service.status({ pairId: submitted.pairId, pollToken: submitted.pollToken })
  assert.equal(second.deviceToken, first.deviceToken)

  const acked = service.ack({ pairId: submitted.pairId, pollToken: submitted.pollToken })
  assert.equal(acked.status, 'active')
  assert.equal(service.ack({ pairId: submitted.pairId, pollToken: submitted.pollToken }).status, 'active')
  assert.equal(service.authenticate(first.deviceToken).name, 'iPhone')
  assert.equal(service.authenticate('wrong'), null)

  const device = service.listDevices()[0]
  service.revoke(device.id)
  assert.equal(service.authenticate(first.deviceToken), null)
  assert.equal(service.listDevices().length, 0)
})

test('a pairing code is consumed atomically and cannot be reused', t => {
  const service = new PairingService({ file: tempFile(t) })
  const invite = service.startInvite()
  const first = service.submit({ code: invite.code, deviceName: 'one' })
  assert.throws(() => service.submit({ code: invite.code, deviceName: 'two' }), error => error.code === 'invite_consumed')
  assert.equal(service.listRequests().length, 1)
  assert.equal(service.listRequests()[0].pairId, first.pairId)
})

test('expired invites and delivery windows are rejected', t => {
  let time = 1000
  const service = new PairingService({ file: tempFile(t), now: () => time, ttlMs: 100, deliveryTtlMs: 100 })
  const invite = service.startInvite()
  time += 101
  assert.throws(() => service.submit({ code: invite.code, deviceName: 'late' }), error => error.code === 'invalid_pairing_code')

  const second = service.startInvite()
  const submitted = service.submit({ code: second.code, deviceName: 'phone' })
  service.approve(submitted.pairId)
  time += 101
  assert.equal(service.status({ pairId: submitted.pairId, pollToken: submitted.pollToken }).status, 'expired')
  assert.equal(service.listDevices().length, 0)
})

test('an unACKed delivery is discarded after a restart', t => {
  const file = tempFile(t)
  const first = new PairingService({ file })
  const invite = first.startInvite()
  const submitted = first.submit({ code: invite.code, deviceName: 'phone' })
  first.approve(submitted.pairId)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).devices[0].state, 'pending_delivery')

  const restarted = new PairingService({ file })
  assert.equal(restarted.listDevices().length, 0)
  assert.equal(restarted.authenticate('anything'), null)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).devices.length, 0)
})

test('a corrupt devices file fails closed until devices are cleared', t => {
  const file = tempFile(t)
  writeFileSync(file, '{not-json')
  const service = new PairingService({ file })
  assert.equal(service.authenticate('anything'), null)
  service.clearDevices()
  assert.equal(service.authenticate('anything'), null)
})
