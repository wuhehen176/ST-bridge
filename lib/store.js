import { copyFileSync, existsSync } from 'node:fs'
import { nowIso, readJsonFile, writeJsonAtomic } from './util.js'

const MAX_REQUESTS_PER_CHAT = 200

/**
 * Durable chat_id -> DSH session mapping plus request-idempotency records.
 *
 * The store is deliberately small and boring: one JSON document, atomic
 * replacement, and no prompt text in request records. Known messages are kept
 * so the next request can be diffed without resending old context.
 */
export class BridgeStore {
  constructor(file) {
    this.file = file
    this.data = { version: 1, chats: {} }
    this.load()
  }

  load() {
    try {
      const parsed = readJsonFile(this.file, undefined)
      if (parsed === undefined) return
      if (!parsed || parsed.version !== 1 || typeof parsed.chats !== 'object' || Array.isArray(parsed.chats)) {
        throw new TypeError('unsupported bridge state shape')
      }
      this.data = parsed
    } catch (error) {
      this.backupCorrupt()
      this.data = { version: 1, chats: {} }
      this.loadError = error
    }
  }

  backupCorrupt() {
    if (!existsSync(this.file)) return
    const backup = `${this.file}.corrupt-${Date.now()}`
    try {
      copyFileSync(this.file, backup)
    } catch {
      // Best effort; a failed backup must not prevent the bridge from booting.
    }
  }

  save() {
    writeJsonAtomic(this.file, this.data)
  }

  getChat(chatId) {
    return this.data.chats[chatId]
  }

  listChats() {
    return Object.values(this.data.chats)
  }

  putChat(chatId, chat) {
    this.data.chats[chatId] = chat
    this.save()
  }

  updateChat(chatId, patch) {
    const current = this.data.chats[chatId]
    if (!current) return undefined
    const next = { ...current, ...patch, updatedAt: nowIso() }
    this.data.chats[chatId] = next
    this.save()
    return next
  }

  removeChat(chatId) {
    const existed = Object.hasOwn(this.data.chats, chatId)
    delete this.data.chats[chatId]
    if (existed) this.save()
    return existed
  }

  getRequest(chatId, requestId) {
    return this.data.chats[chatId]?.requests?.[requestId]
  }

  putRequest(chatId, requestId, record) {
    const chat = this.data.chats[chatId]
    if (!chat) throw new Error(`chat ${chatId} is not registered`)
    chat.requests ??= {}
    chat.requests[requestId] = record
    this.pruneRequests(chat)
    this.save()
    return record
  }

  removeRequest(chatId, requestId) {
    const chat = this.data.chats[chatId]
    if (!chat?.requests || !(requestId in chat.requests)) return false
    delete chat.requests[requestId]
    this.save()
    return true
  }

  pruneRequests(chat) {
    const entries = Object.entries(chat.requests ?? {})
    if (entries.length <= MAX_REQUESTS_PER_CHAT) return
    const removable = entries
      .filter(([, record]) => record.status !== 'pending')
      .sort((left, right) => String(left[1].updatedAt ?? '').localeCompare(String(right[1].updatedAt ?? '')))
    let overflow = entries.length - MAX_REQUESTS_PER_CHAT
    for (const [id] of removable) {
      if (overflow <= 0) break
      delete chat.requests[id]
      overflow -= 1
    }
  }

  clearAll() {
    const count = Object.keys(this.data.chats).length
    this.data.chats = {}
    this.save()
    return count
  }

  flush() {
    this.save()
  }
}

export function newChatRecord({
  chatId,
  sessionId,
  title,
  cwd,
  provider,
  model,
  agentPreset,
  clientId = 'baibai-image',
  taskId = 'default',
  scopeKey = chatId,
}) {
  const now = nowIso()
  return {
    chatId,
    clientId,
    taskId,
    scopeKey,
    sessionId,
    title,
    cwd,
    provider,
    model,
    agentPreset,
    knownMessages: [],
    fixedRules: [],
    lastTarget: null,
    protocol: null,
    requests: {},
    previousSessions: [],
    generation: 0,
    createdAt: now,
    updatedAt: now,
  }
}
