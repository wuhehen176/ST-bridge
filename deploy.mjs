import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { buildInfo, packageFiles, PACKAGE_ROOT } from './lib/build-info.js'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => a === null || b === null ? a === b : a.equals(b)
const inside = (parent, child) => {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'))
}

function safeFile(root, name) {
  const path = resolve(root, name)
  if (path === root || !inside(root, path)) throw new Error(`目标文件越界: ${name}`)
  let cursor = path
  while (cursor !== root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`目标文件包含链接: ${name}`)
    cursor = dirname(cursor)
  }
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`目标不是普通文件: ${name}`)
  return path
}

export function inspectDeployment({ source = PACKAGE_ROOT, profile }) {
  source = realpathSync(source)
  profile = realpathSync(profile)
  const entry = createRequire(join(profile, 'package.json')).resolve('ST-bridge')
  const installed = realpathSync(dirname(entry))
  const roots = [installed]
  const vendor = join(profile, 'vendor', 'ST-bridge')
  if (existsSync(vendor)) roots.push(realpathSync(vendor))
  const files = packageFiles(source)
  const targets = [...new Set(roots)].map(root => {
    if (root !== source && !inside(profile, root)) throw new Error(`加载路径在 profile 之外，停止部署: ${root}`)
    const old = packageFiles(root)
    const changes = [...new Set([...files.keys(), ...old.keys()])].sort().flatMap(name => {
      const path = safeFile(root, name)
      const before = existsSync(path) ? readFileSync(path) : null
      const after = files.get(name) ?? null
      return same(before, after) ? [] : [{ name, path, before, after }]
    })
    return { root, linkedToSource: root === source, changes, build: buildInfo(root, old) }
  })
  return { source, profile, files, build: buildInfo(source, files), entry, targets }
}

async function portOpen(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.setTimeout(1500)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('无法确认桥接端口已停止')) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error))
  })
}

export async function assertStopped(port = 43121) {
  if (process.platform !== 'win32') throw new Error('自动部署运行检查目前仅支持 Windows；只读 --check 可跨平台使用')
  const running = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue).Count"], { encoding: 'utf8', windowsHide: true }).trim()
  if (!/^\d+$/.test(running)) throw new Error('无法确认 DSH Desktop 已退出')
  if (Number(running) > 0 || await portOpen(port)) throw new Error('DSH Desktop 或桥接仍在运行，请先从托盘完全退出；未改动部署文件')
}

export async function applyDeployment(plan, { stopCheck = assertStopped, port = 43121, write = writeFileSync } = {}) {
  await stopCheck(port)
  // Syntax-check the captured source bytes, not a changing live file.
  for (const [name, bytes] of plan.files) {
    if (/\.(?:js|mjs)$/.test(name)) execFileSync(process.execPath, ['--input-type=module', '--check'], { input: bytes, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  const changes = plan.targets.filter(target => !target.linkedToSource).flatMap((target, i) => target.changes.map(change => ({ ...change, target: i, root: target.root })))
  if (!changes.length) return { changed: 0, backup: null }
  const backup = join(plan.profile, '.st-bridge-backups', `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  mkdirSync(backup, { recursive: true })
  for (const change of changes) {
    if (change.before === null) continue
    const path = join(backup, String(change.target), change.name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, change.before)
  }
  writeFileSync(join(backup, 'manifest.json'), JSON.stringify({ source: plan.source, build: plan.build, files: changes.map(c => ({ target: c.root, file: c.name, before: c.before && sha(c.before), after: c.after && sha(c.after) })) }, null, 2))
  await stopCheck(port)
  // Detect edits since inspection, before touching either installed copy.
  for (const c of changes) {
    safeFile(c.root, c.name)
    const current = existsSync(c.path) ? readFileSync(c.path) : null
    if (!same(current, c.before)) throw new Error(`部署目标已变化，请重新检查: ${c.path}`)
  }
  const touched = []
  try {
    for (const c of changes) {
      touched.push(c)
      if (c.after === null) unlinkSync(c.path)
      else { mkdirSync(dirname(c.path), { recursive: true }); write(c.path, c.after) }
    }
    for (const target of plan.targets) {
      if (target.linkedToSource) continue
      const actual = packageFiles(target.root)
      if (actual.size !== plan.files.size || [...plan.files].some(([name, bytes]) => !actual.get(name)?.equals(bytes))) throw new Error(`部署后 Hash 校验失败: ${target.root}`)
    }
  } catch (error) {
    const failures = []
    for (const c of touched.reverse()) {
      try {
        safeFile(c.root, c.name)
        if (c.before === null) { if (existsSync(c.path)) unlinkSync(c.path) }
        else { mkdirSync(dirname(c.path), { recursive: true }); writeFileSync(c.path, c.before) }
      } catch { failures.push(c.path) }
    }
    throw new Error(`${error.message}；${failures.length ? `回滚失败 ${failures.join(', ')}` : '已回滚本次文件修改'}；备份: ${backup}`)
  }
  return { changed: changes.length, backup }
}

export async function verifyRunning(build, { port = 43121, authToken = '' } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { headers: authToken ? { authorization: `Bearer ${authToken}` } : {}, redirect: 'error', signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`运行检查失败: HTTP ${response.status}；检查端口及本地 settings 中的令牌`)
  const health = await response.json()
  if (!health.ok || health.service !== 'ST-bridge' || health.build?.revision !== build.revision || health.build?.version !== build.version) throw new Error('运行进程指纹与源码不一致（或旧版本没有指纹）；请完全退出并重启 DSH')
  return health
}

async function main() {
  const options = { profile: join(homedir(), '.dsh', 'profiles', 'desktop'), settings: join(homedir(), '.dsh', 'st-bridge', 'settings.json'), mode: '--check' }
  let modeSet = false
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (['--check', '--apply', '--verify-running'].includes(arg)) {
      if (modeSet) throw new Error('每次只选择一种操作')
      options.mode = arg; modeSet = true
    } else if (['--profile', '--settings', '--port'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2)] = args[++i]
    else throw new Error('用法: node deploy.mjs [--check|--apply|--verify-running] [--profile 路径] [--settings 路径] [--port 43121]')
  }
  const settings = existsSync(options.settings) ? JSON.parse(readFileSync(options.settings, 'utf8')) : {}
  const port = Number(options.port ?? settings.port ?? 43121)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port 必须为 1–65535')
  const plan = inspectDeployment(options)
  console.log(`源码 v${plan.build.version} sha256=${plan.build.revision}\nNode 解析入口: ${plan.entry}`)
  for (const target of plan.targets) console.log(`${target.root}\n  ${target.linkedToSource ? '源码链接' : `独立副本，${target.changes.length} 个文件待同步`} sha256=${target.build.revision}`)
  if (options.mode === '--apply') {
    const result = await applyDeployment(plan, { port })
    console.log(`文件同步完成: ${result.changed}；备份: ${result.backup ?? '无需备份'}\n尚未验证运行进程；请启动 DSH 后运行 --verify-running。`)
  } else if (options.mode === '--verify-running') {
    const health = await verifyRunning(plan.build, { port, authToken: settings.authToken ?? '' })
    if (!plan.targets.some(target => realpathSync(dirname(health.build.entry_path)) === target.root && target.build.revision === health.build.revision)) throw new Error('运行入口不属于当前 profile 的已检查部署目标')
    if (plan.targets.some(target => target.changes.length)) throw new Error('运行指纹匹配，但部署副本仍有差异；请在退出 DSH 后同步')
    console.log(`运行进程验证通过: ${health.build.entry_path}\n已加载 sha256=${health.build.revision}`)
  } else {
    console.log('只读检查完成；磁盘一致不代表运行进程已更新。启动后使用 --verify-running。')
    if (plan.targets.some(target => target.changes.length)) process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
