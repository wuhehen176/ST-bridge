import { sha256 } from './util.js'

/**
 * 快照差分：消息级前后缀 + 块级前后缀。
 *
 * 两种块模式：
 *  - auto：桥接自动按段落切块，段落过长时按行分组；不需要客户端改模板。
 *  - marker：客户端用专属 nonce 标记显式切块。
 *
 * 只删开头/结尾连续相同的完整块，中间保留；只存 Hash，不存正文。
 */

export const SNAPSHOT_MARKER_PATTERN = /^[A-F0-9]{8,32}$/
export const DEFAULT_MAX_BLOCK_CHARS = 2000
/**
 * 块级白名单符号。放在块首（auto 段落，或 marker 块内首行）时，
 * 该块永不参与前后缀裁剪；符号本身会在发送前移除。
 * 成对的 <<<STB-/KEEP>>> 可把两个符号之间的所有块一起固定。
 */
export const SNAPSHOT_KEEP_TOKEN = '<<<STB-KEEP>>>'
export const SNAPSHOT_KEEP_END_TOKEN = '<<<STB-/KEEP>>>'

export function isPinnedSnapshotBlock(text) {
  return /^\s*<<<STB-KEEP>>>/.test(String(text ?? ''))
}

export function stripSnapshotKeepToken(text) {
  const source = String(text ?? '')
  if (!source.includes(SNAPSHOT_KEEP_TOKEN) && !source.includes(SNAPSHOT_KEEP_END_TOKEN)) return source
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const kept = []
  for (const line of source.split(/\r?\n/)) {
    const hasToken = line.includes(SNAPSHOT_KEEP_TOKEN) || line.includes(SNAPSHOT_KEEP_END_TOKEN)
    let next = line.split(SNAPSHOT_KEEP_TOKEN).join('').split(SNAPSHOT_KEEP_END_TOKEN).join('')
    // 只含符号的行整行去掉；符号和正文同行时只去掉符号本身。
    if (hasToken && next.trim() === '') continue
    if (hasToken) next = next.replace(/^[ \t]+|[ \t]+$/g, '')
    kept.push(next)
  }
  return kept.join(newline)
}

/**
 * 扫描块序列里的白名单符号，返回每个块是否需要固定。
 * 配对的开/闭符号固定它们之间的全部块；只有开符号时只固定开符号所在块，
 * 保持旧写法兼容；孤立的闭符号只会在发送前剥掉，不产生固定范围。
 */
function keepRangeFlags(blocks) {
  const flags = new Array(blocks.length).fill(false)
  let openIndex = -1
  for (let index = 0; index < blocks.length; index += 1) {
    const text = String(typeof blocks[index] === 'string' ? blocks[index] : blocks[index]?.text ?? '')
    let cursor = 0
    while (cursor < text.length) {
      const nextOpen = text.indexOf(SNAPSHOT_KEEP_TOKEN, cursor)
      const nextClose = text.indexOf(SNAPSHOT_KEEP_END_TOKEN, cursor)
      if (nextOpen < 0 && nextClose < 0) break
      if (nextOpen >= 0 && (nextClose < 0 || nextOpen < nextClose)) {
        if (openIndex < 0) openIndex = index
        cursor = nextOpen + SNAPSHOT_KEEP_TOKEN.length
        continue
      }
      if (openIndex >= 0) {
        for (let cursorIndex = openIndex; cursorIndex <= index; cursorIndex += 1) {
          flags[cursorIndex] = true
        }
        openIndex = -1
      }
      cursor = nextClose + SNAPSHOT_KEEP_END_TOKEN.length
    }
  }
  if (openIndex >= 0) flags[openIndex] = true
  return flags
}

export function normalizeSnapshotMarker(value) {
  if (typeof value !== 'string') return ''
  let marker = value.trim().toUpperCase()
  if (marker.startsWith('STB-')) marker = marker.slice(4)
  if (marker === '') return ''
  if (!SNAPSHOT_MARKER_PATTERN.test(marker)) return ''
  return marker
}

function tokenPair(marker) {
  return {
    begin: `<<<STB-${marker}:B>>>`,
    end: `<<<STB-${marker}:E>>>`,
  }
}

/** 解析一条消息里的标记块；没有标记返回 unmarked。 */
export function parseSnapshotBlocks(text, marker) {
  const source = String(text ?? '')
  const nonce = normalizeSnapshotMarker(marker)
  if (!nonce) return { kind: 'unmarked' }
  if (!source.includes(`STB-${nonce}`)) return { kind: 'unmarked' }
  const { begin, end } = tokenPair(nonce)
  const blocks = []
  let index = 0
  let inBlock = false
  let contentStart = 0
  while (index < source.length) {
    const nextBegin = source.indexOf(begin, index)
    const nextEnd = source.indexOf(end, index)
    if (nextBegin < 0 && nextEnd < 0) break
    if (nextBegin >= 0 && (nextEnd < 0 || nextBegin < nextEnd)) {
      if (inBlock) return { kind: 'ambiguous', reason: 'nested-begin' }
      if (source.slice(index, nextBegin).trim() !== '') {
        return { kind: 'ambiguous', reason: 'text-outside-blocks' }
      }
      inBlock = true
      contentStart = nextBegin + begin.length
      index = contentStart
      continue
    }
    if (!inBlock) return { kind: 'ambiguous', reason: 'orphan-end' }
    blocks.push(source.slice(contentStart, nextEnd).replace(/^\r?\n/, '').replace(/\r?\n$/, ''))
    inBlock = false
    index = nextEnd + end.length
  }
  if (inBlock) return { kind: 'ambiguous', reason: 'unclosed-block' }
  if (source.slice(index).trim() !== '') return { kind: 'ambiguous', reason: 'text-outside-blocks' }
  if (blocks.length === 0) return { kind: 'ambiguous', reason: 'empty' }
  return { kind: 'blocks', blocks }
}

/** 去掉标记后的文本；ambiguous 时返回原文。 */
export function stripSnapshotMarkers(text, marker) {
  const parsed = parseSnapshotBlocks(text, marker)
  if (parsed.kind !== 'blocks') return stripSnapshotKeepToken(String(text ?? ''))
  return parsed.blocks.map(stripSnapshotKeepToken).join('\n\n')
}

/** 去掉消息里的标记；只影响发送副本，ambiguous 消息也会清掉标记本身。 */
export function stripMarkersInMessages(messages, marker) {
  const nonce = normalizeSnapshotMarker(marker)
  const token = nonce ? new RegExp(`<<<STB-${nonce}:[BE]>>>`, 'g') : null
  return (Array.isArray(messages) ? messages : []).map(message => {
    const parsed = nonce ? parseSnapshotBlocks(message.text, nonce) : { kind: 'unmarked' }
    let text = message.text
    if (parsed.kind === 'blocks') {
      text = parsed.blocks.map(stripSnapshotKeepToken).join('\n\n')
    } else {
      if (nonce && message.text.includes(`STB-${nonce}`)) {
        text = text.replace(token, '').replace(/\n{3,}/g, '\n\n')
      }
      text = stripSnapshotKeepToken(text)
    }
    if (text === message.text) return message
    return { ...message, text, hash: sha256(`${message.role}\u0000${message.name ?? ''}\u0000${text}`) }
  })
}

function trimRange(source, start, end) {
  let left = start
  let right = end
  while (left < right && /\s/.test(source[left])) left += 1
  while (right > left && /\s/.test(source[right - 1])) right -= 1
  return [left, right]
}

function pushBlock(source, start, end, blocks) {
  const [left, right] = trimRange(source, start, end)
  if (right <= left) return
  const text = source.slice(left, right)
  blocks.push({ text, start: left, end: right, pinned: isPinnedSnapshotBlock(text) })
}

/** 单行仍然超长：按空白尽量在词边界切开；没有空白就只能按上限切。 */
function splitHardRange(source, start, end, limit, blocks) {
  let position = start
  while (position < end) {
    let stop = Math.min(position + limit, end)
    if (stop < end) {
      const space = source.lastIndexOf(' ', stop)
      if (space > position + Math.floor(limit / 2)) stop = space
    }
    pushBlock(source, position, stop, blocks)
    position = stop
  }
}

/** 超长单行：先按句末标点切句，再按上限分组/硬切。 */
function splitLongLine(source, start, end, limit, blocks) {
  const text = source.slice(start, end)
  const sentence = /[^。！？.!?\n]+[。！？.!?]?/g
  const pieces = []
  let match
  while ((match = sentence.exec(text)) !== null) {
    const pieceStart = start + match.index
    const pieceEnd = pieceStart + match[0].length
    if (pieceEnd > pieceStart) pieces.push([pieceStart, pieceEnd])
  }
  if (pieces.length === 0) {
    splitHardRange(source, start, end, limit, blocks)
    return
  }
  let chunkStart = pieces[0][0]
  let chunkEnd = pieces[0][1]
  if (chunkEnd - chunkStart > limit) {
    splitHardRange(source, chunkStart, chunkEnd, limit, blocks)
    chunkStart = -1
    chunkEnd = -1
  }
  for (let index = 1; index < pieces.length; index += 1) {
    const [pieceStart, pieceEnd] = pieces[index]
    if (pieceEnd - pieceStart > limit) {
      if (chunkStart >= 0) pushBlock(source, chunkStart, chunkEnd, blocks)
      splitHardRange(source, pieceStart, pieceEnd, limit, blocks)
      chunkStart = -1
      chunkEnd = -1
      continue
    }
    if (chunkStart < 0) {
      chunkStart = pieceStart
      chunkEnd = pieceEnd
    } else if (pieceEnd - chunkStart <= limit) {
      chunkEnd = pieceEnd
    } else {
      pushBlock(source, chunkStart, chunkEnd, blocks)
      chunkStart = pieceStart
      chunkEnd = pieceEnd
    }
  }
  if (chunkStart >= 0) pushBlock(source, chunkStart, chunkEnd, blocks)
}

/** 长段落按行切：每行一块；单行超长再按句/上限切。 */
function splitLines(source, start, end, limit, blocks) {
  let lineStart = start
  while (lineStart <= end) {
    const newline = source.indexOf('\n', lineStart)
    const lineEnd = newline < 0 || newline > end ? end : newline
    const [left, right] = trimRange(source, lineStart, lineEnd)
    if (right > left) {
      if (right - left <= limit) pushBlock(source, left, right, blocks)
      else splitLongLine(source, left, right, limit, blocks)
    }
    if (newline < 0 || newline >= end) break
    lineStart = newline + 1
  }
}

/**
 * 自动切块：先按空行分段；每段一块。
 * 单段超过 maxBlockChars → 每行一块；单行仍超长 → 按句/上限切。
 * 返回带原文偏移的块，便于裁剪时保留原始分隔符。
 */
export function splitAutoBlocks(text, { maxBlockChars = DEFAULT_MAX_BLOCK_CHARS } = {}) {
  const source = String(text ?? '')
  const blocks = []
  const limit = Number.isSafeInteger(maxBlockChars) && maxBlockChars >= 64 ? maxBlockChars : DEFAULT_MAX_BLOCK_CHARS
  const paragraph = /\n[ \t]*\n+/g
  const ranges = []
  let cursor = 0
  let match
  while ((match = paragraph.exec(source)) !== null) {
    ranges.push([cursor, match.index])
    cursor = paragraph.lastIndex
  }
  ranges.push([cursor, source.length])

  for (const [start, end] of ranges) {
    const [left, right] = trimRange(source, start, end)
    if (right <= left) continue
    if (right - left <= limit) {
      const text = source.slice(left, right)
      blocks.push({ text, start: left, end: right, pinned: isPinnedSnapshotBlock(text) })
    } else {
      splitLines(source, left, right, limit, blocks)
    }
  }
  const pinned = keepRangeFlags(blocks)
  for (let index = 0; index < blocks.length; index += 1) blocks[index].pinned = pinned[index]
  return blocks
}

function blockHashes(blocks) {
  return blocks.map(block => sha256(stripSnapshotKeepToken(typeof block === 'string' ? block : block.text)))
}

function normalizeOptions(options) {
  if (typeof options === 'string') {
    return { mode: 'marker', marker: normalizeSnapshotMarker(options), maxBlockChars: DEFAULT_MAX_BLOCK_CHARS }
  }
  const value = options && typeof options === 'object' ? options : {}
  const mode = value.mode === 'marker' ? 'marker' : 'auto'
  return {
    mode,
    marker: normalizeSnapshotMarker(value.marker),
    maxBlockChars: Number.isSafeInteger(value.maxBlockChars) && value.maxBlockChars >= 64
      ? value.maxBlockChars
      : DEFAULT_MAX_BLOCK_CHARS,
  }
}

/** 把消息序列转成快照记录（只存 Hash 与块边界）。 */
export function snapshotOf(messages, options) {
  const { mode, marker, maxBlockChars } = normalizeOptions(options)
  return (Array.isArray(messages) ? messages : []).map(message => {
    if (mode === 'auto') {
      const hashes = blockHashes(splitAutoBlocks(message.text, { maxBlockChars }))
      return {
        role: message.role,
        kind: 'auto',
        hash: sha256(JSON.stringify(hashes)),
        blocks: hashes,
      }
    }
    const parsed = marker ? parseSnapshotBlocks(message.text, marker) : { kind: 'unmarked' }
    if (parsed.kind === 'blocks') {
      const hashes = blockHashes(parsed.blocks)
      return { role: message.role, kind: 'blocks', hash: sha256(JSON.stringify(hashes)), blocks: hashes }
    }
    return { role: message.role, kind: 'unmarked', hash: message.hash }
  })
}

function sameRecord(left, right) {
  return Boolean(left && right)
    && left.role === right.role
    && left.kind === right.kind
    && left.hash === right.hash
}

function trimBlocksForMessage(message, before, options, nonce) {
  const { mode, maxBlockChars } = normalizeOptions(options)
  let currentBlocks
  if (mode === 'auto') {
    currentBlocks = splitAutoBlocks(message.text, { maxBlockChars })
  } else {
    const parsed = parseSnapshotBlocks(message.text, nonce)
    if (parsed.kind !== 'blocks') return { message, trimmed: 0, ambiguous: 1 }
    const pinned = keepRangeFlags(parsed.blocks)
    currentBlocks = parsed.blocks.map((text, index) => ({
      text,
      index,
      pinned: pinned[index],
    }))
  }
  const hashes = blockHashes(currentBlocks)
  let start = 0
  while (start < hashes.length && start < before.blocks.length && hashes[start] === before.blocks[start]) start += 1
  let end = 0
  while (
    end < hashes.length - start
    && end < before.blocks.length - start
    && hashes[hashes.length - 1 - end] === before.blocks[before.blocks.length - 1 - end]
  ) end += 1
  // 白名单块不能被前缀/后缀吞掉：前缀最多裁到第一个 pin 之前，
  // 后缀最多裁到最后一个 pin 之后。
  const pinned = currentBlocks.map(block => block.pinned === true)
  const firstPinned = pinned.indexOf(true)
  if (firstPinned >= 0) start = Math.min(start, firstPinned)
  const lastPinned = pinned.lastIndexOf(true)
  if (lastPinned >= 0) end = Math.min(end, currentBlocks.length - 1 - lastPinned)
  if (start === 0 && end === 0) return { message, trimmed: 0, ambiguous: 0 }
  const kept = currentBlocks.slice(start, currentBlocks.length - end)
  if (kept.length === 0) return { message, trimmed: 0, ambiguous: 0 }
  let text
  if (mode === 'auto') {
    // 保留原始文本，包括块之间的空行/换行。
    text = stripSnapshotKeepToken(message.text.slice(kept[0].start, kept[kept.length - 1].end))
  } else {
    text = kept.map(block => stripSnapshotKeepToken(block.text)).join('\n\n')
  }
  return {
    message: { ...message, text, hash: sha256(`${message.role}\u0000${message.name ?? ''}\u0000${text}`) },
    trimmed: start + end,
    ambiguous: 0,
    trimmedChars: message.text.length - text.length,
  }
}

/**
 * 对比上一轮快照，返回需要发送的消息与诊断。
 * 只做消息级前后缀与块级前后缀；任何不确定都保留。
 */
export function diffAgainstSnapshot(messages, snapshot, options) {
  const list = Array.isArray(messages) ? messages : []
  const ignore = { messages: list, diagnostic: undefined }
  const { mode, marker: nonce, maxBlockChars } = normalizeOptions(options)
  if (!snapshot || !Array.isArray(snapshot.messages)) return ignore
  const snapshotMode = snapshot.mode === 'auto' ? 'auto' : 'marker'
  if (snapshotMode !== mode) return ignore
  if (mode === 'marker' && (!nonce || snapshot.marker !== nonce)) return ignore

  const previous = snapshot.messages
  const currentRecords = snapshotOf(list, { mode, marker: nonce })
  // Message-level prefix/suffix pruning must honor the same KEEP ranges as
  // block-level pruning; otherwise an unchanged protected system vanishes first.
  const pinnedMessages = list.map(message => {
    if (mode === 'auto') return splitAutoBlocks(message.text, { maxBlockChars }).some(block => block.pinned)
    const parsed = parseSnapshotBlocks(message.text, nonce)
    return keepRangeFlags(parsed.kind === 'blocks' ? parsed.blocks : [message.text]).some(Boolean)
  })

  let head = 0
  while (head < list.length && head < previous.length && !pinnedMessages[head] && sameRecord(previous[head], currentRecords[head])) head += 1
  let tail = 0
  while (
    tail < list.length - head
    && tail < previous.length - head
    && !pinnedMessages[list.length - 1 - tail]
    && sameRecord(previous[previous.length - 1 - tail], currentRecords[list.length - 1 - tail])
  ) tail += 1

  if (head + tail >= list.length) return ignore

  let trimmedMessages = head + tail
  let trimmedChars = 0
  for (let index = 0; index < head; index += 1) trimmedChars += list[index].text.length
  for (let index = list.length - tail; index < list.length; index += 1) trimmedChars += list[index].text.length

  const middleEnd = list.length - tail
  const output = []
  let trimmedBlocks = 0
  let ambiguous = 0

  for (let index = 0; index < list.length; index += 1) {
    if (index < head || index >= middleEnd) continue
    const message = list[index]
    const before = previous[index]
    if (!before || before.role !== message.role || (before.kind !== 'blocks' && before.kind !== 'auto')) {
      output.push(message)
      continue
    }
    const result = trimBlocksForMessage(message, before, { mode, marker: nonce }, nonce)
    ambiguous += result.ambiguous ?? 0
    if (result.trimmed > 0) {
      output.push(result.message)
      trimmedBlocks += result.trimmed
      trimmedChars += result.trimmedChars ?? (message.text.length - result.message.text.length)
      trimmedMessages += 1
    } else {
      output.push(result.message)
    }
  }

  if (trimmedBlocks === 0 && trimmedMessages === 0) return ignore
  if (list.some(message => message.role === 'user') && !output.some(message => message.role === 'user')) {
    // 不能把本轮唯一/全部 user 消息裁掉；协议要求动态组至少有一条 user。
    return {
      messages: list,
      diagnostic: {
        marker: nonce,
        mode,
        snapshot_turn: snapshot.turn ?? null,
        trimmed_messages: 0,
        trimmed_blocks: 0,
        trimmed_chars: 0,
        kept_chars: list.reduce((sum, message) => sum + message.text.length, 0),
        ambiguous_messages: ambiguous,
        status: 'no-user-after-trim',
      },
    }
  }

  return {
    messages: output,
    diagnostic: {
      marker: nonce,
      mode,
      snapshot_turn: snapshot.turn ?? null,
      trimmed_messages: trimmedMessages,
      trimmed_blocks: trimmedBlocks,
      trimmed_chars: trimmedChars,
      kept_chars: output.reduce((sum, message) => sum + message.text.length, 0),
      ambiguous_messages: ambiguous,
    },
  }
}
