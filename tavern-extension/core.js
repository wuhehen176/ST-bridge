// Browser/Node shared, dependency-free request adapter. Only image placeholders are removed.
function privateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true
  const parts = host.split('.')
  if (parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b] = parts.map(Number)
    if (a === 10 || a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  // IPv6 ULA (fc00::/7) and link-local (fe80::/10).
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)
}

export function localBase(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !privateHost(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('只允许本机或私有局域网 HTTP 桥接地址，例如 http://127.0.0.1:43121/v1 或 http://192.168.1.20:43121/v1')
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path !== '/v1' && !/^\/clients\/[a-z][a-z0-9_-]{0,63}\/v1$/.test(path)) throw new Error('桥接地址须为 /v1 或 /clients/插件ID/v1')
  return url.origin + path
}

function endpointId(base) {
  return /^\/clients\/([^/]+)\/v1$/.exec(new URL(base).pathname)?.[1]
}

function destination(url, pageOrigin, body, configured) {
  const endpoint = new URL(url, pageOrigin)
  const proxy = endpoint.origin === pageOrigin && ['/api/backends/chat-completions/generate', '/api/backends/chat-completions/status'].includes(endpoint.pathname)
  let actual
  try {
    if (proxy) {
      if (!['custom', 'openai'].includes(body?.chat_completion_source)) return null
      actual = localBase(body.chat_completion_source === 'custom' ? body.custom_url : body.reverse_proxy)
    } else {
      if (!/\/(chat\/completions|models)$/.test(endpoint.pathname)) return null
      actual = localBase(endpoint.href.replace(/\/(chat\/completions|models)$/, ''))
    }
  } catch { return null }
  if (new URL(actual).origin !== new URL(configured).origin || (endpointId(configured) && actual !== configured)) return null
  return { proxy, actual, id: endpointId(actual), models: proxy ? endpoint.pathname.endsWith('/status') : endpoint.pathname.endsWith('/models') }
}

function proxyEnvelope(body, actual, deviceToken, parseObject) {
  const next = { ...body, chat_completion_source: 'custom', custom_url: actual }
  if (deviceToken || body.chat_completion_source === 'openai') {
    const existing = body.custom_include_headers ? parseObject(body.custom_include_headers) : {}
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('附加请求头必须为对象')
    const previous = Object.entries(existing).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
    const headers = Object.fromEntries(Object.entries(existing).filter(([key]) => key.toLowerCase() !== 'authorization'))
    headers.Authorization = deviceToken ? `Bearer ${deviceToken}` : previous || `Bearer ${body.proxy_password || ''}`
    next.custom_include_headers = JSON.stringify(headers)
  }
  return next
}

export const scopeKey = session => JSON.stringify([session.client_id || 'baibai-image', session.chat_id, session.task_id || 'default'])

export function messageText(message) {
  if (typeof message.content === 'string') return message.content
  if (message.content === null || message.content === undefined) return ''
  if (!Array.isArray(message.content)) throw new Error('只标记明确的文本消息')
  return message.content.map(part => {
    if (typeof part === 'string') return part
    if (part?.type === 'text' && typeof part.text === 'string') return part.text
    throw new Error('不改动非文本请求')
  }).join('\n')
}

function imageRemovalRanges(text, tags = ['bbi_image']) {
  const tokens = new RegExp(`<\\/?(?:${tags.join('|')})(?=[\\s/>])[^>]*>`, 'gi')
  const stack = [], ranges = []
  for (const match of text.matchAll(tokens)) {
    const token = { start: match.index, end: match.index + match[0].length }
    const name = match[0].match(/^<\/?([^\s/>]+)/)[1].toLowerCase()
    if (match[0][1] === '/') {
      const at = stack.findLastIndex(open => open.name === name)
      const open = at >= 0 ? stack.splice(at, 1)[0] : undefined
      ranges.push({ start: open?.start ?? token.start, end: token.end })
    } else if (/\/\s*>$/.test(match[0])) ranges.push(token)
    else stack.push({ ...token, name })
  }
  ranges.push(...stack) // An orphan marker removes only itself, never following prose.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.start < last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

function retainedText(text, start, ranges) {
  let cursor = 0, result = ''
  for (const range of ranges) {
    const from = Math.max(0, range.start - start), to = Math.min(text.length, range.end - start)
    if (to <= from || to <= cursor) continue
    result += text.slice(cursor, from)
    cursor = to
  }
  return result + text.slice(cursor)
}

/** Project a sending copy, preserving rule slots, roles, text-part shapes and caller-owned data. */
export function cleanImageMessages(messages, fixedCount = 0, customTags = []) {
  const tags = [...new Set(['bbi_image', ...customTags.map(tag => String(tag).trim().toLowerCase())])]
  if (tags.length > 65 || tags.some(tag => !/^[a-z][a-z0-9_:-]{0,63}$/.test(tag))) throw new Error('清洗标签须为字母开头的标签名（最长64字符，最多64个），例如 snow；不填尖括号')
  let before = 0, after = 0, regions = 0, changed = false
  const cleaned = messages.map((message, index) => {
    const text = messageText(message)
    before += text.length
    const ranges = index < fixedCount ? [] : imageRemovalRanges(text, tags)
    if (!ranges.length) { after += text.length; return message }
    regions += ranges.length
    let content
    if (typeof message.content === 'string') content = retainedText(text, 0, ranges)
    else {
      let start = 0
      content = message.content.map(part => {
        const value = typeof part === 'string' ? part : part.text
        const next = retainedText(value, start, ranges)
        start += value.length + 1 // messageText joins parts with one newline.
        return next === value ? part : typeof part === 'string' ? next : { ...part, text: next }
      })
    }
    const next = { ...message, content }
    after += messageText(next).length
    changed = true
    return next
  })
  return { messages: changed ? cleaned : messages, cleanup: { kind: tags.length > 1 ? 'configured-tags' : 'bbi_image', tags, attribution: 'adapter-measured', removed_regions: regions, removed_chars: before - after, before_chars: before, after_chars: after } }
}

export function nameMatcher(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 128) throw new Error('条目名规则须为1–128字符')
  if (!(pattern.startsWith('/') && /\/i?$/.test(pattern))) return title => title.toLowerCase().includes(pattern.toLowerCase())
  const expression = pattern.slice(1, pattern.lastIndexOf('/'))
  // Deliberately support a small, bounded regex subset on the main UI thread.
  let inClass = false, repeats = 0
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i]
    if (c === '\\') { if (/\d/.test(expression[i + 1] || '')) throw new Error('不支持正则反向引用'); i++; continue }
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (!inClass && '()|{}'.includes(c)) throw new Error('请使用简单正则，例如 /^规则/；复杂分组与分支暂不支持')
    else if (!inClass && '*+?'.includes(c)) { repeats++; if (expression[i + 1] === '?') i++ }
  }
  if (repeats > 1) throw new Error('简单正则最多一个重复量词，请拆成多条规则')
  const regex = new RegExp(expression, 'i')
  return title => regex.test(title.slice(0, 512))
}

export function validateMaterialsPolicy(value = {}) {
  const list = key => {
    const items = value[key] ?? []
    if (!Array.isArray(items) || items.length > 128 || items.some(item => typeof item !== 'string' || !item.trim() || item.length > (key === 'patterns' ? 128 : 256))) throw new Error('材料名单无效（每类最多128项）')
    return [...new Set(items.map(item => item.trim()))]
  }
  // Legacy green lists are ignored: activation belongs to Tavern, not this adapter.
  const policy = { excluded: list('excluded'), patterns: list('patterns'), tags: list('tags') }
  policy.patterns.forEach(nameMatcher)
  if (policy.tags.length > 64 || policy.tags.some(tag => !/^[a-z][a-z0-9_:-]{0,63}$/i.test(tag))) throw new Error('清洗标签只填标签名，例如 snow（最多64个）')
  return policy
}

export function mergeMaterialsPolicies(globalPolicy = {}, scopePolicy = {}) {
  const policies = [globalPolicy, scopePolicy].map(validateMaterialsPolicy)
  return Object.fromEntries(['excluded', 'patterns', 'tags'].map(key => [key, [...new Set(policies.flatMap(policy => policy[key]))]]))
}

/** Exact full-entry, non-overlapping matches in dynamic system material only. Unknowns stay. */
export function filterWorldMessages(messages, fixedCount, catalog, activated, policy) {
  if (!policy.excluded.length && !policy.patterns.length) return { messages, audit: { removed_chars: 0, changes: [], protected_matches: [], warnings: [] } }
  const patterns = policy.patterns.map(nameMatcher)
  const candidates = new Map()
  for (const entry of [...catalog, ...activated]) {
    if (!entry.world || entry.uid === undefined || typeof entry.content !== 'string' || !entry.content.trim()) continue
    candidates.set(JSON.stringify([entry.world, String(entry.uid), entry.content]), entry)
  }
  const entries = [...candidates.values()], changes = [], protectedMatches = []
  let ambiguous = false
  const result = messages.map((message, index) => {
    const text = messageText(message), matches = []
    for (const entry of entries) {
      const reason = policy.excluded.includes(entry.world) ? 'excluded-book'
        : patterns.some(test => test(String(entry.comment || ''))) ? 'excluded-entry-name' : ''
      let start = 0
      while ((start = text.indexOf(entry.content, start)) >= 0) {
        matches.push({ start, end: start + entry.content.length, entry, reason }); start += entry.content.length
        if (matches.length > 1024) { ambiguous = true; return message }
      }
    }
    if (!matches.length) return message
    if (index < fixedCount || message.role !== 'system') { protectedMatches.push({ message_index: index, reason: 'protected-fixed-or-conversation', matches: matches.length }); return message }
    // Duplicate text shared by two books, or partial overlap with any retained entry, is ambiguous.
    const ranges = matches.filter(m => {
      if (!m.reason) return false
      const overlap = matches.some(other => other !== m && other.start < m.end && m.start < other.end)
      if (overlap) ambiguous = true
      return !overlap
    }).sort((a, b) => a.start - b.start)
    if (!ranges.length) return message
    changes.push(...ranges.map(m => ({ message_index: index, book: m.entry.world, entry_id: String(m.entry.uid), title: String(m.entry.comment || '').slice(0, 256), action: 'remove', reason: m.reason, chars: m.end - m.start })))
    if (typeof message.content === 'string') return { ...message, content: retainedText(text, 0, ranges) }
    let start = 0
    return { ...message, content: message.content.map(part => {
      const value = typeof part === 'string' ? part : part.text, next = retainedText(value, start, ranges)
      start += value.length + 1
      return typeof part === 'string' ? next : { ...part, text: next }
    }) }
  })
  return { messages: changes.length ? result : messages, audit: { removed_chars: changes.reduce((sum, c) => sum + c.chars, 0), changes, protected_matches: protectedMatches,
    warnings: ambiguous ? ['部分条目重复、重叠或匹配过多，无法唯一识别的内容已保留。'] : [] } }
}

// SHA-256 fallback for LAN HTTP pages where SubtleCrypto is not exposed.
// Keep exactly the same digest as the bridge; never downgrade receipt verification.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
function sha256Fallback(input) {
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  padded.set(input)
  padded[input.length] = 0x80
  const view = new DataView(padded.buffer)
  const bits = input.length * 8
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  view.setUint32(padded.length - 4, bits >>> 0)
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const words = new Uint32Array(64)
  const rotate = (x, n) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2]
      words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + words[i]) >>> 0
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    for (const [i, value] of [a, b, c, d, e, f, g, h].entries()) hash[i] += value
  }
  return [...hash].map(word => word.toString(16).padStart(8, '0')).join('')
}
async function digest(text) {
  const input = new TextEncoder().encode(text)
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') return sha256Fallback(input)
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', input)
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

let traceSequence = 0
function traceId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
    return `trace-${[...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}`
  }
  // Correlation only, never an authentication token or an idempotency key.
  return `trace-${Date.now().toString(16)}-${++traceSequence}-${Math.random().toString(16).slice(2)}`
}

export async function messagesDigest(messages) {
  const hashes = await Promise.all(messages.map(message => digest(`${message.role}\0${typeof message.name === 'string' ? message.name : ''}\0${messageText(message)}`)))
  return digest(JSON.stringify(hashes))
}

// These are display copies only. The actual request must never pass through redaction.
export function redactPreview(value, secrets = []) {
  const scrub = text => {
    for (const secret of secrets.filter(s => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[已隐藏]')
    return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已隐藏]')
      .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi, '$1[已隐藏]')
  }
  if (typeof value === 'string') return scrub(value)
  if (Array.isArray(value)) return value.map(item => redactPreview(item, secrets))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(authorization|proxy-authorization|x-api-key|api[_-]?key|key|token|.*[_-]token|password|secret|cookie|set-cookie|custom_include_headers)$/i.test(key)
      ? '[已隐藏]' : redactPreview(item, secrets)]))
}

export function sendingPreview(before, after, beforeMessages, afterMessages, secrets = []) {
  // Pull credential values from explicit transport fields, including serialized headers/body.
  const hidden = [...secrets]
  const collect = value => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (/^(authorization|x-api-key|api[_-]?key|key|token|.*[_-]token|password|secret|cookie)$/i.test(key) && typeof item === 'string') hidden.push(item, item.replace(/^Bearer\s+/i, ''))
      else if (typeof item === 'object') collect(item)
      if (['custom_include_body', 'custom_include_headers'].includes(key) && typeof item === 'string') {
        try { collect(JSON.parse(item)) } catch { /* Unknown serialized values are masked below. */ }
      }
    }
  }
  collect(before); collect(after)
  const bodyCopy = { ...after }
  if (typeof bodyCopy.custom_include_body === 'string') {
    try { bodyCopy.custom_include_body = JSON.stringify(redactPreview(JSON.parse(bodyCopy.custom_include_body), hidden)) }
    catch { bodyCopy.custom_include_body = '[无法解析，预览隐藏]' }
  }
  const changes = beforeMessages.flatMap((message, index) => {
    const a = messageText(message), b = messageText(afterMessages[index])
    if (a === b) return []
    let start = 0, end = 0
    while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++
    while (end < Math.min(a.length, b.length) - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
    return [{ index, role: message.role, before_chars: a.length, after_chars: b.length,
      changed_range: { start, before_end: a.length - end, after_end: b.length - end },
      before_fragment: a.slice(start, a.length - end), after_fragment: b.slice(start, b.length - end) }]
  })
  return JSON.stringify(redactPreview({
    note: '这是浏览器发给酒馆代理／桥接的副本；密钥已隐藏。不是 DSH 历史加规则处理后的完整模型输入。',
    changes, before_messages: beforeMessages, after_messages: afterMessages, outgoing_body: bodyCopy,
  }, hidden), null, 2)
}

export class PreviewCopies {
  constructor(limit = 2, maxChars = 2_000_000) { this.limit = limit; this.maxChars = maxChars; this.copies = new Map() }
  set(id, text) {
    this.copies.delete(id)
    this.copies.set(id, text.length <= this.maxChars ? text : '超过单份预览 200 万字符上限，未保留全文；统计与消息摘要仍可核对，实际发送不截断。')
    while (this.copies.size > this.limit) this.copies.delete(this.copies.keys().next().value)
  }
  get(id) { return this.copies.get(id) }
  clear() { this.copies.clear() }
}

export async function sourceParts(messages, entries) {
  const parts = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    const text = messageText(message)
    const hash = await digest(`${message.role}\0${typeof message.name === 'string' ? message.name : ''}\0${text}`)
    const matches = []
    for (const entry of entries.slice(0, 256)) {
      if (typeof entry.content !== 'string' || !entry.content.trim()) continue
      let start = 0
      while ((start = text.indexOf(entry.content, start)) >= 0) {
        matches.push({ message_index: index, start, end: start + entry.content.length, message_hash: hash, kind: 'worldbook', title: String(entry.comment || `条目 ${entry.uid ?? '?'}`).slice(0, 256), entry_id: String(entry.uid ?? '').slice(0, 256), book: String(entry.world ?? '').slice(0, 256), reason: 'exact text match; activation cache or explicit adapter report' })
        start += entry.content.length
        if (matches.length >= 512) break
      }
      if (matches.length >= 512) break
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end)
    let end = -1
    for (const match of matches) {
      // Identical or overlapping candidate entries do not prove which entry supplied the text.
      if (matches.some(other => other !== match && other.start < match.end && match.start < other.end)) continue
      if (match.start < end) continue
      parts.push(match); end = match.end
      if (parts.length >= 512) return parts
    }
  }
  return parts
}

/** Returns null for any non-matching destination; the caller must forward the original unchanged. */
export async function adaptBody({ url, pageOrigin, body, base, parseObject = JSON.parse, selections = {}, entries = [], materials, autoInject = {}, chatId = '', deviceToken = '', resolveEndpoint, authorization = '' }) {
  const configured = localBase(base)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const target = destination(url, pageOrigin, body, configured)
  if (!target) return null
  const { proxy, actual } = target
  const envelope = proxy ? proxyEnvelope(body, actual, deviceToken, parseObject) : body
  let route
  if (target.id) {
    if (typeof resolveEndpoint !== 'function') throw new Error('插件专属地址需要新版手机扩展，请先连接桥接读取接入清单')
    const headers = proxy && envelope.custom_include_headers ? parseObject(envelope.custom_include_headers) : {}
    const auth = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
    route = await resolveEndpoint(target.id, { base: `${new URL(actual).origin}/v1`, authorization: deviceToken ? `Bearer ${deviceToken}` : auth || authorization })
    if (!route || route.id !== target.id) throw new Error(`未登记的插件接入：${target.id}`)
    if (route.enabled === false) throw new Error(`插件接入已停用：${target.id}`)
  }
  if (target.models) return proxy ? { body: envelope, preview: null, deviceToken } : null
  const include = proxy && body.custom_include_body ? parseObject(body.custom_include_body) : {}
  if (!include || typeof include !== 'object' || Array.isArray(include)) throw new Error('附加主体参数必须为对象')
  const effective = { ...body, ...include }
  let session = effective.dsh_session ?? effective.dshSession ?? effective.metadata?.dsh_session ?? effective.metadata?.dshSession
  const auto = autoInject && typeof autoInject === 'object' ? autoInject : {}
  const safeChatId = String(chatId ?? '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200)
  const injectedChatId = auto.enabled === true && safeChatId ? `${String(auto.prefix ?? '')}${safeChatId}` : ''
  if (route) {
    const declared = [session?.client_id, session?.clientId, effective.client_id, effective.clientId].filter(value => value !== undefined && value !== null && value !== '')
    if (declared.some(value => value !== route.id)) throw new Error('接入地址与请求client_id冲突，请为各插件使用独立预设')
    const routedChat = injectedChatId || session?.chat_id || session?.chatId
    if (!routedChat) throw new Error('插件专属地址需要当前酒馆聊天ID，请开启自动聊天隔离或由插件提供chat_id')
    session = {
      ...session, protocol_version: session?.protocol_version ?? 1, client_id: route.id, chat_id: routedChat,
      task_id: session?.task_id ?? session?.taskId ?? effective.task_id ?? route.taskId ?? 'default',
      action: session?.action ?? 'generate', fixed_message_count: session?.fixed_message_count ?? 0,
      fixed_message_types: session?.fixed_message_types ?? [],
    }
    effective.dsh_session = session
    include.dsh_session = session
  } else if (injectedChatId && safeChatId) {
    if (session && auto.overrideChatId === true && Array.isArray(auto.clients) && auto.clients.includes(session.client_id)) {
      // Rewrite the constant chat_id sent by static presets into a per-chat scope.
      session = { ...session, chat_id: injectedChatId }
      effective.dsh_session = session
      include.dsh_session = session
    } else if (!session) {
      const allowedTypes = ['prefix', 'spec', 'contract', 'check']
      const requestedCount = Number.isInteger(auto.fixedMessageCount) ? Math.max(0, Math.min(4, auto.fixedMessageCount)) : 0
      const fixedTypes = Array.isArray(auto.fixedMessageTypes)
        ? auto.fixedMessageTypes.map(String).filter((type, index, list) => allowedTypes.includes(type) && list.indexOf(type) === index).slice(0, requestedCount)
        : []
      const fixedCount = Math.min(requestedCount, fixedTypes.length)
      session = {
        protocol_version: 1,
        client_id: String(auto.clientId || 'yuzi-phone'),
        chat_id: injectedChatId,
        task_id: String(auto.taskId || 'default'),
        action: 'generate',
        fixed_message_count: fixedCount,
        fixed_message_types: fixedTypes,
      }
      effective.dsh_session = session
      include.dsh_session = session
    }
  }
  if (!session || session.protocol_version !== 1 || typeof session.chat_id !== 'string' || !session.chat_id) return null
  if ((session.action || 'generate') !== 'generate') return null // sync/reset keep their original contract
  // A proxy request may carry dsh_session in the outer body while custom_include_body
  // is what actually reaches the bridge. Always forward the resolved session,
  // otherwise the bridge falls back to plainCompat and collapses separate plugins
  // into one fixed scope.
  if (proxy) include.dsh_session = session
  if (proxy && body.custom_exclude_body) {
    let excluded
    try { excluded = parseObject(body.custom_exclude_body) } catch { excluded = [] }
    const keys = Array.isArray(excluded) ? excluded : typeof excluded === 'string' ? [excluded] : Object.keys(excluded || {})
    if (keys.some(key => ['dsh_context', 'dsh_session', 'messages'].includes(key))) throw new Error('本机上下文适配不能排除 dsh_context、dsh_session 或 messages；已停止该请求')
  }
  if (!Array.isArray(effective.messages)) return null
  const fixedCount = Number.isInteger(session.fixed_message_count) ? session.fixed_message_count : 0
  if (fixedCount < 0 || fixedCount > effective.messages.length) throw new Error('固定规则数量无效，已停止清理请求')
  const material = materials ? await materials(session) : {}
  const policy = mergeMaterialsPolicies(material.globalPolicy, material.policy)
  const knownEntries = material.entries || entries
  const filtered = filterWorldMessages(effective.messages, fixedCount, material.catalog || [], knownEntries, policy)
  const cleaned = cleanImageMessages(filtered.messages, fixedCount, policy.tags)
  const messages = cleaned.messages
  const scope = scopeKey(session)
  const sources = await sourceParts(messages, knownEntries)
  const selection = selections[scope]
  const context = { version: 1, profile_id: typeof selection === 'string' ? selection : selection?.id || 'original', sources,
    ...(selection?.hash ? { profile_hash: selection.hash } : {}) }
  context.transport = { version: 1, adapter_version: '0.4.2', trace_id: traceId(), messages_digest: await messagesDigest(messages) }
  const next = proxy
    ? { ...envelope, messages, custom_include_body: JSON.stringify({ ...include, ...(Object.hasOwn(include, 'messages') ? { messages } : {}), dsh_context: context }) }
    : { ...body, messages, dsh_session: session, dsh_context: context }
  const preview = {
    scope, client_id: session.client_id || 'baibai-image', chat_id: session.chat_id, task_id: session.task_id || 'default',
    profile_id: context.profile_id, materials_mode: filtered.audit.removed_chars || policy.tags.length ? 'client-filtered' : 'keep-all',
    trace_id: context.transport.trace_id, messages_digest: context.transport.messages_digest,
    request_id: session.request_id || effective.request_id, sent_at: new Date().toISOString(),
    cleanup: cleaned.cleanup,
    worldbook_filter: { ...filtered.audit, warnings: [...filtered.audit.warnings, ...(material.warnings || [])] },
    messages: messages.map((message, index) => ({ index, role: message.role, chars: messageText(message).length, required: message.role === 'user' || index < fixedCount })),
    sources: sources.map(({ message_hash, ...part }) => ({ ...part, chars: part.end - part.start, action: 'keep', attribution: '客户端逐字匹配；不是酒馆激活原因证明' })),
  }
  return { body: next, preview, beforeMessages: effective.messages, deviceToken }
}

/** Chain existing interceptors; unmatched requests keep both input and init object identities. */
export function installAdapter(host, options) {
  const original = host.fetch
  const wrapper = async function (input, init) {
    const receiver = this || host
    const forward = () => original.call(receiver, input, init)
    if (!options.enabled()) return forward()
    const request = input && typeof input === 'object' && typeof input.clone === 'function' && typeof input.url === 'string' ? input : null
    const url = new URL(request?.url || String(input), host.location.href)
    const method = String(init?.method || request?.method || 'GET').toUpperCase()
    const base = localBase(options.base())
    if (method === 'GET') {
      const target = destination(url.href, host.location.origin, {}, base)
      const deviceToken = options.deviceToken?.()
      if (!target || target.proxy || !target.models || !deviceToken) return forward()
      const headers = new Headers(init?.headers ?? request?.headers)
      headers.set('authorization', `Bearer ${deviceToken}`)
      return original.call(receiver, input, { ...init, headers })
    }
    if (method !== 'POST') return forward()
    if (!(url.origin === host.location.origin && ['/api/backends/chat-completions/generate', '/api/backends/chat-completions/status'].includes(url.pathname)) && !destination(url.href, host.location.origin, {}, base)) return forward()
    const text = typeof init?.body === 'string' ? init.body : init?.body === undefined && request ? await request.clone().text() : null
    if (!text) return forward()
    let body
    try { body = JSON.parse(text) } catch { return forward() }
    const result = await adaptBody({ url: url.href, pageOrigin: host.location.origin, body, base, parseObject: options.parseObject, selections: options.selections(), entries: options.entries(), materials: options.materials, autoInject: options.autoInject?.() ?? {}, chatId: options.chatId?.() ?? '', deviceToken: options.deviceToken?.() ?? '', resolveEndpoint: options.resolveEndpoint, authorization: new Headers(init?.headers ?? request?.headers).get('authorization') || '' })
    if (!result) return forward()
    if (!result.preview) return original.call(receiver, input, { ...init, method: 'POST', body: JSON.stringify(result.body) })
    try {
      const headers = new Headers(init?.headers ?? request?.headers)
      const secrets = ['authorization', 'x-api-key', 'cookie'].map(key => headers.get(key)).filter(Boolean)
      try {
        const includedHeaders = typeof body.custom_include_headers === 'string' ? (options.parseObject || JSON.parse)(body.custom_include_headers) : body.custom_include_headers
        for (const [key, value] of Object.entries(includedHeaders || {})) if (/^(authorization|x-api-key|cookie)$/i.test(key) && typeof value === 'string') secrets.push(value, value.replace(/^Bearer\s+/i, ''))
      } catch { /* A malformed header envelope is hidden in the display copy. */ }
      options.onPreview(result.preview, body, sendingPreview(body, result.body, result.beforeMessages, result.body.messages, secrets))
    } catch { /* A display failure must not stop or reroute the real request. */ }
    try {
      const outgoingInit = { ...init, method: 'POST', body: JSON.stringify(result.body) }
      if (result.deviceToken && url.origin !== host.location.origin) {
        const headers = new Headers(init?.headers ?? request?.headers)
        headers.set('authorization', `Bearer ${result.deviceToken}`)
        outgoingInit.headers = headers
      }
      const response = await original.call(receiver, input, outgoingInit)
      void response.clone().json().then(data => options.onResult?.(result.preview.trace_id, data.bridge?.context, response.status, data.error?.message, data.bridge?.receipt, data.dsh_session?.request_id)).catch(() => {})
      return response
    } catch (error) {
      options.onResult?.(result.preview.trace_id, undefined, 0, '请求传输失败；未重试或改走其他接口')
      throw error
    }
  }
  host.fetch = wrapper
  return () => { if (host.fetch === wrapper) host.fetch = original }
}
