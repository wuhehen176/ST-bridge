import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { ensureDir } from './util.js'

const MAX_BYTES = 5 * 1024 * 1024

export function createLogger({ file, ctx, name }) {
  ensureDir(dirname(file))
  let serviceLogger
  try {
    serviceLogger = ctx?.logger?.(name)
  } catch {
    serviceLogger = undefined
  }

  function rotateIfNeeded() {
    try {
      if (!existsSync(file)) return
      if (statSync(file).size < MAX_BYTES) return
      renameSync(file, `${file}.1`)
    } catch {
      // Logging must never break a request.
    }
  }

  return function log(message) {
    const line = `${new Date().toISOString()} ${message}\n`
    try {
      rotateIfNeeded()
      appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Ignore file-system logging failures.
    }
    try {
      serviceLogger?.info(message)
    } catch {
      // Ignore logger service failures.
    }
  }
}
