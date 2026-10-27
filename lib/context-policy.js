import { badRequest } from './errors.js'
import { copyFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { messageHash } from './context.js'
import { isPlainObject, readJsonFile, sha256, writeJsonAtomic } from './util.js'

const fail = message => { throw badRequest(message, 'invalid_context_policy') }
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
const KINDS = new Set(['worldbook', 'character', 'state', 'target', 'history', 'unknown'])

/** User-authored profiles live beside settings/state, never in the release package. */
export class ContextProfiles {
  constructor(file) { this.file = file }
  read() {
    let value
    try { value = readJsonFile(this.file, { version: 1, profiles: [] }) }
    catch { fail('本机规则档位库无法读取，请检查文件或通过导入修复；未改动请求正文') }
    return validateProfiles(value)
  }
  save(value) {
    const clean = validateProfiles(value)
    if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak-${Date.now()}-${randomUUID().slice(0, 8)}`)
    writeJsonAtomic(this.file, clean)
    return this.list()
  }
  list() {
    return { version: 1, profiles: this.read().profiles.map(({ replace, ...profile }) => ({ ...profile, slots: Object.keys(replace), hash: sha256(JSON.stringify(replace)) })) }
  }
  resolve(id, scope, expectedHash) {
    if (!id || id === 'original') return { id: 'original', label: '完整兼容（原始规则）', replace: {} }
    const profile = this.read().profiles.find(p => p.id === id)
    if (!profile) fail(`规则档位不存在: ${id}`)
    if (profile.client_id !== scope.clientId || profile.task_id !== scope.taskId) fail('规则档位与 client_id/task_id 不匹配，已停止发送')
    if (expectedHash && sha256(JSON.stringify(profile.replace)) !== expectedHash) fail('规则档位已被修改，请重新读取档位并确认后发送')
    return profile
  }
}

export function validateProfiles(value) {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 64) fail('档位文件须为 version:1、profiles 数组（最多64项）')
  const seen = new Set()
  const profiles = value.profiles.map(p => {
    if (!isPlainObject(p) || !identifier(p.id) || p.id === 'original' || seen.has(p.id)) fail('规则档位 ID 无效、重复或占用 original')
    seen.add(p.id)
    if (!identifier(p.client_id) || typeof p.task_id !== 'string' || !p.task_id || p.task_id.length > 256 || /[\x00-\x1f]/.test(p.task_id)) fail('每个档位必须指定有效 client_id 和 task_id')
    if (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 128) fail('档位名称不能为空或超过128字')
    if (!isPlainObject(p.replace) || !Object.keys(p.replace).length || Object.keys(p.replace).some(k => !['spec', 'check'].includes(k))) fail('第一版只允许替换 spec/check；prefix 和 contract 保留')
    const replace = {}
    for (const [type, text] of Object.entries(p.replace)) {
      if (typeof text !== 'string' || !text.trim() || text.length > 250_000) fail(`${type} 须为非空规则正文，最长250000字符`)
      replace[type] = text
    }
    return { id: p.id, label: p.label.trim(), client_id: p.client_id, task_id: p.task_id, replace }
  })
  return { version: 1, profiles }
}

export function parseContextRequest(value, messages) {
  if (value === undefined) return undefined
  if (!isPlainObject(value) || value.version !== 1) fail('dsh_context.version 必须为1')
  const profile_id = value.profile_id ?? 'original'
  if (!identifier(profile_id)) fail('dsh_context.profile_id 无效')
  if (value.profile_hash !== undefined && (typeof value.profile_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.profile_hash))) fail('dsh_context.profile_hash 无效')
  if (!Array.isArray(value.sources) || value.sources.length > 512) fail('dsh_context.sources 必须为数组（最多512项）')
  const sources = value.sources.map(part => {
    if (!isPlainObject(part) || !KINDS.has(part.kind)) fail('无效的来源类别')
    const { message_index: index, start, end } = part
    const message = messages[index]
    if (!Number.isInteger(index) || !message || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > message.text.length) fail('来源区间超出实际消息')
    if (part.message_hash !== message.hash) fail('来源标记与实际消息 Hash 不符；请重新生成预览')
    const clean = { message_index: index, start, end, kind: part.kind, message_hash: part.message_hash }
    for (const key of ['title', 'entry_id', 'book', 'reason']) {
      if (part[key] !== undefined) {
        if (typeof part[key] !== 'string' || part[key].length > 256) fail(`来源 ${key} 无效`)
        clean[key] = part[key]
      }
    }
    return clean
  }).sort((a, b) => a.message_index - b.message_index || a.start - b.start)
  sources.forEach((s, i) => {
    const previous = sources[i - 1]
    if (previous?.message_index === s.message_index && previous.end > s.start) fail('来源区间重叠，无法可靠统计')
  })
  return { version: 1, profile_id, sources, ...(value.profile_hash ? { profile_hash: value.profile_hash } : {}) }
}

export function applyContextProfile(rules, profile) {
  for (const type of Object.keys(profile.replace)) {
    if (!rules.some(rule => rule.type === type)) fail(`当前请求没有明确的 ${type} 固定规则槽；此档位不能猜测替换普通 system 消息`)
  }
  return rules.map(rule => {
    const text = profile.replace[rule.type]
    return text === undefined ? rule : { ...rule, text, hash: messageHash(rule.role, text) }
  })
}

/** First release is preview-only for materials: nothing is truncated or filtered. */
export function contextAudit(messages, fixedCount, request, profile, rules, effectiveRules) {
  const parts = []
  messages.forEach((message, index) => {
    let cursor = 0
    const slices = request.sources.filter(s => s.message_index === index)
    for (const s of slices) {
      if (cursor < s.start) parts.push({ message_index: index, kind: index < fixedCount ? 'fixed-rule' : 'unknown', chars: s.start - cursor, action: 'keep', required: message.role === 'user' || index < fixedCount })
      const { message_hash, start, end, ...source } = s
      parts.push({ ...source, chars: end - start, action: 'keep', required: message.role === 'user' || index < fixedCount, attribution: 'client-reported; range/hash validated' })
      cursor = s.end
    }
    if (cursor < message.text.length) parts.push({ message_index: index, kind: index < fixedCount ? 'fixed-rule' : 'unknown', chars: message.text.length - cursor, action: 'keep', required: message.role === 'user' || index < fixedCount })
  })
  return {
    version: 1, profile_id: profile.id, profile_label: profile.label,
    profile_hash: sha256(JSON.stringify(profile.replace)), effective_rules_hash: sha256(JSON.stringify(effectiveRules)),
    materials_mode: 'keep-all', input_chars: messages.reduce((n, m) => n + m.text.length, 0),
    rule_chars_before: rules.reduce((n, r) => n + r.text.length, 0), rule_chars_after: effectiveRules.reduce((n, r) => n + r.text.length, 0),
    estimated_tokens: null, parts,
  }
}
