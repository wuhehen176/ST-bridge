import { stripMarkersInMessages } from '../snapshot-diff.js'

export const POLL_INTERVAL_MS = 300
export const SESSION_TITLE_MAX = 120

// Tool schemas belong to the selected Agent preset. External-tool mode is the
// exception: the caller supplies the complete tool set for that turn, and the
// bridge must not mix preset tools into the caller's protocol.
export function bridgeToolSchemas(assembled, runtime) {
  if (runtime?.externalTools) return runtime.externalTools.schemas ?? []
  return Array.isArray(assembled?.tools) ? assembled.tools : []
}

// The system section is snapshot state, not a per-turn diff. DSH rebuilds the
// system prompt from the current request, so unchanged leading system blocks
// (worldbook, layout rules, character sheets) must be sent again every turn or
// they disappear after the snapshot trims them from the prompt body.
export function leadingSystemMessages(messages, marker) {
  const clean = stripMarkersInMessages(Array.isArray(messages) ? messages : [], marker)
  let end = 0
  while (end < clean.length && clean[end].role === 'system') end += 1
  return clean.slice(0, end)
}

export function renderedSystemText(sections) {
  return (Array.isArray(sections) ? sections : [])
    .map(section => section?.text)
    .filter(text => typeof text === 'string' && text !== '')
    .join('\n\n')
}

export function isContextLengthError(message) {
  // Avoid matching a provider's generic "clear context" hint: a blocked
  // provider session is not the same as a DSH context-length error.
  return /context\s+length|too many tokens|maximum context|token limit|上下文.{0,8}(?:超|长)|超出.{0,8}上下文|超过.{0,8}上下文/i.test(message)
}

export function isProviderSessionBlocked(message) {
  return /session\s+blocked|\b406\b[^\n]*model_error|model_error[^\n]*session\s+blocked/i.test(message)
}

export function isAccountError(message) {
  return /quota|balance|credit|unauthorized|invalid api key|authentication|401|403/i.test(message)
}
