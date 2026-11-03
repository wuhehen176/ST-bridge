import { badRequest } from './errors.js'
import { sha256, truncateUtf8 } from './util.js'

const ROLES = new Set(['system', 'user', 'assistant'])
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 20
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024

function parseImagePart(imageUrl, index, partIndex) {
  const url = typeof imageUrl === 'string' ? imageUrl : imageUrl?.url
  if (typeof url !== 'string' || !url.startsWith('data:')) {
    throw badRequest(`messages[${index}].content[${partIndex}] 只支持 data: 图片`, 'unsupported_image_url')
  }
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(url)
  if (!match) {
    throw badRequest(`messages[${index}].content[${partIndex}] 图片 MIME 或 base64 无效`, 'invalid_image')
  }
  const mediaType = match[1]
  if (!IMAGE_TYPES.has(mediaType)) throw badRequest(`不支持的图片类型 ${mediaType}`, 'unsupported_image_type')
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0) throw badRequest(`messages[${index}].content[${partIndex}] 图片为空`, 'invalid_image')
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw badRequest(`messages[${index}].content[${partIndex}] 图片超过 ${MAX_IMAGE_BYTES} 字节`, 'image_too_large')
  }
  return {
    type: 'image',
    mediaType,
    data: match[2],
    bytes: bytes.length,
    hash: sha256(`${mediaType}:${match[2]}`),
  }
}

function contentFrom(content, index) {
  if (typeof content === 'string') return { text: content, parts: [{ type: 'text', text: content }], images: [] }
  if (content === null || content === undefined) return { text: '', parts: [], images: [] }
  if (!Array.isArray(content)) throw badRequest(`messages[${index}].content 必须是字符串或片段数组`, 'invalid_content')
  const text = []
  const parts = []
  const images = []
  for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
    const part = content[partIndex]
    if (typeof part === 'string') {
      text.push(part)
      parts.push({ type: 'text', text: part })
      continue
    }
    if (part && part.type === 'text' && typeof part.text === 'string') {
      text.push(part.text)
      parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part && part.type === 'image_url') {
      const image = parseImagePart(part.image_url, index, partIndex)
      images.push(image)
      parts.push(image)
      continue
    }
    throw badRequest(`messages[${index}].content 不支持片段 ${JSON.stringify(part?.type ?? typeof part)}`, 'unsupported_content')
  }
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw badRequest(`messages[${index}] 最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`, 'too_many_images')
  }
  return { text: text.join('\n'), parts, images }
}

/**
 * Normalize OpenAI-style messages without trimming, dropping, or reordering.
 * Text is flattened for prompt composition; user image parts are preserved for
 * DSH attachment admission.
 */
export function normalizeMessages(raw, { allowEmpty = false } = {}) {
  if (!Array.isArray(raw)) {
    throw badRequest('messages 必须是数组', 'invalid_messages')
  }
  if (raw.length === 0) {
    if (allowEmpty) return { messages: [], bytes: 0, images: [] }
    throw badRequest('messages 必须是非空数组', 'invalid_messages')
  }
  const messages = []
  let bytes = 0
  let imageBytes = 0
  const allImages = []
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index]
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw badRequest(`messages[${index}] 必须是对象`, 'invalid_messages')
    }
    const role = item.role
    if (!ROLES.has(role)) {
      throw badRequest(`messages[${index}].role 必须是 system、user 或 assistant`, 'invalid_role')
    }
    const { text, parts, images } = contentFrom(item.content, index)
    if (images.length > 0 && role !== 'user') {
      throw badRequest(`messages[${index}] 只有 user 消息可以携带图片`, 'invalid_image_role')
    }
    const name = typeof item.name === 'string' && item.name !== '' ? item.name : undefined
    const messageImageBytes = images.reduce((sum, image) => sum + image.bytes, 0)
    imageBytes += messageImageBytes
    if (imageBytes > MAX_TOTAL_IMAGE_BYTES) throw badRequest(`图片总大小超过 ${MAX_TOTAL_IMAGE_BYTES} 字节`, 'images_too_large')
    bytes += Buffer.byteLength(text, 'utf8') + messageImageBytes
    allImages.push(...images)
    messages.push({
      role,
      text,
      parts,
      images,
      ...(name ? { name } : {}),
      hash: messageHash(role, text, name, images.map(image => image.hash)),
    })
  }
  if (bytes === 0) throw badRequest('messages 的内容为空', 'empty_messages')
  return { messages, bytes, images: allImages }
}

export function messageHash(role, text, name, imageHashes = []) {
  return sha256([role, name ?? '', text, ...imageHashes].join('\u0000'))
}

export function sameMessage(left, right) {
  return left?.role === right?.role
    && (left?.name ?? '') === (right?.name ?? '')
    && (left?.hash && right?.hash ? left.hash === right.hash : left?.text === right?.text)
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

export function composeAppendPrompt(newMessages, { format = 'tagged', nonce = '7F3A9C2E' } = {}) {
  if (newMessages.length === 1 && newMessages[0].role === 'user' && !newMessages[0].name) {
    // The common case: a single new turn. Sending it verbatim keeps the
    // caller's wording and formatting intact.
    return newMessages[0].text
  }
  if (format === 'nonce') {
    const marker = `<<<STB-${nonce}>>>`
    const roles = newMessages.map(message => message.name ? `${message.role}(${message.name})` : message.role).join('、')
    return [
      '以下是追加到现有会话的新内容。',
      `角色顺序：${roles}。`,
      '请继续，不要重复已写内容，不要输出分隔标记。',
      '',
      ...newMessages.flatMap(message => [marker, message.text]),
    ].join('\n')
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
