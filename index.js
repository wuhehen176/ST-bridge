/**
 * Baobaohui bridge — a DSH host plugin.
 *
 * It owns a small localhost HTTP server and maps each frontend chat_id to a
 * real DSH Agent session. Sessions are created through ctx.agents, so they are
 * ordinary DSH sessions: visible in the UI, resumable, and continuable by hand.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BridgeEngine } from './lib/engine.js'
import { createLogger } from './lib/log.js'
import { PanelController, applyPersistedSettings, registerPanelRpc } from './lib/panel.js'
import { createBridgeServer, VERSION } from './lib/server.js'
import { BridgeStore } from './lib/store.js'
import { clampInteger, ensureDir } from './lib/util.js'

export const name = 'baobaohui-bridge'

export const inject = [
  'agents',
  'agentDefaultModel',
  'agentPresets',
  'sessionController',
  'connection',
  'webServer',
]

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const host = typeof config.host === 'string' && config.host.trim() !== '' ? config.host.trim() : '127.0.0.1'
  return {
    host: LOCAL_HOSTS.has(host) || config.allowRemote === true ? host : '127.0.0.1',
    port: clampInteger(config.port, 0, 65535) ?? 43121,
    stateDir: typeof config.stateDir === 'string' && config.stateDir.trim() !== ''
      ? config.stateDir
      : join(dshHome, 'baobaohui-bridge'),
    cwd: typeof config.cwd === 'string' && config.cwd.trim() !== '' ? config.cwd : process.cwd(),
    agentPreset: typeof config.agentPreset === 'string' && config.agentPreset.trim() !== ''
      ? config.agentPreset.trim()
      : 'baobaohui-bridge',
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
    allowedClientIds: Array.isArray(config.allowedClientIds) ? config.allowedClientIds.map(String) : [],
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
        ctx.logger?.(name)?.error?.(`baobaohui-bridge 启动失败: ${error instanceof Error ? error.message : String(error)}`)
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
  }, 'baobaohui-bridge.server')
}

export { normalizeConfig }
