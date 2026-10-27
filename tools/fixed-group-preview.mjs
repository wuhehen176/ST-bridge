#!/usr/bin/env node
/**
 * 把酒馆插件实际发送的 messages 转成固定组建议。
 *
 * 用法：
 *   node tools/fixed-group-preview.mjs request.json
 *   node tools/fixed-group-preview.mjs            # 从 stdin 读取
 *
 * 输入可以是：
 *   - 完整 OpenAI 请求体：{ "messages": [...] }
 *   - 只有消息数组：[{ "role": "system", "content": "..." }, ...]
 *
 * 输出只有角色、长度、Hash 前缀和候选分组，不打印正文。
 */
import { readFileSync } from 'node:fs'
import { normalizeMessages } from '../lib/context.js'

async function readInput() {
  const file = process.argv[2]
  if (file) return readFileSync(file, 'utf8')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function classify(text, index, used) {
  const head = text.slice(0, 4000)
  const wants = []
  if (index === 0) wants.push('prefix')
  if (/必须只返回|只返回|返回格式|输出格式|json 对象|JSON 对象|schema|填表/i.test(head)) wants.push('contract')
  if (/输出前|检查清单|自检|checklist|验收/i.test(head)) wants.push('check')
  wants.push('spec')
  return wants.find(type => !used.has(type)) ?? 'spec'
}

/** 四种固定用途各自最多一条，按顺序分配，避免生成重复类型。 */
function assignTypes(messages) {
  const used = new Set()
  return messages.map((message, index) => {
    const type = classify(message.text, index, used)
    used.add(type)
    return type
  })
}

async function main() {
  let parsed
  try {
    parsed = JSON.parse(await readInput())
  } catch {
    console.error('输入不是合法 JSON')
    process.exit(1)
  }

  const raw = Array.isArray(parsed) ? parsed : parsed.messages
  if (!Array.isArray(raw)) {
    console.error('找不到 messages 数组')
    process.exit(1)
  }

  const { messages } = normalizeMessages(raw)
  let leading = 0
  while (leading < messages.length && messages[leading].role === 'system') leading += 1

  console.log(`共 ${messages.length} 条消息；开头连续 system: ${leading} 条\n`)
  console.log('idx  role       chars   hash     开头文本（截断）')
  messages.forEach((message, index) => {
    const preview = message.text.replace(/\s+/g, ' ').slice(0, 40)
    console.log(
      `${String(index).padEnd(4)} ${message.role.padEnd(10)} ${String(message.text.length).padStart(6)}  ${message.hash.slice(0, 8)}  ${preview}`,
    )
  })

  if (leading === 0) {
    console.log('\n没有开头连续 system 消息，无法形成固定组；请检查插件是否把预设放进了 system。')
    return
  }

  console.log('\n候选固定组（count 越大，固定的 system 越多；只保留每轮完全不变的那一段）：')
  for (let count = leading; count >= 1; count -= 1) {
    const types = assignTypes(messages.slice(0, count))
    console.log(`  fixed_message_count: ${count}  fixed_message_types: ${JSON.stringify(types)}`)
  }

  console.log('\n提示：')
  console.log('  - 只把“每轮完全一样”的 system 计入固定组；世界书、当前表格、版式清单属于动态，不能固定。')
  console.log('  - 选定后填进插件的 dsh_session；再用桥接日志确认 fixed= 数量。')
  console.log('  - 想减少重复副本又不改分组：用固定预设分离（exact/marker），见 configs/fixed-presets/。')
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
