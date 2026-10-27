import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const option = args.indexOf('--extensions-dir')
if (option < 0 || !args[option + 1]) throw new Error('用法: node install-tavern.mjs --extensions-dir <酒馆用户的 extensions 目录> [--apply]；默认只读')
const root = realpathSync(resolve(args[option + 1]))
const target = join(root, 'ST-Bridge-Context')
if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('目标为链接，停止安装')
const source = fileURLToPath(new URL('./tavern-extension/', import.meta.url))
const files = ['manifest.json', 'core.js', 'index.js'].map(name => {
  const path = join(target, name)
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error(`目标不是普通文件: ${path}`)
  return { name, path, before: existsSync(path) ? readFileSync(path) : null, after: readFileSync(join(source, name)) }
}).filter(file => !file.before?.equals(file.after))
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ readOnly: true, target, files: files.map(f => f.name) }, null, 2))
} else if (!files.length) console.log('已是当前版本；未改动文件')
else {
  const backup = join(root, '.st-bridge-context-backups', `${Date.now()}-${randomUUID().slice(0, 8)}`)
  mkdirSync(backup, { recursive: true })
  for (const file of files) if (file.before) copyFileSync(file.path, join(backup, file.name))
  mkdirSync(target, { recursive: true })
  const touched = []
  try {
    for (const file of files) {
      touched.push(file)
      writeFileSync(file.path, file.after)
      if (!readFileSync(file.path).equals(file.after)) throw new Error(`校验失败: ${file.name}`)
    }
  } catch (error) {
    for (const file of touched.reverse()) {
      if (file.before) writeFileSync(file.path, file.before)
      else if (existsSync(file.path)) unlinkSync(file.path)
    }
    throw error
  }
  console.log(JSON.stringify({ installed: true, target, backup, files: files.length, settingsChanged: false, restartDsh: false }, null, 2))
}
