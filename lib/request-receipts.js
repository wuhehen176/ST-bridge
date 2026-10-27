import { randomUUID } from 'node:crypto'
import { normalizeMessages } from './context.js'
import { sha256 } from './util.js'

// Transport evidence only. Never persist prompts, headers, answers or credentials.
export class RequestReceipts {
  constructor(limit = 60) { this.limit = limit; this.records = [] }

  begin(body) {
    const session = body.dsh_session ?? body.dshSession ?? body.metadata?.dsh_session ?? {}
    const transport = body.dsh_context?.transport
    const short = value => typeof value === 'string' ? value.slice(0, 256) : undefined
    const record = {
      receipt_id: randomUUID(), received_at: new Date().toISOString(), status: 'received',
      client_id: short(session.client_id ?? session.clientId),
      chat_id: short(session.chat_id ?? session.chatId ?? body.chat_id),
      task_id: short(session.task_id ?? session.taskId),
      request_id: short(session.request_id ?? session.requestId ?? body.request_id),
      adapter_state: transport?.version === 1 ? 'traced' : body.dsh_context ? 'untraced-context' : 'absent',
      trace_id: short(transport?.trace_id), adapter_version: short(transport?.adapter_version),
      claimed_digest: short(transport?.messages_digest), messages_match: null,
    }
    try {
      const { messages } = normalizeMessages(body.messages ?? [], { allowEmpty: true })
      record.messages_digest = sha256(JSON.stringify(messages.map(message => message.hash)))
      record.message_count = messages.length
      record.message_chars = messages.reduce((sum, message) => sum + message.text.length, 0)
      if (/^[a-f0-9]{64}$/.test(record.claimed_digest ?? '')) record.messages_match = record.claimed_digest === record.messages_digest
      const fixed = Number.isInteger(session.fixed_message_count) && session.fixed_message_count >= 0 ? session.fixed_message_count : 0
      record.dynamic_image_markers = messages.slice(fixed).reduce((sum, m) => sum + [...m.text.matchAll(/<bbi_image(?=[\s/>])[^>]*>/gi)].length, 0)
    } catch { /* Existing request validation owns errors; observation cannot alter requests. */ }
    this.records.push(record)
    if (this.records.length > this.limit) this.records.shift()
    return record
  }

  list(filters = {}) {
    return this.records.filter(record => Object.entries(filters).every(([key, value]) => !value || record[key] === value)).map(record => ({ ...record }))
  }
}
