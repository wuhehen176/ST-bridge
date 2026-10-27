import { badRequest } from './errors.js'
import { sha256, truncateUtf8 } from './util.js'

const ROLES = new Set(['system', 'user', 'assistant'])

function textFromContent(content, index) {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (Array.isArray(content)) {
    const parts = []
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part)
        continue
      }
      if (part && part.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text)
        continue
      }
      throw badRequest(
        `messages[${index}].content 只支持文本；收到不支持的片段 ${JSON.stringify(part?.type ?? typeof part)}。` +
        '桥接不会静默丢弃非文本内容，请在上游转换为纯文本后重试。',
        'unsupported_content',
      )
    }
    return parts.join('\n')
  }
  throw badRequest(`messages[${index}].content 必须是字符串或文本片段数组`, 'invalid_content')
}

/**
 * Normalize OpenAI-style messages without trimming, dropping, or reordering.
 * Every message keeps its exact text and role; only the content envelope is
 * flattened into a string.
 */
export function normalizeMessages(raw, { allowEmpty = false } = {}) {
  if (!Array.isArray(raw)) {
    throw badRequest('messages 必须是数组', 'invalid_messages')
  }
  if (raw.length === 0) {
    if (allowEmpty) return { messages: [], bytes: 0 }
    throw badRequest('messages 必须是非空数组', 'invalid_messages')
  }
  const messages = []
  let bytes = 0
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw badRequest(`messages[${index}] 必须是对象`, 'invalid_messages')
    }
    const role = item.role
    if (!ROLES.has(role)) {
      throw badRequest(`messages[${index}].role 必须是 system、user 或 assistant`, 'invalid_role')
    }
    const text = textFromContent(item.content, index)
    const name = typeof item.name === 'string' && item.name !== '' ? item.name : undefined
    bytes += Buffer.byteLength(text, 'utf8')
    messages.push({
      role,
      text,
      ...(name ? { name } : {}),
      hash: messageHash(role, text, name),
    })
  }
  if (bytes === 0) throw badRequest('messages 的内容为空', 'empty_messages')
  return { messages, bytes }
}

export function messageHash(role, text, name) {
  return sha256(`${role}\u0000${name ?? ''}\u0000${text}`)
}

export function sameMessage(left, right) {
  return left?.role === right?.role
    && (left?.name ?? '') === (right?.name ?? '')
    && left?.text === right?.text
}

function longestCommonPrefix(left, right) {
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && sameMessage(left[index], right[index])) index += 1
  return index
}

/** Largest k where known[-k..] equals incoming[0..k). */
function suffixPrefixMatch(known, incoming) {
  const max = Math.min(known.length, incoming.length)
  for (let size = max; size > 0; size -= 1) {
    let hit = true
    for (let offset = 0; offset < size; offset += 1) {
      if (!sameMessage(known[known.length - size + offset], incoming[offset])) {
        hit = false
        break
      }
    }
    if (hit) return size
  }
  return 0
}

function classifyFull(known, incoming) {
  const prefix = longestCommonPrefix(known, incoming)
  if (prefix === known.length) {
    if (incoming.length === known.length) {
      return { kind: 'regenerate', replay: incoming, reason: 'same_context' }
    }
    const suffix = incoming.slice(known.length)
    if (suffix.some(message => message.role !== 'assistant')) {
      return { kind: 'append', newMessages: suffix, delta: false, fullContext: true }
    }
    return { kind: 'regenerate', replay: incoming, reason: 'assistant_only_suffix' }
  }
  if (prefix === incoming.length) {
    return { kind: 'branch', replay: incoming, reason: 'rollback_or_truncation' }
  }
  return { kind: 'branch', replay: incoming, reason: 'divergence' }
}

/**
 * Decide how an incoming message list relates to the messages already sent to
 * the DSH session.
 *
 * - initial: no session yet; send the complete context.
 * - append: the incoming list extends (or explicitly adds to) known context.
 * - regenerate: same/truncated context without new material; rebuild a branch.
 * - branch: an old floor was rewritten or rolled back; rebuild a branch.
 * - duplicate: the entire incoming list is already known; do not call the model.
 *
 * `context_mode` may force `full`, `delta`, or `branch`. Auto mode treats a
 * system-less incoming list as a delta when the known context starts with a
 * system message, which supports clients that send only the new turn.
 */
export function classifyContext(known, incoming, mode = 'auto') {
  if (!Array.isArray(known) || known.length === 0) {
    return { kind: 'initial', replay: incoming, reason: 'new_session' }
  }
  if (mode === 'branch') {
    return { kind: 'branch', replay: incoming, reason: 'explicit_branch' }
  }
  if (mode === 'delta') {
    return { kind: 'append', newMessages: incoming, delta: true, fullContext: false }
  }
  if (mode === 'full') {
    return classifyFull(known, incoming)
  }

  if (known[0]?.role === 'system' && incoming[0]?.role !== 'system') {
    const matched = suffixPrefixMatch(known, incoming)
    if (matched === incoming.length) {
      return { kind: 'duplicate', replay: incoming, reason: 'delta_already_known' }
    }
    return {
      kind: 'append',
      newMessages: incoming.slice(matched),
      delta: true,
      fullContext: false,
      matchedPrefix: matched,
    }
  }
  return classifyFull(known, incoming)
}

function messageBlock(message, index) {
  const name = message.name ? ` name="${escapeAttribute(message.name)}"` : ''
  return [
    `<<<ST_BRIDGE_MESSAGE role="${message.role}" index="${index}"${name}>>>`,
    message.text,
    '<<<END_ST_BRIDGE_MESSAGE>>>',
  ].join('\n')
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function contextBlock(messages) {
  return messages.map((message, index) => messageBlock(message, index)).join('\n\n')
}

function lastUser(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return { message: messages[index], index }
  }
  return undefined
}

function takeCurrentRequest(messages) {
  const last = messages[messages.length - 1]
  if (last?.role === 'user') {
    return { context: messages.slice(0, -1), request: last.text }
  }
  if (last?.role === 'assistant') {
    return {
      context: messages,
      request: 'Continue from the last assistant message. Write the next assistant output in the same format.',
    }
  }
  if (last?.role === 'system') {
    return {
      context: messages,
      request: 'Apply the updated system material above and continue the task.',
    }
  }
  return { context: messages, request: 'Continue the task from the context above.' }
}

export function composeInitialPrompt(messages, { branch = false } = {}) {
  const { context, request } = takeCurrentRequest(messages)
  const header = branch
    ? 'This session was rebuilt from a branch. The context below is the complete and only valid branch.'
    : 'The block below is the complete context supplied by the ST-bridge frontend.'
  return [
    header,
    'Treat it as authoritative. Preserve the order and every detail of the supplied messages.',
    'Do not summarize, truncate, or reorder the supplied material.',
    '',
    '<st_bridge_context>',
    contextBlock(context),
    '</st_bridge_context>',
    '',
    '<st_bridge_current_request>',
    request,
    '</st_bridge_current_request>',
    '',
    'Return only the final text requested by the current request. Do not add commentary, progress notes, tool narration, or code fences.',
  ].join('\n')
}

export function composeAppendPrompt(newMessages) {
  if (newMessages.length === 1 && newMessages[0].role === 'user' && !newMessages[0].name) {
    // The common case: a single new turn. Sending it verbatim keeps the
    // caller's wording and formatting intact.
    return newMessages[0].text
  }
  return [
    'The following is new material appended to the existing session.',
    'Use it to continue; do not repeat text that was already written.',
    '',
    '<st_bridge_append>',
    contextBlock(newMessages),
    '</st_bridge_append>',
  ].join('\n')
}

export function composeReplayPrompt(messages) {
  return composeInitialPrompt(messages, { branch: true })
}

/**
 * The context that the DSH session contains after the current request's input
 * has been admitted, before the assistant answer is appended.
 */
export function baseMessagesFor({ classification, previousKnown, incoming }) {
  switch (classification.kind) {
    case 'initial':
    case 'branch':
    case 'regenerate':
      return classification.replay ?? incoming
    case 'append':
      return classification.delta
        ? [...(previousKnown ?? []), ...(classification.newMessages ?? [])]
        : incoming
    default:
      return incoming
  }
}

export function withAssistant(base, answer) {
  const text = String(answer ?? '')
  return [...base, {
    role: 'assistant',
    text,
    hash: messageHash('assistant', text, undefined),
  }]
}

/**
 * Build the caller-visible transcript after one successful turn. The bridge
 * keeps assistant outputs too, so the next full-history request can be diffed
 * without resending them.
 */
export function buildKnownMessages({ classification, previousKnown, incoming, answer }) {
  return withAssistant(baseMessagesFor({ classification, previousKnown, incoming }), answer)
}

export function deriveTitle(chatId, messages, explicitTitle) {
  if (typeof explicitTitle === 'string' && explicitTitle.trim() !== '') {
    return truncateUtf8(explicitTitle.trim().replace(/\s+/g, ' '), 120)
  }
  const first = messages.find(message => message.role === 'user' && message.text.trim() !== '')
  const source = first?.text.trim().replace(/\s+/g, ' ') ?? chatId
  return `柏宝绘 · ${truncateUtf8(source, 80)}`
}

/** Readable title for a scoped (client/task) session. */
export function deriveScopedTitle(chatId, messages, explicitTitle, label) {
  const source = typeof explicitTitle === 'string' && explicitTitle.trim() !== ''
    ? explicitTitle.trim().replace(/\s+/g, ' ')
    : (messages.find(message => message.role === 'user' && message.text.trim() !== '')?.text.trim().replace(/\s+/g, ' ') ?? chatId)
  return `${label} · ${truncateUtf8(source, 80)}`
}

export function normalizeContextMode(value) {
  if (value === undefined || value === null || value === '') return 'auto'
  if (!['auto', 'full', 'delta', 'branch'].includes(value)) {
    throw badRequest('context_mode 必须是 auto、full、delta 或 branch', 'invalid_context_mode')
  }
  return value
}
