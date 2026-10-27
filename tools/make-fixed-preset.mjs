#!/usr/bin/env node
/**
 * 从一份真实请求生成固定预设分离配置（exact 模式）。
 *
 * 用法：
 *   node tools/make-fixed-preset.mjs request.json \
 *     --client shujuku --task database --id db-preset --label "数据库固定预设" --count 2
 *
 * 参数：
 *   --client  client_id（必填）
 *   --task    task_id（默认 default）
 *   --id      配置 ID（默认 <client>-preset）
 *   --label   显示名（默认同 ID）
 *   --count   开头连续 system 中，每轮完全不变的前 N 条（默认 1）
 *
 * 输出：
 *   - 打印可直接 POST 到 /v1/bridge/fixed-presets 的 JSON
 *   - 不打印任何正文
 *
 * 说明：
 *   exact 模式按“role + 完整文本”的 SHA-256 匹配，因此那 N 条必须在后续请求里
 *   逐字一致、连续出现、顺序不变。任何动态内容（世界书、当前表格）都不能计入。
 */
import { readFileSync } from 'node:fs'
import { normalizeMessages } from '../lib/context.js'

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const file = process.argv[2]
if (!file || file.startsWith('--')) {
  console.error('用法: node tools/make-fixed-preset.mjs request.json --client ID [--task T] [--id X] [--label Y] [--count N]')
  process.exit(1)
}

const clientId = arg('--client')
if (!clientId) {
  console.error('必须提供 --client')
  process.exit(1)
}
const taskId = arg('--task', 'default')
const id = arg('--id', `${clientId}-preset`)
const label = arg('--label', id)
const count = Number(arg('--count', '1'))

let parsed
try {
  parsed = JSON.parse(readFileSync(file, 'utf8'))
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
if (!Number.isInteger(count) || count < 1 || count > leading) {
  console.error(`--count 必须在 1..${leading} 之间（当前开头连续 system 共 ${leading} 条）`)
  process.exit(1)
}

const exactHashes = messages.slice(0, count).map(message => message.hash)
const config = {
  version: 1,
  presets: [{
    id,
    label,
    client_id: clientId,
    task_id: taskId,
    mode: 'exact',
    exact_hashes: exactHashes,
  }],
}

console.log(JSON.stringify(config, null, 2))
console.error(`\n将固定 ${count} 条 system；Hash 前缀: ${exactHashes.map(hash => hash.slice(0, 8)).join(', ')}`)
console.error('确认无误后：')
console.error('  curl -X POST http://127.0.0.1:43121/v1/bridge/fixed-presets \\')
console.error('       -H "content-type: application/json" --data-binary @preset.json')
console.error('（只在确认这些消息每轮完全一致后使用；动态世界书/表格不要计入）')
