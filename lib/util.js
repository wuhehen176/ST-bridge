import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

export function randomId(prefix = '') {
  return `${prefix}${randomUUID()}`
}

export function nowIso() {
  return new Date().toISOString()
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

/** Atomic JSON write: write a sibling temp file, then rename over the target. */
export function writeJsonAtomic(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

export function samePath(left, right) {
  if (!left || !right) return false
  try {
    return resolve(left).toLowerCase() === resolve(right).toLowerCase()
  } catch {
    return false
  }
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8')
  const b = Buffer.from(String(right ?? ''), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function sleep(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

export function clampInteger(value, min, max) {
  if (!Number.isSafeInteger(value)) return undefined
  return Math.min(max, Math.max(min, value))
}

export function truncateUtf8(value, maxBytes) {
  const text = String(value ?? '')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let result = ''
  for (const char of text) {
    if (Buffer.byteLength(result + char, 'utf8') > maxBytes) break
    result += char
  }
  return result
}

export function hashRequest(value) {
  return sha256(JSON.stringify(value))
}
