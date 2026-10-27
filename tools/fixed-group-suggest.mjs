export function suggestFixedGroups(messages) {
  const rows = messages.map((message, index) => ({
    index,
    role: message.role,
    name: message.name,
    chars: message.text.length,
  }))
  let leadingSystem = 0
  while (leadingSystem < messages.length && messages[leadingSystem].role === 'system') {
    leadingSystem += 1
  }
  const candidates = []
  for (let count = leadingSystem; count >= 1; count -= 1) {
    const slice = messages.slice(0, count)
    candidates.push({
      fixed_message_count: count,
      fixed_message_types: slice.map((message, index) => classify(message.text, index)),
    })
  }
  return { rows, leadingSystem, candidates }
}

function classify(text, index) {
  const head = text.slice(0, 4000)
  if (/json|schema|输出格式|填表|返回格式/i.test(head)) return 'contract'
  if (/检查|自检|checklist|输出前/i.test(head)) return 'check'
  if (index === 0) return 'prefix'
  return 'spec'
}
