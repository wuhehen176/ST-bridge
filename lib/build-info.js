import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)))

export function packageFiles(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (pkg.name !== 'ST-bridge' || !Array.isArray(pkg.files)) throw new Error('不是有效的 ST-bridge 包')
  const files = new Map()
  function visit(name) {
    const path = resolve(root, name)
    const rel = relative(root, path)
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../')) {
      throw new Error(`包文件越界: ${name}`)
    }
    // Deployment never includes local settings, session data, logs or Git data.
    if (rel.split(/[\\/]/).some(part => part.startsWith('.') || /^(node_modules|settings\.json|state\.json)$|^(context-profiles|fixed-presets)|\.log$/i.test(part))) {
      throw new Error(`包清单包含非发布文件: ${name}`)
    }
    // Check every ancestor as well as the leaf; never follow a junction.
    let cursor = path
    while (cursor !== resolve(root)) {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`包文件包含链接: ${name}`)
      cursor = dirname(cursor)
    }
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(rel, child))
    } else if (stat.isFile()) {
      files.set(rel.replaceAll('\\', '/'), readFileSync(path))
    } else throw new Error(`不支持的包文件: ${name}`)
  }
  for (const name of ['package.json', ...pkg.files]) visit(name)
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b, 'en')))
}

export function buildInfo(root, files = packageFiles(root)) {
  const pkg = JSON.parse(files.get('package.json').toString('utf8'))
  const hash = createHash('sha256')
  for (const [name, bytes] of files) {
    if (name !== 'package.json' && name !== 'index.js' && name !== 'client.js' && !name.startsWith('lib/') && !name.startsWith('assets/')) continue
    hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes)
  }
  return Object.freeze({ version: pkg.version, revision: hash.digest('hex'), entry_path: join(realpathSync(root), 'index.js') })
}

// Capture once at module load. Replacing files on disk cannot masquerade as a restart.
export const LOADED_BUILD = buildInfo(PACKAGE_ROOT)
