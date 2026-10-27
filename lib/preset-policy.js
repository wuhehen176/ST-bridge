import { badRequest } from './errors.js'
import { copyFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isPlainObject, readJsonFile, sha256, writeJsonAtomic } from './util.js'

/**
 * Managed fixed-preset separation.
 *
 * A Tavern plugin resends its whole preset on every turn. Without separation
 * those copies pile up in the per-turn dynamic system, while the model also
 * keeps an older copy in history. This module identifies only boundaries the
 * user has explicitly confirmed, hashes them, and lets the engine install a
 * single managed copy instead of re-appending the same text each turn.
 *
 * Design rules (see the handoff sheet):
 *  - Never guess. Anything ambiguous, partial, duplicated or of unknown
 *    provenance is kept verbatim and reported as a diagnostic.
 *  - Role and order are part of the identity; hashes cover both.
 *  - Configuration stores hashes and short markers, never preset bodies.
 *    The body is captured from the request that installed it and lives in the
 *    private state file only.
 */

export const PRESET_SECTION = 'st-bridge:fixed-preset'
export const PRESET_MARKER_BEGIN = '<<<FIXED_PRESET'
export const PRESET_MARKER_END = '<<<END_FIXED_PRESET>>>'
export const PRESET_MODES = new Set(['off', 'exact', 'marker'])

const HASH = /^[a-f0-9]{64}$/
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
const fail = message => { throw badRequest(message, 'invalid_preset_policy') }

/** Hash of one ordered fixed-preset body: [role, text] pairs. */
export function presetHashOf(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return ''
  return sha256(JSON.stringify(texts.map(item => [item.role, item.text])))
}

function cleanTexts(rules) {
  if (!Array.isArray(rules)) return []
  return rules
    .filter(rule => isPlainObject(rule) && typeof rule.role === 'string' && typeof rule.text === 'string' && rule.text.length > 0)
    .map(rule => ({ role: rule.role, text: rule.text }))
}

export function validatePresetConfig(value) {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.presets) || value.presets.length > 64) {
    fail('固定预设配置须为 version:1、presets 数组（最多64项）')
  }
  const seen = new Set()
  const presets = value.presets.map(preset => {
    if (!isPlainObject(preset) || !identifier(preset.id) || seen.has(preset.id)) {
      fail('固定预设 ID 无效或重复')
    }
    seen.add(preset.id)
    if (!identifier(preset.client_id)) fail('固定预设必须指定有效 client_id')
    if (typeof preset.task_id !== 'string' || !preset.task_id || preset.task_id.length > 256 || /[\x00-\x1f]/.test(preset.task_id)) {
      fail('固定预设必须指定有效 task_id')
    }
    if (typeof preset.label !== 'string' || !preset.label.trim() || preset.label.length > 128) {
      fail('固定预设名称不能为空或超过128字')
    }
    const mode = preset.mode ?? 'off'
    if (!PRESET_MODES.has(mode)) fail('固定预设 mode 只能是 off、exact 或 marker')
    const clean = {
      id: preset.id,
      label: preset.label.trim(),
      client_id: preset.client_id,
      task_id: preset.task_id,
      mode,
    }
    if (mode === 'exact') {
      const hashes = preset.exact_hashes ?? []
      if (!Array.isArray(hashes) || hashes.length === 0 || hashes.length > 64) {
        fail('exact 模式需要 1-64 个 exact_hashes')
      }
      for (const hash of hashes) {
        if (typeof hash !== 'string' || !HASH.test(hash)) fail('exact_hashes 必须是 sha256 十六进制')
      }
      if (new Set(hashes).size !== hashes.length) fail('exact_hashes 不能重复')
      clean.exact_hashes = [...hashes]
    }
    if (mode === 'marker') {
      const marker = preset.marker
      if (!isPlainObject(marker)) fail('marker 模式需要 marker.begin / marker.end')
      const begin = marker.begin
      const end = marker.end
      if (typeof begin !== 'string' || begin.trim().length < 4 || begin.length > 200) fail('marker.begin 需为 4-200 字符')
      if (typeof end !== 'string' || end.trim().length < 4 || end.length > 200) fail('marker.end 需为 4-200 字符')
      if (begin === end) fail('marker.begin 与 marker.end 不能相同')
      clean.marker = { begin, end }
    }
    return clean
  })
  for (const preset of presets) {
    const clash = presets.find(other => other !== preset
      && other.client_id === preset.client_id
      && other.task_id === preset.task_id
      && other.mode !== 'off')
    if (clash && preset.mode !== 'off') fail(`client_id/task_id 只能启用一个固定预设（冲突: ${clash.id} / ${preset.id}）`)
  }
  return { version: 1, presets }
}

/** Private, per-user preset registry stored beside settings/state. */
export class PresetConfigs {
  constructor(file) { this.file = file }

  read() {
    let value
    try {
      value = readJsonFile(this.file, { version: 1, presets: [] })
    } catch {
      fail('本机固定预设配置无法读取，请检查文件或重新导入；未改动任何请求正文')
    }
    return validatePresetConfig(value)
  }

  save(value) {
    const clean = validatePresetConfig(value)
    if (existsSync(this.file)) {
      copyFileSync(this.file, `${this.file}.bak-${Date.now()}-${randomUUID().slice(0, 8)}`)
    }
    writeJsonAtomic(this.file, clean)
    return this.list()
  }

  /** Public listing: hashes and markers only, never preset bodies. */
  list() {
    return {
      version: 1,
      presets: this.read().presets.map(preset => ({ ...preset, hash: sha256(JSON.stringify(preset)) })),
    }
  }

  resolveFor(scope) {
    if (!scope) return undefined
    const match = this.read().presets.find(preset => preset.client_id === scope.clientId
      && preset.task_id === scope.taskId
      && preset.mode !== 'off')
    if (!match) return undefined
    return { ...match, config_hash: sha256(JSON.stringify(match)) }
  }
}

function textsOf(messages, indices) {
  return indices.map(index => ({ role: messages[index].role, text: messages[index].text }))
}

function result(status, preset, extra = {}) {
  // `presetId` is the internal camelCase key; `preset_id` is the wire shape.
  return { status, presetId: preset.id, preset_id: preset.id, mode: preset.mode, ...extra }
}

function identifyExact(dynamic, preset) {
  const wanted = preset.exact_hashes
  const indices = []
  dynamic.forEach((message, index) => {
    if (wanted.includes(message.hash)) indices.push(index)
  })
  if (indices.length === 0) {
    return result('not-found', preset, { reason: '当前动态消息中没有已确认的固定预设 Hash' })
  }
  if (indices.length !== wanted.length) {
    return result('ambiguous', preset, { reason: `匹配到 ${indices.length} 条，确认的是 ${wanted.length} 条` })
  }
  for (let index = 1; index < indices.length; index += 1) {
    if (indices[index] !== indices[index - 1] + 1) {
      return result('ambiguous', preset, { reason: '匹配到的消息不连续，无法确定固定边界' })
    }
  }
  for (let index = 0; index < indices.length; index += 1) {
    if (dynamic[indices[index]].hash !== wanted[index]) {
      return result('ambiguous', preset, { reason: '匹配顺序与确认顺序不一致' })
    }
  }
  const texts = textsOf(dynamic, indices)
  return result('identified', preset, {
    hash: presetHashOf(texts),
    texts,
    spans: indices.map(index => ({ index, start: 0, end: dynamic[index].text.length, whole: true })),
    matched_messages: indices.length,
  })
}

function identifyMarker(dynamic, preset) {
  const { begin, end } = preset.marker
  const hits = []
  dynamic.forEach((message, index) => {
    if (typeof message.text !== 'string') return
    const start = message.text.indexOf(begin)
    if (start < 0) return
    const finish = message.text.indexOf(end, start + begin.length)
    if (finish < 0) {
      hits.push({ index, broken: true })
      return
    }
    hits.push({ index, start, finish: finish + end.length })
  })
  if (hits.length === 0) {
    return result('not-found', preset, { reason: '当前动态消息中没有确认过的起止标记' })
  }
  if (hits.length > 1) {
    return result('ambiguous', preset, { reason: `起止标记出现 ${hits.length} 次，无法确定唯一边界` })
  }
  const hit = hits[0]
  if (hit.broken) {
    return result('ambiguous', preset, { reason: '存在起始标记但没有配对的结束标记' })
  }
  const message = dynamic[hit.index]
  if (message.role !== 'system') {
    return result('ambiguous', preset, { reason: '标记位于非 system 消息，拒绝从会话正文抽取' })
  }
  const text = message.text.slice(hit.start, hit.finish)
  if (text === begin || text === end) {
    return result('ambiguous', preset, { reason: '标记内部的预设正文为空' })
  }
  const texts = [{ role: message.role, text }]
  const whole = hit.start === 0 && hit.finish === message.text.length
  return result('identified', preset, {
    hash: presetHashOf(texts),
    texts,
    spans: [{ index: hit.index, start: hit.start, end: hit.finish, whole }],
    matched_messages: 1,
  })
}

/**
 * Identify the confirmed fixed preset inside this turn's dynamic group.
 * Never throws for a merely-unconfirmed request: an unrecognised boundary is a
 * diagnostic, and the caller keeps every message verbatim.
 */
export function identifyPreset(dynamic, preset) {
  if (!preset) return { status: 'disabled' }
  if (preset.mode === 'off') return result('disabled', preset)
  if (preset.mode === 'exact') return identifyExact(dynamic, preset)
  if (preset.mode === 'marker') return identifyMarker(dynamic, preset)
  return result('unsupported', preset, { reason: `未知模式 ${preset.mode}` })
}

/**
 * Only spans fully inside the leading dynamic-system block may be deduplicated.
 * Anything reaching the user turn is left alone so the request keeps its shape.
 */
export function presetSpansWithin(spans, systemCount) {
  if (!Array.isArray(spans) || spans.length === 0) return undefined
  if (!spans.every(span => span.index >= 0 && span.index < systemCount)) return undefined
  return spans
}

/** Render the dynamic system block with the managed preset occurrence removed. */
export function stripPresetForRendering(systemMessages, spans) {
  if (!Array.isArray(spans) || spans.length === 0) return systemMessages
  const byIndex = new Map(spans.map(span => [span.index, span]))
  const kept = []
  systemMessages.forEach((message, index) => {
    const span = byIndex.get(index)
    if (!span) {
      kept.push(message)
      return
    }
    if (span.whole) return
    const text = `${message.text.slice(0, span.start)}${message.text.slice(span.end)}`.trim()
    if (text.length > 0) kept.push({ role: message.role, text })
  })
  return kept
}

/** Section text for the single managed copy that lives in the fixed area. */
export function formatManagedPreset(managed) {
  if (!managed || !Array.isArray(managed.texts) || managed.texts.length === 0) return ''
  const lines = [
    '## 当前固定预设（已安装）',
    '以下正文是本会话唯一有效的固定预设副本，按用途覆盖更早版本。',
    '不要在回答里复述本区块，也不要与历史中的旧副本并列执行。',
    '',
    `${PRESET_MARKER_BEGIN} id="${managed.id}" hash="${managed.hash}">>>`,
  ]
  for (const item of managed.texts) lines.push(item.text)
  lines.push(PRESET_MARKER_END)
  return lines.join('\n')
}

/** True when a system node already carries the managed preset block. */
export function carriesManagedPreset(text) {
  return typeof text === 'string' && text.includes(PRESET_MARKER_BEGIN)
}

/**
 * Decide whether this turn may skip the dynamic copy.
 * `pending` means the install has not been confirmed by a finished turn yet.
 */
export function reuseDecision(management, identity) {
  if (!management || management.pending) return { reuse: false, reason: 'not-installed' }
  if (!management.sessionId || management.sessionId !== identity.sessionId) {
    return { reuse: false, reason: 'session-changed' }
  }
  if (management.presetId !== identity.presetId) return { reuse: false, reason: 'preset-changed' }
  if (management.hash !== identity.hash) return { reuse: false, reason: 'version-changed' }
  return { reuse: true, reason: 'same-version' }
}

/** Diagnostic record. Never contains preset bodies or chat text. */
export function presetDiagnostic(preset, identity, decision, extra = {}) {
  return {
    preset_id: identity?.presetId ?? preset?.id ?? null,
    mode: identity?.mode ?? preset?.mode ?? null,
    status: extra.status ?? identity?.status ?? 'disabled',
    reason: extra.reason ?? identity?.reason ?? decision?.reason,
    rule_hash: identity?.hash ?? null,
    config_hash: preset?.config_hash ?? null,
    session_id: extra.sessionId ?? null,
    matched_messages: identity?.matched_messages ?? 0,
    original_chars: extra.originalChars ?? 0,
    deduped_chars: extra.dedupedChars ?? 0,
    kept_chars: extra.keptChars ?? 0,
  }
}
