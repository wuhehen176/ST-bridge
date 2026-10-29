import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as core from '../tavern-extension/core.js'

// Minimal DOM for event/save wiring; this does not claim a phone layout or browser rendering check.
class Element {
  constructor() { this.children = []; this.value = ''; this.checked = false; this.disabled = false; this.textContent = '' }
  set innerHTML(html) { this.fields = new Map([...html.matchAll(/data-id="([^"]+)"/g)].map(([, id]) => [id, new Element()])) }
  querySelector(selector) { return this.fields.get(/data-id="([^"]+)"/.exec(selector)[1]) ?? null }
  append(...items) { this.children.push(...items) }
  replaceChildren(...items) { this.children = items }
  showModal() { this.open = true }
  close() { this.open = false }
}

test('Tavern settings can save global exclusions before any scope exists, with independent scope switches', async () => {
  const root = new Element()
  const document = {
    readyState: 'complete', getElementById: () => null,
    querySelector: selector => selector === '#extensions_settings' ? root : null, createElement: () => new Element(),
    createTextNode: text => ({ textContent: text }),
  }
  const events = new Map()
  let adapter, saves = 0
  const context = {
    extensionSettings: {}, getCurrentChatId: () => 'chat', saveSettingsDebounced: () => saves++,
    eventSource: { on: (name, handler) => events.set(name, handler) },
    eventTypes: { GENERATION_STARTED: 'start', WORLD_INFO_ACTIVATED: 'activated', CHAT_CHANGED: 'chat' },
    getWorldInfoNames: () => ['全局排除书', '本范围书'],
    loadWorldInfo: async name => ({ entries: { 1: { uid: 1, content: `${name}正文`, comment: '范围规则' } } }),
  }
  const window = { SillyTavern: { getContext: () => context } }
  const source = readFileSync(new URL('../tavern-extension/index.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '')
  new Function('window', 'document', 'yaml', 'installAdapter', 'localBase', 'PreviewCopies', 'scopeKey', 'validateMaterialsPolicy', 'mergeMaterialsPolicies', source)(
    window, document, { parse: JSON.parse }, (_host, options) => { adapter = options; return () => {} },
    core.localBase, core.PreviewCopies, core.scopeKey, core.validateMaterialsPolicy, core.mergeMaterialsPolicies,
  )
  const panel = root.children[0], field = id => panel.querySelector(`[data-id="${id}"]`)
  const settings = context.extensionSettings.st_bridge_context_v1
  assert.equal(field('material-enabled').disabled, true)
  assert.equal(field('global-edit-excluded').disabled, false)
  assert.equal(field('edit-green'), null)
  field('global-edit-excluded').onclick()
  const row = field('book-list').children.find(item => item.children[1].textContent === '全局排除书')
  row.children[0].checked = true
  row.children[0].onchange()
  field('picker-save').onclick()
  assert.deepEqual(settings.globalMaterials.excluded, ['全局排除书'])
  assert.equal(settings.globalMaterials.enabled, false)
  const db = { protocol_version: 1, client_id: 'shujuku', chat_id: 'chat', task_id: 'database' }
  const phone = { ...db, client_id: 'yuzi-phone', task_id: 'phone' }
  assert.equal((await adapter.materials(db)).catalog.length, 0)
  field('global-material-enabled').onchange({ target: { checked: true } })
  assert.deepEqual((await adapter.materials(phone)).globalPolicy.excluded, ['全局排除书'])
  adapter.onPreview({ ...db, scope: core.scopeKey(db), trace_id: 'test', sent_at: new Date().toISOString(), sources: [] }, {}, '')
  field('pattern-draft').value = '范围规则'
  field('add-pattern').onclick()
  field('material-enabled').onchange({ target: { checked: true } })
  assert.deepEqual((await adapter.materials(db)).policy.patterns, ['范围规则'])
  assert.deepEqual((await adapter.materials(phone)).policy, {})
  field('material-enabled').onchange({ target: { checked: false } })
  const globalOnly = await adapter.materials(db)
  assert.deepEqual(globalOnly.policy, {})
  assert.deepEqual(globalOnly.globalPolicy.excluded, ['全局排除书'])
  field('global-material-enabled').onchange({ target: { checked: false } })
  assert.equal((await adapter.materials(db)).catalog.length, 0)
  assert.ok(saves >= 5)
})
