import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modules = ['theme.js', 'helpers.js', 'endpoints.js', 'panel.js', 'index.js']
const check = process.argv.includes('--check')

const parts = modules.map(name => {
  const source = readFileSync(join(root, 'client', name), 'utf8')
  return `    __modules[${JSON.stringify(`./${name}`)}] = function (module, exports, require) {\n${source}\n    }`
})

const output = `window.__ModuleLoader__.load({
  id: 'ST-bridge',
  factory(require) {
    const __modules = {}
    const __cache = {}
${parts.join('\n')}
    function __localRequire(id) {
      if (!__modules[id]) return require(id)
      if (__cache[id]) return __cache[id].exports
      const module = { exports: {} }
      __cache[id] = module
      __modules[id](module, module.exports, __localRequire)
      return module.exports
    }
    return __localRequire('./index.js')
  },
})
`

const target = join(root, 'client.js')
if (check) {
  const current = readFileSync(target, 'utf8')
  if (current !== output) {
    console.error('client.js is stale; run npm run build:client')
    process.exit(1)
  }
  console.log('client.js is up to date')
} else {
  writeFileSync(target, output)
  console.log(`wrote client.js (${Buffer.byteLength(output)} bytes)`)
}
