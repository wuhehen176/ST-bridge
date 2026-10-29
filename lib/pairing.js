import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { BridgeError, badRequest, conflict } from './errors.js'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const DEVICE_FILE_VERSION = 1

export function normalizePairingCode(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0')
}

function makeCode(length = 10) {
  const bytes = randomBytes(length)
  let code = ''
  for (let index = 0; index < length; index += 1) code += CROCKFORD[bytes[index] % CROCKFORD.length]
  return code
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    ip: device.ip ?? null,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt ?? null,
    state: device.state,
    revokedAt: device.revokedAt ?? null,
  }
}

function publicRequest(request) {
  return {
    pairId: request.id,
    deviceName: request.deviceName,
    ip: request.ip ?? null,
    userAgent: request.userAgent ?? null,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    status: request.status,
  }
}

/**
 * Pairing state machine plus per-device token registry.
 *
 * Invites and requests are memory-only: a bridge restart cancels anything that
 * was not ACKed. Devices are persisted atomically and token hashes are the only
 * credential material stored on disk.
 */
export class PairingService {
  constructor({ file, now = () => Date.now(), ttlMs = 5 * 60_000, deliveryTtlMs = 5 * 60_000, log = () => {} }) {
    if (!file) throw new Error('PairingService requires a devices file path')
    this.file = file
    this.now = now
    this.ttlMs = ttlMs
    this.deliveryTtlMs = deliveryTtlMs
    this.log = log
    this.invites = new Map()
    this.requests = new Map()
    this.devices = []
    this.activeInviteId = null
    this.corrupt = false
    this.loadError = null
    this.load()
  }

  load() {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!parsed || parsed.version !== DEVICE_FILE_VERSION || !Array.isArray(parsed.devices)) {
        throw new Error('devices.json 结构无效')
      }
      const valid = parsed.devices.filter(device => device && typeof device.id === 'string'
        && typeof device.tokenHash === 'string' && device.state === 'active' && !device.revokedAt)
      // pending_delivery devices cannot deliver their plaintext after a restart.
      this.devices = valid
      if (valid.length !== parsed.devices.length) this.persist()
    } catch (error) {
      this.corrupt = true
      this.loadError = error
      this.devices = []
      this.log(`[pairing] devices.json 损坏，设备 token 全部拒绝: ${error.message}`)
    }
  }

  persist() {
    if (this.corrupt) throw new BridgeError(500, 'devices_corrupt', '设备文件损坏；请先重置设备列表')
    mkdirSync(dirname(this.file), { recursive: true })
    const json = JSON.stringify({ version: DEVICE_FILE_VERSION, devices: this.devices }, null, 2)
    const temporary = `${this.file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
    writeFileSync(temporary, json)
    try {
      renameSync(temporary, this.file)
    } catch {
      // Windows can refuse to replace an open target; fall back to an in-place
      // write after the temp file was fully materialized.
      writeFileSync(this.file, json)
      try { unlinkSync(temporary) } catch {}
    }
  }

  cleanup() {
    const now = this.now()
    for (const [id, invite] of this.invites) {
      if (invite.status === 'active' && invite.expiresAt <= now) {
        invite.status = 'expired'
        if (this.activeInviteId === id) this.activeInviteId = null
      }
    }
    for (const [id, request] of this.requests) {
      if (request.status === 'pending' && request.expiresAt <= now) {
        request.status = 'expired'
        continue
      }
      if (request.status === 'approved_pending_delivery' && request.deliveryExpiresAt <= now) {
        request.status = 'expired'
        request.tokenPlain = null
        if (request.deviceId) this.devices = this.devices.filter(device => device.id !== request.deviceId)
        try { this.persist() } catch {}
      }
    }
  }

  startInvite() {
    this.cleanup()
    this.cancelPending()
    const now = this.now()
    const invite = {
      id: randomUUID(),
      code: makeCode(10),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: 'active',
      requestId: null,
    }
    this.invites.set(invite.id, invite)
    this.activeInviteId = invite.id
    return { inviteId: invite.id, code: invite.code, expiresAt: invite.expiresAt }
  }

  cancelPending() {
    if (this.activeInviteId) {
      const invite = this.invites.get(this.activeInviteId)
      if (invite && invite.status === 'active') invite.status = 'cancelled'
    }
    this.activeInviteId = null
    for (const [id, request] of this.requests) {
      if (request.status === 'pending' || request.status === 'approved_pending_delivery') {
        request.status = 'cancelled'
        request.tokenPlain = null
        if (request.deviceId) this.devices = this.devices.filter(device => device.id !== request.deviceId)
      }
      if (request.status === 'cancelled') this.requests.delete(id)
    }
    try { this.persist() } catch {}
  }

  cancelAll() {
    for (const invite of this.invites.values()) if (invite.status === 'active') invite.status = 'cancelled'
    this.activeInviteId = null
    this.requests.clear()
  }

  submit({ code, deviceName, ip, userAgent }) {
    this.cleanup()
    const normalized = normalizePairingCode(code)
    if (!normalized) throw badRequest('配对码不能为空', 'invalid_pairing_code')
    const now = this.now()
    const invite = [...this.invites.values()].find(item => normalizePairingCode(item.code) === normalized)
    if (!invite) throw badRequest('配对码无效或已过期', 'invalid_pairing_code')
    if (invite.status === 'consumed' || invite.requestId) throw conflict('该配对码已被使用', 'invite_consumed')
    if (invite.status !== 'active') throw badRequest('配对码无效或已过期', 'invalid_pairing_code')
    if (invite.expiresAt <= now) {
      invite.status = 'expired'
      if (this.activeInviteId === invite.id) this.activeInviteId = null
      throw badRequest('配对码已过期', 'pairing_code_expired')
    }
    if (invite.requestId) throw conflict('该配对码已被使用', 'invite_consumed')
    // Atomic single-consumer transition: no await between check and mutation.
    invite.status = 'consumed'
    this.activeInviteId = null
    const pollToken = randomBytes(32).toString('hex')
    const request = {
      id: randomUUID(),
      inviteId: invite.id,
      deviceName: String(deviceName || '未命名设备').slice(0, 120),
      ip: ip || null,
      userAgent: String(userAgent || '').slice(0, 400),
      pollTokenHash: hashToken(pollToken),
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.ttlMs,
      deviceId: null,
      tokenPlain: null,
      deliveryExpiresAt: null,
    }
    invite.requestId = request.id
    this.requests.set(request.id, request)
    return { pairId: request.id, pollToken, status: request.status, expiresAt: request.expiresAt }
  }

  listRequests() {
    this.cleanup()
    return [...this.requests.values()]
      .filter(request => request.status === 'pending' || request.status === 'approved_pending_delivery')
      .map(publicRequest)
  }

  currentInvite() {
    this.cleanup()
    const invite = this.activeInviteId ? this.invites.get(this.activeInviteId) : null
    if (!invite || invite.status !== 'active') return null
    return { code: invite.code, expiresAt: invite.expiresAt }
  }

  approve(pairId) {
    this.cleanup()
    const request = this.requests.get(pairId)
    if (!request) throw new BridgeError(404, 'pairing_request_not_found', '配对申请不存在')
    if (request.status !== 'pending') throw conflict(`配对申请状态为 ${request.status}`, 'pairing_request_not_pending')
    if (this.corrupt) throw new BridgeError(500, 'devices_corrupt', '设备文件损坏；请先重置设备列表')
    const now = this.now()
    const token = randomBytes(32).toString('hex')
    const device = {
      id: randomUUID(),
      name: request.deviceName,
      ip: request.ip,
      userAgent: request.userAgent,
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: null,
      state: 'pending_delivery',
      revokedAt: null,
    }
    this.devices.push(device)
    request.status = 'approved_pending_delivery'
    request.deviceId = device.id
    request.tokenPlain = token
    request.deliveryExpiresAt = now + this.deliveryTtlMs
    this.persist()
    return { pairId, status: request.status, deviceId: device.id, expiresAt: request.deliveryExpiresAt }
  }

  reject(pairId) {
    this.cleanup()
    const request = this.requests.get(pairId)
    if (!request) throw new BridgeError(404, 'pairing_request_not_found', '配对申请不存在')
    if (request.status !== 'pending') throw conflict(`配对申请状态为 ${request.status}`, 'pairing_request_not_pending')
    request.status = 'rejected'
    return { pairId, status: request.status }
  }

  _requestFor(pairId, pollToken) {
    const request = this.requests.get(pairId)
    if (!request || typeof pollToken !== 'string' || hashToken(pollToken) !== request.pollTokenHash) {
      throw new BridgeError(404, 'pairing_request_not_found', '配对申请不存在或轮询令牌错误')
    }
    return request
  }

  status({ pairId, pollToken }) {
    this.cleanup()
    const request = this._requestFor(pairId, pollToken)
    if (request.status === 'approved_pending_delivery') {
      if (request.deliveryExpiresAt <= this.now()) {
        request.status = 'expired'
        request.tokenPlain = null
        return { pairId, status: 'expired' }
      }
      return { pairId, status: request.status, deviceToken: request.tokenPlain, expiresAt: request.deliveryExpiresAt }
    }
    return { pairId, status: request.status }
  }

  ack({ pairId, pollToken }) {
    this.cleanup()
    const request = this._requestFor(pairId, pollToken)
    if (request.status === 'delivered') return { pairId, status: 'active' }
    if (request.status !== 'approved_pending_delivery') {
      throw conflict(`配对申请状态为 ${request.status}`, 'pairing_request_not_deliverable')
    }
    if (request.deliveryExpiresAt <= this.now()) {
      request.status = 'expired'
      request.tokenPlain = null
      throw conflict('配对令牌交付已过期，请重新配对', 'pairing_delivery_expired')
    }
    const device = this.devices.find(item => item.id === request.deviceId)
    if (!device) throw new BridgeError(404, 'pairing_device_not_found', '配对设备不存在')
    device.state = 'active'
    device.lastSeenAt = this.now()
    request.status = 'delivered'
    request.tokenPlain = null
    this.persist()
    return { pairId, status: 'active' }
  }

  listDevices() {
    this.cleanup()
    return this.devices.filter(device => device.state === 'active' && !device.revokedAt).map(publicDevice)
  }

  revoke(deviceId) {
    const device = this.devices.find(item => item.id === deviceId)
    if (!device || device.revokedAt) throw new BridgeError(404, 'device_not_found', '设备不存在')
    device.state = 'revoked'
    device.revokedAt = this.now()
    this.persist()
    return { ok: true, device: publicDevice(device) }
  }

  authenticate(token) {
    if (this.corrupt || typeof token !== 'string' || token === '') return null
    const hash = hashToken(token)
    const device = this.devices.find(item => item.state === 'active' && !item.revokedAt && item.tokenHash === hash)
    if (!device) return null
    device.lastSeenAt = this.now()
    return { id: device.id, name: device.name }
  }

  clearDevices() {
    this.devices = []
    this.corrupt = false
    this.loadError = null
    this.persist()
  }
}
