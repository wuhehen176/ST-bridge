import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { messageHash } from '../lib/context.js'
import { BridgeEngine } from '../lib/engine.js'

const SYSTEM = (text, role = 'system') => ({ role, text, hash: messageHash(role, text) })

function engineWith(t, presets) {
  const dir = mkdtempSync(join(tmpdir(), 'preset-engine-'))
  t.after(() => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
    rmSync(dir, { recursive: true, force: true })
  })
  if (presets) writeFileSync(join(dir, 'fixed-presets.json'), JSON.stringify(presets), 'utf8')
  const ctx = { agents: {}, get: name => (name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p', model: 'm' }) } : undefined) }
  const chats = new Map()
  const store = {
    file: join(dir, 'state.json'),
    listChats: () => [...chats.values()],
    getChat: key => chats.get(key),
    putChat: (key, value) => { chats.set(key, value) },
    updateChat: (key, patch) => {
      const next = { ...chats.get(key), ...patch }
      chats.set(key, next)
      return next
    },
    putRequest: () => {},
    removeRequest: () => {},
  }
  return { engine: new BridgeEngine(ctx, { stateDir: dir, agentPreset: 'st-bridge' }, store, () => {}), store, chats }
}

const scope = { clientId: 'shujuku', taskId: 'database', chatId: 'chat-1', scopeKey: 'scope-x' }

test('planPreset sends the full copy on first install and confirms only after the turn', (t) => {
  const presetBody = 'DATABASE_FIXED_PRESET'
  const { engine, store } = engineWith(t, {
    version: 1,
    presets: [{
      id: 'db', label: 'db', client_id: 'shujuku', task_id: 'database', mode: 'exact',
      exact_hashes: [messageHash('system', presetBody)],
    }],
  })
  const chat = { chatId: 'chat-1', sessionId: '', fixedRules: [] }
  store.putChat('scope-x', chat)
  const plan = engine.planPreset({ scope, chat, dynamicSystem: [SYSTEM(presetBody), SYSTEM('WORLDBOOK')] })
  assert.equal(plan.diagnostic.status, 'first-install')
  assert.equal(plan.dynamicSystem.length, 2, 'first turn still sends the original copy')
  assert.deepEqual(plan.managedPreset.texts, [{ role: 'system', text: presetBody }])
  assert.ok(plan.install)

  engine.confirmPresetInstall('scope-x', 'session-st-1', plan.install, plan.diagnostic)
  const saved = store.getChat('scope-x').presetManagement
  assert.equal(saved.presetId, 'db')
  assert.equal(saved.sessionId, 'session-st-1')
  assert.equal(JSON.stringify(saved).includes(presetBody), false, 'management record stores hashes only')
})

test('planPreset deduplicates only the confirmed version for the same session', (t) => {
  const presetBody = 'DATABASE_FIXED_PRESET'
  const { engine, store } = engineWith(t, {
    version: 1,
    presets: [{
      id: 'db', label: 'db', client_id: 'shujuku', task_id: 'database', mode: 'exact',
      exact_hashes: [messageHash('system', presetBody)],
    }],
  })
  const chat = { chatId: 'chat-1', sessionId: 'session-st-1', fixedRules: [] }
  store.putChat('scope-x', chat)
  const first = engine.planPreset({ scope, chat, dynamicSystem: [SYSTEM(presetBody), SYSTEM('WORLDBOOK')] })
  engine.confirmPresetInstall('scope-x', 'session-st-1', first.install, first.diagnostic)

  const confirmedChat = store.getChat('scope-x')
  const second = engine.planPreset({ scope, chat: confirmedChat, dynamicSystem: [SYSTEM(presetBody), SYSTEM('WORLDBOOK')] })
  assert.equal(second.diagnostic.status, 'reused')
  assert.equal(second.install, undefined)
  assert.deepEqual(second.dynamicSystem.map(m => m.text), ['WORLDBOOK'])
  assert.equal(second.diagnostic.deduped_chars, presetBody.length)
  assert.equal(JSON.stringify(second.diagnostic).includes(presetBody), false, 'diagnostics never carry preset text')
})

test('a changed preset version reinstalls and an unknown boundary keeps everything', (t) => {
  const body = 'DATABASE_FIXED_PRESET'
  const { engine, store } = engineWith(t, {
    version: 1,
    presets: [{
      id: 'db', label: 'db', client_id: 'shujuku', task_id: 'database', mode: 'exact',
      exact_hashes: [messageHash('system', body)],
    }],
  })
  const chat = { chatId: 'chat-1', sessionId: 'session-st-1', fixedRules: [] }
  store.putChat('scope-x', chat)
  const plan = engine.planPreset({ scope, chat, dynamicSystem: [SYSTEM(body)] })
  engine.confirmPresetInstall('scope-x', 'session-st-1', plan.install, plan.diagnostic)

  const changed = store.getChat('scope-x')
  changed.presetManagement = { ...changed.presetManagement, hash: 'old-hash' }
  const reinstalled = engine.planPreset({ scope, chat: changed, dynamicSystem: [SYSTEM(body)] })
  assert.equal(reinstalled.diagnostic.status, 'first-install')
  assert.ok(reinstalled.install)

  // A new session must not silently reuse the previous install.
  const newSession = { ...changed, sessionId: 'session-st-2' }
  const fresh = engine.planPreset({ scope, chat: newSession, dynamicSystem: [SYSTEM(body)] })
  assert.equal(fresh.diagnostic.reason, 'session-changed')

  // Unrecognised content is preserved and reported, never trimmed.
  const unknown = engine.planPreset({ scope, chat: changed, dynamicSystem: [SYSTEM('UNRELATED')] })
  assert.equal(unknown.diagnostic.status, 'not-found')
  assert.equal(unknown.dynamicSystem.length, 1)
  assert.equal(unknown.install, undefined)
})

test('no configured preset leaves the request untouched', (t) => {
  const { engine, store } = engineWith(t)
  const chat = { chatId: 'chat-1', sessionId: '', fixedRules: [] }
  store.putChat('scope-x', chat)
  const plan = engine.planPreset({ scope, chat, dynamicSystem: [SYSTEM('ANY')] })
  assert.equal(plan.diagnostic, undefined)
  assert.deepEqual(plan.dynamicSystem.map(m => m.text), ['ANY'])
  assert.equal(plan.managedPreset, undefined)
})

test('preview never mutates the stored install record', (t) => {
  const body = 'DATABASE_FIXED_PRESET'
  const { engine, store } = engineWith(t, {
    version: 1,
    presets: [{
      id: 'db', label: 'db', client_id: 'shujuku', task_id: 'database', mode: 'exact',
      exact_hashes: [messageHash('system', body)],
    }],
  })
  store.putChat('scope-x', { chatId: 'chat-1', sessionId: 'session-st-1', fixedRules: [] })
  const preview = engine.previewPreset({ scope, dynamicSystem: [SYSTEM(body)] })
  assert.equal(preview.preview_only, true)
  assert.equal(preview.status, 'identified')
  assert.equal(preview.deduped_chars, body.length)
  assert.equal(store.getChat('scope-x').presetManagement, undefined)
  const none = engine.previewPreset({ scope: { ...scope, clientId: 'yuzi-phone' }, dynamicSystem: [SYSTEM(body)] })
  assert.equal(none.status, 'no-preset')
})
