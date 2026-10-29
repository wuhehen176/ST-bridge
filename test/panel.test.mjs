import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PanelController, applyPersistedSettings, registerPanelRpc, sanitizeSettings } from '../lib/panel.js'
import { normalizeConfig } from '../index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'bbh-panel-'))
}

function baseConfig(dir) {
  return normalizeConfig({ stateDir: dir, cwd: dir, port: 43121 })
}

test('sanitizeSettings validates and normalizes panel fields', () => {
  const dir = tempDir()
  try {
    const config = baseConfig(dir)
    const { settings } = sanitizeSettings({
      host: '127.0.0.1',
      port: 43210,
      provider: 'lunaroute',
      model: 'deepseek-4.1-flash',
      maxTokens: 8192,
      requestTimeoutMs: 60000,
      corsOrigins: 'http://localhost:8000\nhttp://127.0.0.1:8000',
      allowLegacyPlain: true,
    }, config)
    assert.equal(settings.port, 43210)
    assert.equal(settings.provider, 'lunaroute')
    assert.deepEqual(settings.corsOrigins, ['http://localhost:8000', 'http://127.0.0.1:8000'])
    assert.equal(settings.allowLegacyPlain, true)
    assert.throws(() => sanitizeSettings({ host: '0.0.0.0' }, config), /allowRemote/)
    const remote = sanitizeSettings({ host: '0.0.0.0', allowRemote: true }, config)
    assert.equal(remote.settings.host, '0.0.0.0')
    const allowed = sanitizeSettings({ allowedClientIds: 'yuzi-phone\nshujuku' }, config)
    assert.deepEqual(allowed.settings.allowedClientIds, ['yuzi-phone', 'shujuku'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PanelController saves, redacts token, and reloads persisted settings', () => {
  const dir = tempDir()
  try {
    const config = baseConfig(dir)
    const chats = []
    const store = {
      listChats: () => chats,
      getChat: () => undefined,
      clearAll: () => 0,
    }
    const engine = {
      capabilities: () => ({ object: 'bridge.capabilities' }),
      resetScoped: () => ({ ok: true }),
      clearRules: () => ({ ok: true }),
    }
    const serverControl = {
      isRunning: () => true,
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
    }
    const panel = new PanelController({
      ctx: {}, config, store, engine, serverControl, log: () => {}, version: '0.3.0',
    })
    const saved = panel.save({
      settings: {
        port: 43211,
        provider: 'lunaroute',
        model: 'deepseek-4.1-flash',
        authToken: 'secret-token',
        allowLegacyPlain: true,
        clientEndpoints: [{ id: 'phone-test', label: '手机测试', taskId: 'phone', enabled: true }],
      },
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.restart_required, true)
    assert.equal(config.port, 43211)
    assert.equal(config.authToken, 'secret-token')
    assert.equal(panel.status().service.authTokenSet, true)
    assert.equal(panel.status().service.clientEndpoints[0].id, 'phone-test')

    const file = join(dir, 'settings.json')
    assert.equal(existsSync(file), true)
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(persisted.authToken, 'secret-token')

    const raw = panel.raw()
    assert.equal(raw.settings.authToken, '')
    assert.equal(raw.authTokenSet, true)

    panel.save({ settings: { authToken: '' } })
    assert.equal(config.authToken, 'secret-token')
    panel.save({ settings: { clearAuthToken: true } })
    assert.equal(config.authToken, '')

    const reload = baseConfig(dir)
    reload.authToken = 'from-cordis-patch'
    const applied = applyPersistedSettings(reload)
    assert.equal(applied.applied, true)
    assert.equal(reload.port, 43211)
    assert.equal(reload.authToken, '')
    assert.deepEqual(reload.clientEndpoints, [{ id: 'phone-test', label: '手机测试', taskId: 'phone', enabled: true }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registerPanelRpc uses the DSH connection channel when available', async () => {
  let channel
  let handler
  let disposed = false
  const ctx = {
    connection: {
      rpc: {
        handle(name, fn) {
          channel = name
          handler = fn
          return () => { disposed = true }
        },
      },
    },
  }
  const panel = { call: async (endpoint, payload) => ({ ok: true, value: { endpoint, payload } }) }
  const dispose = registerPanelRpc(ctx, panel, () => {})
  assert.equal(channel, '/st-bridge')
  assert.equal(typeof handler, 'function')
  const result = await handler('status', { a: 1 })
  assert.equal(result.value.endpoint, 'status')
  dispose()
  assert.equal(disposed, true)
})

test('PanelController actions require confirmation for destructive operations', async () => {
  const dir = tempDir()
  try {
    const config = baseConfig(dir)
    const chat = {
      clientId: 'yuzi-phone', taskId: 'qq', chatId: 'chat-1', sessionId: 'session-st-x',
      title: '玉子手机 · 测试', fixedRules: [{ type: 'spec', role: 'system', text: 'RULE' }],
      knownMessages: [], previousSessions: [], updatedAt: new Date().toISOString(),
    }
    const store = {
      listChats: () => [chat],
      getChat: () => chat,
      clearAll: () => 1,
    }
    const calls = []
    const engine = {
      capabilities: () => ({ object: 'bridge.capabilities' }),
      resetScoped: scope => { calls.push(['reset', scope]); return { ok: true } },
      clearRules: scope => { calls.push(['clear', scope]); return { ok: true } },
    }
    const serverControl = { isRunning: () => true, start: async () => {}, stop: async () => {}, restart: async () => {} }
    const panel = new PanelController({ ctx: {}, config, store, engine, serverControl, log: () => {}, version: '0.3.0' })

    const rules = panel.rules({ client_id: 'yuzi-phone', chat_id: 'chat-1', task_id: 'qq' })
    assert.equal(rules.fixed_rules[0].text, 'RULE')
    await panel.action({ action: 'reset_binding', client_id: 'yuzi-phone', chat_id: 'chat-1', task_id: 'qq' })
    assert.equal(calls[0][0], 'reset')
    await panel.action({ action: 'clear_rules', client_id: 'yuzi-phone', chat_id: 'chat-1', task_id: 'qq' })
    assert.equal(calls[1][0], 'clear')

    await assert.rejects(() => panel.action({ action: 'clear_bindings' }), /RESET/)
    const cleared = await panel.action({ action: 'clear_bindings', confirm: 'RESET' })
    assert.equal(cleared.removed, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('enable mobile access persists a LAN host, generates a token and restarts', async () => {
  const dir = tempDir()
  try {
    const config = normalizeConfig({ stateDir: dir, cwd: dir, port: 43121 })
    let restarts = 0
    const serverControl = {
      isRunning: () => true,
      address: () => ({ host: '0.0.0.0', port: 43121 }),
      start: async () => {},
      stop: async () => {},
      restart: async () => { restarts += 1 },
    }
    const panel = new PanelController({
      ctx: {}, config, store: {}, engine: { capabilities: () => ({}) }, serverControl, log: () => {}, version: '0.9.5',
    })
    const result = await panel.action({ action: 'enable_mobile_access' })
    assert.equal(result.ok, true)
    assert.equal(restarts, 1)
    assert.equal(config.host, '0.0.0.0')
    assert.equal(config.allowRemote, true)
    assert.ok(config.authToken.length >= 32)
    assert.equal(result.token, config.authToken)
    const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    assert.equal(saved.host, '0.0.0.0')
    assert.equal(saved.allowRemote, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rotate_auth_token returns the new value once and persists it', async () => {
  const dir = tempDir()
  try {
    const config = normalizeConfig({ stateDir: dir, cwd: dir, port: 43121 })
    const panel = new PanelController({
      ctx: {}, config, store: {}, engine: { capabilities: () => ({}) },
      serverControl: { isRunning: () => true, start: async () => {}, stop: async () => {}, restart: async () => {} },
      log: () => {}, version: '0.9.8',
    })
    const result = await panel.action({ action: 'rotate_auth_token' })
    assert.equal(result.ok, true)
    assert.ok(result.token.length >= 32)
    assert.equal(config.authToken, result.token)
    const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    assert.equal(saved.authToken, result.token)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
