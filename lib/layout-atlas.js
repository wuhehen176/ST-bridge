import { badRequest } from './errors.js'

/** Explicit transport metadata; never infer reusable images from story text. */
export function parseLayoutAtlas(value, messages, fixedCount, dedicated) {
  if (value === undefined) return null
  if (!dedicated || !value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)
    || !Array.isArray(value.message_indices) || value.message_indices.length > 20) {
    throw badRequest('layout_atlas 仅支持专属模式、SHA-256 hash 与 message_indices 数组', 'invalid_layout_atlas')
  }
  const indices = value.message_indices
  if (indices.some((index, i) => !Number.isSafeInteger(index) || index < fixedCount || index >= messages.length
    || i > 0 && index <= indices[i - 1] || messages[index].role !== 'user' || !messages[index].images.length)) {
    throw badRequest('layout_atlas 索引必须递增且只指向动态 user 图片消息', 'invalid_layout_atlas')
  }
  return { hash: value.hash, indices, messages: indices.map(index => messages[index]) }
}
