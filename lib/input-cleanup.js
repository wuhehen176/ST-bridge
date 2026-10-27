import { sha256 } from './util.js'

/**
 * 桥接侧兜底清理：只处理完整的 `<tag ...>...</tag>` 成对块。
 *
 * 这不是语义过滤，也不猜测 JSON 边界。孤立标签、跨消息、截断、不同编码
 * 一律原样保留并计入诊断，避免把剧情正文误删。
 */

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function tagPatterns(tag) {
  const name = escapeRegExp(tag)
  return {
    open: new RegExp(`<${name}\\b[^>]*>`, 'gi'),
    close: new RegExp(`</${name}\\s*>`, 'gi'),
  }
}

/** 清理一段文本里的完整同名标签块（支持嵌套）。 */
export function cleanTagBlocks(text, tag = 'bbi_image') {
  const source = String(text ?? '')
  const { open, close } = tagPatterns(tag)
  const tokens = []
  for (const match of source.matchAll(open)) tokens.push({ kind: 'open', start: match.index, end: match.index + match[0].length })
  for (const match of source.matchAll(close)) tokens.push({ kind: 'close', start: match.index, end: match.index + match[0].length })
  tokens.sort((left, right) => left.start - right.start)

  const stack = []
  const ranges = []
  let orphanOpen = 0
  let orphanClose = 0
  for (const token of tokens) {
    if (token.kind === 'open') {
      stack.push(token)
    } else if (stack.length > 0) {
      const openToken = stack.pop()
      ranges.push([openToken.start, token.end])
    } else {
      orphanClose += 1
    }
  }
  orphanOpen += stack.length

  // 只删除完整块；孤立标签和其后的正文都保留。
  const merged = []
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) {
      last[0] = Math.min(last[0], start)
      last[1] = Math.max(last[1], end)
    } else {
      merged.push([start, end])
    }
  }
  let output = ''
  let cursor = 0
  for (const [start, end] of merged) {
    output += source.slice(cursor, start)
    cursor = end
  }
  output += source.slice(cursor)

  return {
    text: output,
    removed_blocks: ranges.length,
    removed_chars: source.length - output.length,
    orphan_open: orphanOpen,
    orphan_close: orphanClose,
  }
}

/** 以消息为单位清理；固定组由调用方在此之前剥离。 */
export function cleanMessagesForProjection(messages, { enabled = true, tags = ['bbi_image'] } = {}) {
  const list = Array.isArray(messages) ? messages : []
  if (!enabled || !Array.isArray(tags) || tags.length === 0) {
    return { messages: list, diagnostic: undefined }
  }
  let removedChars = 0
  let removedBlocks = 0
  let orphanOpen = 0
  let orphanClose = 0
  let changedMessages = 0
  let skippedUser = 0
  const kept = []

  for (const message of list) {
    let text = message.text
    let changed = false
    for (const tag of tags) {
      const result = cleanTagBlocks(text, tag)
      removedChars += result.removed_chars
      removedBlocks += result.removed_blocks
      orphanOpen += result.orphan_open
      orphanClose += result.orphan_close
      if (result.text !== text) {
        text = result.text
        changed = true
      }
    }
    if (changed && text.trim() === '' && message.role === 'user') {
      // 不因清理掉唯一 user 正文而破坏协议；保留原文并报告。
      skippedUser += 1
      text = message.text
      changed = false
    }
    if (changed) {
      changedMessages += 1
      kept.push({ ...message, text, hash: sha256(`${message.role}\u0000${message.name ?? ''}\u0000${text}`) })
    } else {
      kept.push(message)
    }
  }

  if (!changedMessages) {
    return {
      messages: list,
      diagnostic: (removedBlocks || orphanOpen || orphanClose || skippedUser)
        ? { enabled: true, tags, removed_blocks: 0, removed_chars: 0, orphan_open: orphanOpen, orphan_close: orphanClose, skipped_user: skippedUser, changed_messages: 0, note: '只发现孤立标签，已原样保留' }
        : undefined,
    }
  }

  return {
    messages: kept,
    diagnostic: {
      enabled: true,
      tags,
      removed_blocks: removedBlocks,
      removed_chars: removedChars,
      orphan_open: orphanOpen,
      orphan_close: orphanClose,
      skipped_user: skippedUser,
      changed_messages: changedMessages,
      effective_messages_digest: digestOf(kept),
    },
  }
}

function digestOf(messages) {
  return sha256(JSON.stringify(messages.map(message => sha256(`${message.role}\u0000${message.name ?? ''}\u0000${message.text}`))))
}
