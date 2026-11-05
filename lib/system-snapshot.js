import { randomUUID } from 'node:crypto'
import { upstreamError } from './errors.js'
import { carriesManagedPreset } from './preset-policy.js'
import { formatTurnPolicy } from './session-protocol.js'
import { sha256 } from './util.js'

export const SYSTEM_SNAPSHOT_MODES = ['native', 'filled', 'empty']

export function normalizeSystemSnapshotMode(value) {
  return SYSTEM_SNAPSHOT_MODES.includes(value) ? value : 'native'
}

/**
 * Maintains the protocol session's derived system node.
 *
 * DSH normally owns the leading system node and re-renders it as the derived
 * prompt changes. Older bridge versions replaced that node with an empty
 * system/message and assumed DSH would refill it; this DSH treats the empty
 * node as final, so the model silently loses the worldbook / fixed rules.
 *
 * Modes:
 *  - native: never replace the node; let DSH update it (default, safe).
 *  - filled: replace the boundary, but write the actual rendered system text.
 *  - empty: legacy diagnostic mode; writes an empty node (never use in prod).
 */
export class SystemSnapshot {
  constructor({ mode = 'native', log = () => {} } = {}) {
    this.mode = normalizeSystemSnapshotMode(mode)
    this.log = log
  }

  modeFor(runtime) {
    return normalizeSystemSnapshotMode(runtime?.systemSnapshotMode ?? this.mode)
  }

  apply({ runtime, position, session, renderedText = '' } = {}) {
    const mode = this.modeFor(runtime)
    if (!runtime?.protocol || !String(runtime.sessionId ?? '').startsWith('session-st-')) {
      return { mode, replaced: 0, skipped: 'not-protocol' }
    }
    const target = session ?? runtime.session
    const canSurface = Array.isArray(target?.surface?.nodes)
      && typeof target.eventAt === 'function' && typeof target.append === 'function'
    if (!canSurface) {
      // Native mode must never turn a missing surface into a failed turn.
      if (mode === 'native') return { mode, replaced: 0, skipped: 'native-unavailable' }
      throw upstreamError('当前 DSH 不支持系统快照的原生 surface 替换，已停止本轮以避免重复累积', 'system_snapshot_unavailable')
    }

    const text = String(renderedText ?? runtime.renderedSystemText ?? '')
    if (mode !== 'empty' && text.trim() === '') {
      this.log(`[system-snapshot] mode=${mode} skipped=empty-render session=${runtime.sessionId}`)
      return { mode, replaced: 0, skipped: 'empty-render' }
    }

    const eventText = event => (event?.data?.message?.content ?? [])
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    const nodes = target.surface.nodes.map(seq => ({ seq, event: target.eventAt(seq) }))
      .filter(({ event }) => {
        if (event?.type !== 'system/message') return false
        const text = eventText(event)
        return text.trim() === ''
          || text.includes('<<<FIXED_RULE ') || text.includes('<<<DYNAMIC_SYSTEM ')
          || text.includes('<skill_content name=')
          || carriesManagedPreset(text)
          || text.includes(formatTurnPolicy())
      })
    if (nodes.length === 0) {
      return { mode, replaced: 0, skipped: 'no-node' }
    }

    // Native mode normally does nothing. The exception is a node left empty by
    // an older bridge version: repair it once with the actual rendered prompt,
    // otherwise that session would keep losing the worldbook forever.
    const replaceNodes = mode === 'native'
      ? nodes.filter(({ event }) => eventText(event).trim() === '')
      : nodes
    if (replaceNodes.length === 0) {
      return { mode, replaced: 0, skipped: 'native' }
    }

    const snapshotKey = sha256(JSON.stringify([
      mode,
      text,
      runtime.managedPreset,
      runtime.fixedRules,
      runtime.dynamicSystem,
      runtime.skillHash,
    ]))
    if (replaceNodes.length === 1 && runtime.lastSystemSnapshotKey === snapshotKey) {
      return { mode, replaced: 0, skipped: 'unchanged' }
    }

    const content = mode === 'empty'
      ? []
      : [{ type: 'text', text }]
    for (const { seq } of replaceNodes.toReversed()) {
      target.append('system/message', {
        turn: position?.turn ?? 1,
        step: position?.step ?? 1,
        message: { id: randomUUID(), role: 'system', content, source: { kind: 'system-prompt' } },
      }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    }
    runtime.lastSystemSnapshotKey = snapshotKey
    const bytes = Buffer.byteLength(text, 'utf8')
    this.log(`[system-snapshot] mode=${mode} replaced=${replaceNodes.length} text=${bytes}B session=${runtime.sessionId}`)
    return { mode, replaced: replaceNodes.length }
  }
}
