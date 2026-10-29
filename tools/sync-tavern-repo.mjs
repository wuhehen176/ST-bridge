#!/usr/bin/env node
/**
 * 把主仓库的 tavern-extension/ 同步到独立发布仓库。
 *
 * 用法：
 *   node tools/sync-tavern-repo.mjs                 # 只读比较
 *   node tools/sync-tavern-repo.mjs --apply         # 提交并推送
 *   node tools/sync-tavern-repo.mjs --target D:\AIGC\MOSS\ST-bridge-tavern --apply
 *
 * 独立仓库必须已存在、工作区干净，根目录直接包含 manifest.json。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const targetIndex = args.indexOf('--target')
const target = resolve(targetIndex >= 0 && args[targetIndex + 1] ? args[targetIndex + 1] : '../ST-bridge-tavern')
const source = resolve(new URL('../tavern-extension/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const files = ['manifest.json', 'core.js', 'index.js']

if (!existsSync(target) || !existsSync(resolve(target, '.git'))) {
  throw new Error(`目标不是 Git 仓库: ${target}`)
}

const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' }).trim()
if (dirty) throw new Error(`目标仓库有未提交改动，先处理：\n${dirty}`)

const changes = files
  .map(name => ({ name, before: readFileSync(resolve(target, name), 'utf8'), after: readFileSync(resolve(source, name), 'utf8') }))
  .filter(file => file.before !== file.after)

if (changes.length === 0) {
  console.log(JSON.stringify({ target, changes: [], message: 'already in sync' }, null, 2))
  process.exit(0)
}

const version = JSON.parse(readFileSync(resolve(source, 'manifest.json'), 'utf8')).version
console.log(JSON.stringify({ target, version, changes: changes.map(file => file.name), apply }, null, 2))
if (!apply) process.exit(0)

for (const file of changes) copyFileSync(resolve(source, file.name), resolve(target, file.name))
execFileSync('git', ['add', ...changes.map(file => file.name)], { cwd: target, stdio: 'inherit' })
execFileSync('git', ['commit', '-m', `sync Tavern extension ${version}`], { cwd: target, stdio: 'inherit' })
execFileSync('git', ['push', 'origin', 'main'], { cwd: target, stdio: 'inherit' })
console.log(`synced ${version} to ${target}`)
