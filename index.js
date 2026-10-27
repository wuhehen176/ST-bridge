/**
 * ST-bridge bridge — a DSH host plugin.
 *
 * It owns a small localhost HTTP server and maps each frontend chat_id to a
 * real DSH Agent session. Sessions are created through ctx.agents, so they are
 * ordinary DSH sessions: visible in the UI, resumable, and continuable by hand.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOADED_BUILD } from './lib/build-info.js'
import { BridgeEngine } from './lib/engine.js'
import { createLogger } from './lib/log.js'
import { PanelController, applyPersistedSettings, registerPanelRpc } from './lib/panel.js'
import { createBridgeServer, VERSION } from './lib/server.js'
import { BridgeStore } from './lib/store.js'
import { normalizeSnapshotMarker } from './lib/snapshot-diff.js'
import { clampInteger, ensureDir } from './lib/util.js'

export const name = 'ST-bridge'

export const inject = [
  'agents',
  'agentDefaultModel',
  'agentPresets',
  'sessionController',
  'llm',
  'connection',
  'webServer',
]

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const host = typeof config.host === 'string' && config.host.trim() !== '' ? config.host.trim() : '127.0.0.1'
  const appendNonce = typeof config.appendNonce === 'string'
    ? config.appendNonce.trim().toUpperCase().replace(/^STB-/, '')
    : ''
  return {
    host: LOCAL_HOSTS.has(host) || config.allowRemote === true ? host : '127.0.0.1',
    port: clampInteger(config.port, 0, 65535) ?? 43121,
    stateDir: typeof config.stateDir === 'string' && config.stateDir.trim() !== ''
      ? config.stateDir
      : join(dshHome, 'st-bridge'),
    cwd: typeof config.cwd === 'string' && config.cwd.trim() !== ''
      ? config.cwd
      : (process.env.DSH_CWD || process.cwd()),
    agentPreset: typeof config.agentPreset === 'string' && config.agentPreset.trim() !== ''
      ? config.agentPreset.trim()
      : 'st-bridge',
    provider: typeof config.provider === 'string' ? config.provider.trim() : '',
    model: typeof config.model === 'string' ? config.model.trim() : '',
    maxTokens: clampInteger(config.maxTokens, 1, Number.MAX_SAFE_INTEGER),
    requestTimeoutMs: clampInteger(config.requestTimeoutMs, 5_000, 24 * 60 * 60 * 1000) ?? 30 * 60 * 1000,
    maxBodyBytes: clampInteger(config.maxBodyBytes, 1024, 256 * 1024 * 1024) ?? 32 * 1024 * 1024,
    authToken: typeof config.authToken === 'string' ? config.authToken.trim() : '',
    corsOrigins: Array.isArray(config.corsOrigins) ? config.corsOrigins.map(String) : undefined,
    allowExtensionOrigins: config.allowExtensionOrigins !== false,
    allowNullOrigin: config.allowNullOrigin === true,
    allowLegacyPlain: config.allowLegacyPlain === true,
    allowRemote: config.allowRemote === true,
    sessionOnStale: config.sessionOnStale === 'recreate' ? 'recreate' : 'error',
    sessionOnArchived: config.sessionOnArchived === 'recreate' ? 'recreate' : 'error',
    contextOverflow: config.contextOverflow === 'recreate' ? 'recreate' : 'error',
    transientRetry: clampInteger(config.transientRetry, 0, 2) ?? 0,
    appendFormat: config.appendFormat === 'tagged' ? 'tagged' : 'nonce',
    appendNonce: /^[A-F0-9]{8,32}$/.test(appendNonce) ? appendNonce : '7F3A9C2E',
    allowedClientIds: Array.isArray(config.allowedClientIds) ? config.allowedClientIds.map(String) : [],
    plainCompat: {
      enabled: config.plainCompat?.enabled === true,
      clientId: typeof config.plainCompat?.clientId === 'string' && config.plainCompat.clientId.trim() !== ''
        ? config.plainCompat.clientId.trim()
        : 'yuzi-phone',
      chatId: typeof config.plainCompat?.chatId === 'string' && config.plainCompat.chatId.trim() !== ''
        ? config.plainCompat.chatId.trim()
        : 'yuzi-phone',
      taskId: typeof config.plainCompat?.taskId === 'string' && config.plainCompat.taskId.trim() !== ''
        ? config.plainCompat.taskId.trim()
        : 'default',
      fixedMessageCount: clampInteger(config.plainCompat?.fixedMessageCount, 0, 4) ?? 0,
      fixedMessageTypes: Array.isArray(config.plainCompat?.fixedMessageTypes)
        ? config.plainCompat.fixedMessageTypes.map(String)
        : [],
    },
    inputCleanup: {
      enabled: config.inputCleanup?.enabled !== false,
      tags: Array.isArray(config.inputCleanup?.tags) && config.inputCleanup.tags.length > 0
        ? config.inputCleanup.tags.map(String)
        : ['bbi_image'],
    },
    snapshotDiff: {
      enabled: config.snapshotDiff?.enabled === true,
      mode: config.snapshotDiff?.mode === 'marker' ? 'marker' : 'auto',
      marker: normalizeSnapshotMarker(config.snapshotDiff?.marker),
      maxBlockChars: clampInteger(config.snapshotDiff?.maxBlockChars, 64, 20000) ?? 2000,
      clients: Array.isArray(config.snapshotDiff?.clients)
        ? config.snapshotDiff.clients.map(String)
        : ['shujuku', 'yuzi-phone'],
      onDivergence: config.snapshotDiff?.onDivergence === 'branch' ? 'branch' : 'full',
    },
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const persisted = applyPersistedSettings(config)
  let resources
  let disposed = false

  const start = async () => {
    ensureDir(config.stateDir)
    ensureDir(config.cwd)
    const log = createLogger({
      file: join(config.stateDir, 'bridge.log'),
      ctx,
      name,
    })
    for (const warning of persisted.warnings) log(`[panel] 忽略无效的持久设置: ${warning}`)
    const store = new BridgeStore(join(config.stateDir, 'state.json'))
    if (store.loadError) log(`[bridge] 状态文件损坏，已备份并重新开始: ${store.loadError.message}`)
    const engine = new BridgeEngine(ctx, config, store, log)
    let activeServer
    let running = false
    const serverControl = {
      isRunning: () => running,
      address: () => running && activeServer
        ? { host: config.host, port: activeServer.server.address()?.port ?? config.port }
        : null,
      async start() {
        if (activeServer) return
        const next = createBridgeServer({ engine, config, log })
        await next.listen()
        activeServer = next
        running = true
      },
      async stop() {
        const current = activeServer
        activeServer = undefined
        running = false
        if (current) await current.close()
      },
      async restart() {
        await this.stop()
        await this.start()
      },
    }
    const panel = new PanelController({
      ctx,
      config,
      store,
      engine,
      serverControl,
      log,
      version: VERSION,
    })
    resources = { log, store, engine, panel, serverControl }
    try {
      resources.rpcDispose = registerPanelRpc(ctx, panel, log)
    } catch (error) {
      log(`[panel] 注册设置通道失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    log(`[bridge] 启动 ${config.host}:${config.port} cwd=${config.cwd} preset=${config.agentPreset}`)
    log(`[build] version=${LOADED_BUILD.version} sha256=${LOADED_BUILD.revision} entry=${LOADED_BUILD.entry_path}`)
    try {
      await serverControl.start()
    } catch (error) {
      log(`[bridge] 监听 ${config.host}:${config.port} 失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.effect(() => {
    void start().catch(error => {
      // A bad bridge config must not take the whole DSH host down. The error is
      // visible in the log and through the plugin status.
      try {
        ctx.logger?.(name)?.error?.(`ST-bridge 启动失败: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
        // Ignore logger failures.
      }
    })
    const offPrompt = typeof ctx.on === 'function'
      ? ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembled = await next()
        const sessionId = context?.agent?.session?.id
        if (!resources?.engine?.isProtocolSession(sessionId)) return assembled
        return resources.engine.augmentProtocolAssembly(assembled, sessionId)
      })
      : undefined
    return () => {
      if (disposed) return
      disposed = true
      try { offPrompt?.() } catch { /* ignore */ }
      try { resources?.rpcDispose?.() } catch { /* ignore */ }
      try { void resources?.serverControl?.stop?.()?.catch?.(() => {}) } catch { /* ignore */ }
      try { resources?.engine?.dispose() } catch { /* ignore */ }
      try { resources?.store?.flush() } catch { /* ignore */ }
      resources?.log?.('[bridge] 已停止')
    }
  }, 'st-bridge.server')
}

export { normalizeConfig }
