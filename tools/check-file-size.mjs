#!/usr/bin/env node
// Keep new files small and stop already-large files from growing further.
// Usage: node tools/check-file-size.mjs --staged|--all
import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const WARN_BYTES = 20 * 1024
const HARD_BYTES = 50 * 1024

// Existing files above HARD_BYTES are allowed at their current size only.
// Shrinking them is welcome; growing them costs a deliberate baseline bump.
const BASELINE = new Map([
  ['lib/engine.js', 93844],
  ['test/session-protocol.test.mjs', 93231],
  ['client.js', 62440],
])

const args = new Set(process.argv.slice(2))
const staged = args.has('--staged')
const all = args.has('--all') || (!staged && !args.size)
if (staged && all) {
  console.error('choose either --staged or --all')
  process.exit(2)
}

function gitFiles() {
  const out = staged
    ? execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: ROOT, encoding: 'utf8' })
    : execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  return out.split(/\r?\n/).filter(Boolean)
}

const errors = []
const warnings = []
for (const file of gitFiles()) {
  if (file === 'CON' || file.endsWith('/CON')) continue
  const absolute = resolve(ROOT, file)
  if (!absolute.startsWith(ROOT + sep) || !existsSync(absolute)) continue
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    continue
  }
  if (!stat.isFile()) continue

  const baseline = BASELINE.get(file)
  if (baseline !== undefined) {
    if (stat.size > baseline) {
      errors.push(`${file}: ${stat.size} bytes exceeds baseline ${baseline}; split it or update the baseline deliberately`)
    } else if (stat.size > WARN_BYTES) {
      warnings.push(`${file}: ${stat.size} bytes (large, baseline ${baseline})`)
    }
    continue
  }
  if (stat.size > HARD_BYTES) {
    errors.push(`${file}: ${stat.size} bytes exceeds the ${HARD_BYTES}-byte limit; split it before committing`)
  } else if (stat.size > WARN_BYTES) {
    warnings.push(`${file}: ${stat.size} bytes (large; consider splitting)`)
  }
}

for (const warning of warnings) console.warn(`warn: ${warning}`)
if (errors.length) {
  for (const error of errors) console.error(`error: ${error}`)
  console.error(`file-size gate failed (${errors.length} error${errors.length === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log(`file-size gate passed${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}`)
