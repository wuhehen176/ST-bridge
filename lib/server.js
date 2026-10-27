import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { LOADED_BUILD } from './build-info.js'
import { RequestReceipts } from './request-receipts.js'
import { normalizeMessages } from './context.js'
import { parseContextRequest, applyContextProfile, contextAudit } from './context-policy.js'
import { normalizeContextMode } from './context.js'
import { BridgeError, badRequest } from './errors.js'
import {
  assertTextOnlyRequest,
  normalizeClientId,
  normalizeTaskId,
  paramsFromBody,
  resolveScope,
  parseFixedRules,
} from './session-protocol.js'
import { isPlainObject, safeEqual } from './util.js'

export const VERSION = LOADED_BUILD.version
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function corsHeaders(origin, config) {
  const allowOrigin = origin ?? '*'
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': [
      'authorization',
      'content-type',
      'x-api-key',
      'x-chat-id',
      'x-st-bridge-chat-id',
      'x-conversation-id',
      'x-request-id',
      'x-client-id',
      'x-task-id',
      'idempotency-key',
      'x-idempotency-key',
      'x-context-mode',
    ].join(', '),
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

function originAllowed(origin, config) {
  if (!origin) return true
  if (config.corsOrigins?.includes('*')) return true
  if (Array.isArray(config.corsOrigins) && config.corsOrigins.includes(origin)) return true
  if (origin === 'null') return config.allowNullOrigin === true
  try {
    const url = new URL(origin)
    if (LOCAL_HOSTS.has(url.hostname)) return true
    if (config.allowExtensionOrigins !== false && (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:')) return true
  } catch {
    return false
  }
  return false
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded || res.destroyed) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

function sendError(res, error, extraHeaders = {}, receipt) {
  const status = error instanceof BridgeError ? error.status : 500
  const message = error instanceof BridgeError
    ? error.message
    : (error instanceof Error ? error.message : String(error))
  const code = error instanceof BridgeError ? error.code : 'internal_error'
  sendJson(res, status, { error: { message, type: code, code }, ...(receipt ? { bridge: { receipt } } : {}) }, extraHeaders)
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new BridgeError(413, 'body_too_large', `请求体超过 ${maxBytes} 字节上限`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        if (!isPlainObject(parsed)) {
          reject(badRequest('请求体必须是 JSON 对象', 'invalid_json'))
          return
        }
        resolve(parsed)
      } catch {
        reject(badRequest('请求体不是合法 JSON', 'invalid_json'))
      }
    })
    req.on('error', reject)
    req.on('aborted', () => reject(new BridgeError(499, 'client_closed', '客户端已断开')))
  })
}

function header(req, name) {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function stringValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function chatIdFrom(body, req) {
  return stringValue(
    body.chat_id,
    body.chatId,
    body.conversation_id,
    body.conversationId,
    body.metadata?.chat_id,
    body.metadata?.chatId,
    header(req, 'x-chat-id'),
    header(req, 'x-st-bridge-chat-id'),
    header(req, 'x-conversation-id'),
    header(req, 'x-sillytavern-chat-id'),
  )
}

function requestIdFrom(body, req) {
  return stringValue(
    body.request_id,
    body.requestId,
    body.metadata?.request_id,
    body.metadata?.requestId,
    header(req, 'x-request-id'),
    header(req, 'idempotency-key'),
    header(req, 'x-idempotency-key'),
  )
}

/**
 * Compatibility for clients that can add a static dsh_session but cannot
 * generate a unique request_id (for example a YAML custom-body preset).
 * Hashing the same body keeps automatic retries idempotent.
 */
function generatedRequestId(body, chatId) {
  const seed = JSON.stringify({
    chatId,
    action: body.dsh_session?.action ?? body.dshSession?.action ?? 'generate',
    messages: body.messages ?? [],
    ...(body.dsh_context?.profile_id && body.dsh_context.profile_id !== 'original'
      ? { contextProfile: [body.dsh_context.profile_id, body.dsh_context.profile_hash ?? null] } : {}),
  })
  return `auto-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`
}

function contextModeFrom(body, req) {
  return stringValue(body.context_mode, body.contextMode, header(req, 'x-context-mode')) ?? 'auto'
}

function dshSessionFrom(body) {
  for (const candidate of [body.dsh_session, body.dshSession, body.metadata?.dsh_session, body.metadata?.dshSession]) {
    if (isPlainObject(candidate)) return candidate
  }
  return undefined
}

function authOk(req, config) {
  const token = config.authToken
  if (!token) return true
  const authorization = header(req, 'authorization') ?? ''
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : ''
  const apiKey = header(req, 'x-api-key') ?? ''
  return safeEqual(bearer, token) || safeEqual(apiKey, token)
}

function modelAllowed(model, config) {
  if (model === undefined) return true
  if (model === 'dsh-default' || model === 'default') return true
  return Boolean(config.model && model === config.model)
}

function sseChunk(res, payload) {
  if (res.writableEnded || res.destroyed) return
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    // The client may have gone away while the Agent was working.
  }
}

function completionId(requestId) {
  return `chatcmpl-${requestId}`
}

function baseResponse(result, requestId) {
  return {
    id: completionId(requestId),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'dsh-default',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.answer },
      finish_reason: result.finishReason ?? 'stop',
    }],
    ...(result.usage ? { usage: result.usage } : {}),
    dsh_session: {
      client_id: 'baibai-image',
      chat_id: result.chatId,
      task_id: 'default',
      session_id: result.sessionId,
    },
    bridge: {
      client_id: 'baibai-image',
      chat_id: result.chatId,
      task_id: 'default',
      session_id: result.sessionId,
      turn: result.turn,
      idempotent: result.idempotent === true,
      branch: result.branch === true,
    },
  }
}

function dshResponse(result, requestId, scope) {
  const choices = result.action === 'generate'
    ? [{
      index: 0,
      message: { role: 'assistant', content: result.answer },
      finish_reason: result.finishReason ?? 'stop',
    }]
    : []
  return {
    id: completionId(requestId),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'dsh-default',
    choices,
    ...(result.usage ? { usage: result.usage } : {}),
    dsh_session: {
      client_id: scope.clientId,
      chat_id: scope.chatId,
      task_id: scope.taskId,
      request_id: requestId,
      session_id: result.sessionId,
    },
    bridge: {
      ...(result.contextAudit ? { context: result.contextAudit } : {}),
      ...(result.preset ? { preset: result.preset } : {}),
      ...(result.inputCleanup ? { input_cleanup: result.inputCleanup } : {}),
      ...(result.dynamicDiff ? { dynamic_diff: result.dynamicDiff } : {}),
      client_id: scope.clientId,
      chat_id: scope.chatId,
      task_id: scope.taskId,
      session_id: result.sessionId,
      turn: result.turn,
      idempotent: result.idempotent === true,
      branch: false,
    },
  }
}

async function handleStream(res, result, requestId, includeUsage) {
  if (!res.headersSent) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
  }
  const base = {
    id: completionId(requestId),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'dsh-default',
  }
  sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
  sseChunk(res, { ...base, choices: [{ index: 0, delta: { content: result.answer }, finish_reason: null }] })
  sseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: result.finishReason ?? 'stop' }] })
  if (includeUsage && result.usage) {
    sseChunk(res, { ...base, choices: [], usage: result.usage })
  }
  if (!res.writableEnded && !res.destroyed) {
    try {
      res.write('data: [DONE]\n\n')
      res.end()
    } catch {
      // Client already disconnected.
    }
  }
}

export function createBridgeServer({ engine, config, log }) {
  const startedAt = Date.now()
  const keepAlives = new Set()
  const receipts = new RequestReceipts()

  const server = createServer(async (req, res) => {
    res.on('error', () => {
      // A disconnected SSE client must not surface as an unhandled 'error'.
    })
    const origin = header(req, 'origin')
    if (!originAllowed(origin, config)) {
      sendJson(res, 403, { error: { message: '不允许的 Origin，仅接受本机页面或配置白名单', type: 'origin_forbidden', code: 'origin_forbidden' } })
      return
    }
    for (const [name, value] of Object.entries(corsHeaders(origin, config))) res.setHeader(name, value)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (!authOk(req, config)) {
      sendJson(res, 401, { error: { message: '缺少或错误的桥接访问令牌', type: 'unauthorized', code: 'unauthorized' } })
      return
    }

    const url = new URL(req.url ?? '/', `http://${header(req, 'host') || '127.0.0.1'}`)
    let receipt
    try {
      if (req.method === 'GET' && url.pathname === '/v1/bridge/context/receipts') {
        const filters = Object.fromEntries(['trace_id', 'client_id', 'chat_id', 'task_id'].map(key => [key, url.searchParams.get(key)]))
        sendJson(res, 200, { version: 1, retention: 'memory-last-60', receipts: receipts.list(filters) })
        return
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'ST-bridge',
          version: VERSION,
          build: LOADED_BUILD,
          uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
          host: config.host,
          port: server.address()?.port ?? config.port,
          agent_preset: config.agentPreset,
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        sendJson(res, 200, engine.models())
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/bridge/capabilities') {
        sendJson(res, 200, {
          ...engine.capabilities(),
          version: VERSION,
          legacy_plain_mode: config.allowLegacyPlain === true,
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/v1/bridge/status') {
        const chatId = stringValue(url.searchParams.get('chat_id'), url.searchParams.get('chatId'))
        if (!chatId) throw badRequest('缺少 chat_id', 'missing_chat_id')
        const clientId = normalizeClientId(stringValue(url.searchParams.get('client_id'), url.searchParams.get('clientId')))
        const taskId = normalizeTaskId(stringValue(url.searchParams.get('task_id'), url.searchParams.get('taskId')))
        sendJson(res, 200, engine.statusScoped(resolveScope({ clientId, chatId, taskId })))
        return
      }

      if (url.pathname === '/v1/bridge/fixed-presets' && ['GET', 'POST'].includes(req.method)) {
        const result = req.method === 'GET'
          ? engine.presetConfigs.list()
          : engine.presetConfigs.save(await readBody(req, config.maxBodyBytes))
        sendJson(res, 200, result)
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/bridge/fixed-presets/preview') {
        const body = await readBody(req, config.maxBodyBytes)
        const dsh = dshSessionFrom(body)
        if (!dsh || !Array.isArray(body.messages)) throw badRequest('预览需要原始 messages 和 dsh_session', 'invalid_preset_preview')
        if (dsh.protocol_version !== 1 || typeof dsh.chat_id !== 'string' || !dsh.chat_id || dsh.chat_id.length > 256) {
          throw badRequest('预览需要有效的 v1 会话身份', 'invalid_preset_preview')
        }
        const scope = resolveScope({
          clientId: normalizeClientId(dsh.client_id),
          chatId: dsh.chat_id,
          taskId: normalizeTaskId(dsh.task_id),
        })
        if (config.allowedClientIds?.length && !config.allowedClientIds.includes(scope.clientId)) {
          throw new BridgeError(403, 'client_not_allowed', '该客户端不在桥接允许列表中')
        }
        const { messages } = normalizeMessages(body.messages)
        const count = dsh.fixed_message_count ?? 0
        parseFixedRules(messages, count, dsh.fixed_message_types ?? [])
        const dynamic = messages.slice(count)
        let systemCount = 0
        while (systemCount < dynamic.length && dynamic[systemCount].role === 'system') systemCount += 1
        // Preview is read-only: it never installs, never confirms and never
        // touches the stored management record.
        sendJson(res, 200, engine.previewPreset({ scope, dynamicSystem: dynamic.slice(0, systemCount) }))
        return
      }

      if (url.pathname === '/v1/bridge/context/profiles' && ['GET', 'POST'].includes(req.method)) {
        const result = req.method === 'GET'
          ? engine.contextProfiles.list()
          : engine.contextProfiles.save(await readBody(req, config.maxBodyBytes))
        sendJson(res, 200, result)
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/bridge/context/preview') {
        const body = await readBody(req, config.maxBodyBytes)
        const dsh = dshSessionFrom(body)
        if (!dsh || !Array.isArray(body.messages)) throw badRequest('预览需要原始 messages 和 dsh_session', 'invalid_context_preview')
        if (dsh.protocol_version !== 1 || typeof dsh.chat_id !== 'string' || !dsh.chat_id || dsh.chat_id.length > 256) throw badRequest('预览需要有效的 v1 会话身份', 'invalid_context_preview')
        const scope = resolveScope({ clientId: normalizeClientId(dsh.client_id), chatId: dsh.chat_id, taskId: normalizeTaskId(dsh.task_id) })
        if (config.allowedClientIds?.length && !config.allowedClientIds.includes(scope.clientId)) throw new BridgeError(403, 'client_not_allowed', '该客户端不在桥接允许列表中')
        const { messages } = normalizeMessages(body.messages)
        const count = dsh.fixed_message_count ?? 0
        const supplied = parseFixedRules(messages, count, dsh.fixed_message_types ?? [])
        const chat = engine.store.getChat(scope.scopeKey)
        const rules = count ? supplied : chat?.sourceFixedRules ?? chat?.fixedRules ?? []
        const request = parseContextRequest(body.dsh_context ?? { version: 1, sources: [] }, messages)
        const profile = engine.contextProfiles.resolve(request.profile_id, scope, request.profile_hash)
        sendJson(res, 200, { preview_only: true, ...contextAudit(messages, count, request, profile, rules, applyContextProfile(rules, profile)) })
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/bridge/reset') {
        const body = await readBody(req, config.maxBodyBytes)
        const chatId = chatIdFrom(body, req)
        if (!chatId) throw badRequest('缺少 chat_id', 'missing_chat_id')
        const clientId = normalizeClientId(stringValue(body.client_id, body.clientId, header(req, 'x-client-id')))
        const taskId = normalizeTaskId(stringValue(body.task_id, body.taskId, header(req, 'x-task-id')))
        sendJson(res, 200, engine.resetScoped(resolveScope({ clientId, chatId, taskId })))
        return
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readBody(req, config.maxBodyBytes)
        receipt = receipts.begin(body)
        assertTextOnlyRequest(body)
        let dshSession = dshSessionFrom(body)
        let plainCompatSession = false
        if (!dshSession && config.plainCompat?.enabled === true) {
          // 玉子手机等插件只能填 URL/Key/模型，无法附带 dsh_session。
          // 仅在用户显式开启时，把普通请求归入一个固定的本机 scope。
          const compatChatId = stringValue(chatIdFrom(body, req), config.plainCompat.chatId)
          if (!compatChatId) throw badRequest('plainCompat 需要 chat_id', 'missing_chat_id')
          const messageCount = Array.isArray(body.messages) ? body.messages.length : 0
          const requestedFixed = config.plainCompat.fixedMessageCount ?? 0
          // Never consume the only remaining message: the dynamic group must
          // keep at least one user turn or the engine rejects the request.
          const fixedCount = Math.min(requestedFixed, Math.max(0, messageCount - 1))
          if (fixedCount !== requestedFixed) {
            log(`[http] plain-compat 固定组从 ${requestedFixed} 降为 ${fixedCount}（消息只有 ${messageCount} 条）`)
          }
          dshSession = {
            protocol_version: 1,
            client_id: stringValue(body.client_id, header(req, 'x-client-id'), config.plainCompat.clientId),
            chat_id: compatChatId,
            task_id: stringValue(body.task_id, header(req, 'x-task-id'), config.plainCompat.taskId),
            request_id: stringValue(requestIdFrom(body, req), generatedRequestId(body, compatChatId)),
            action: 'generate',
            fixed_message_count: fixedCount,
            fixed_message_types: (config.plainCompat.fixedMessageTypes ?? []).slice(0, fixedCount),
          }
          body.dsh_session = dshSession
          plainCompatSession = true
          log(`[http] plain-compat 归入 ${dshSession.client_id}/${compatChatId}/${dshSession.task_id}`)
        }
        if (!dshSession && config.allowLegacyPlain !== true) {
          throw badRequest(
            '本桥接只接受 dsh_session 持久会话协议；请用实际首次生成验证会话，或在桥接配置中显式开启 allowLegacyPlain',
            'persistent_protocol_required',
          )
        }
        if (dshSession) {
          const dshChatId = stringValue(dshSession.chat_id, dshSession.chatId, chatIdFrom(body, req))
          let dshRequestId = stringValue(dshSession.request_id, dshSession.requestId, requestIdFrom(body, req))
          if (!dshChatId) throw badRequest('缺少 dsh_session.chat_id', 'missing_chat_id')
          if (!dshRequestId) dshRequestId = generatedRequestId(body, dshChatId)
          const clientId = normalizeClientId(stringValue(
            dshSession.client_id,
            dshSession.clientId,
            body.client_id,
            header(req, 'x-client-id'),
          ))
          const taskId = normalizeTaskId(stringValue(
            dshSession.task_id,
            dshSession.taskId,
            body.task_id,
            header(req, 'x-task-id'),
          ))
          const scope = resolveScope({ clientId, chatId: dshChatId, taskId })
          Object.assign(receipt, { client_id: clientId, chat_id: dshChatId, task_id: taskId, request_id: dshRequestId })
          if (!modelAllowed(body.model, config)) {
            throw badRequest(`未知模型 "${body.model}"；本桥接只提供 dsh-default`, 'model_not_found')
          }
          const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.maxTokens
          if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
            throw badRequest('max_tokens 必须是正整数', 'invalid_max_tokens')
          }
          // The persistent protocol is deliberately non-streaming. Ignore a
          // stream flag instead of returning SSE to a plugin that expects JSON.
          const result = await engine.handleDshSession({
            protocolVersion: dshSession.protocol_version,
            clientId,
            chatId: dshChatId,
            taskId,
            requestId: dshRequestId,
            action: dshSession.action,
            sessionId: dshSession.session_id,
            messages: body.messages ?? [],
            fixedCount: dshSession.fixed_message_count,
            fixedTypes: dshSession.fixed_message_types,
            target: dshSession.target,
            maxTokens,
            params: paramsFromBody(body),
            context: body.dsh_context,
          })
          Object.assign(receipt, { status: 'completed', http_status: 200, session_id: result.sessionId, idempotent: result.idempotent === true })
          if (result.inputCleanup) receipt.bridge_cleanup = result.inputCleanup
          // Plain-compat clients may expect SSE even though the persistent
          // protocol is normally JSON. Only synthesize streaming for requests
          // we created ourselves, so explicit dsh_session callers keep JSON.
          if (plainCompatSession && body.stream === true && result.action === 'generate') {
            await handleStream(res, { ...result, chatId: dshChatId }, dshRequestId, body.stream_options?.include_usage === true)
            return
          }
          const response = dshResponse(result, dshRequestId, scope)
          response.bridge.receipt = { ...receipt } // Fresh even when the generation result was cached.
          sendJson(res, 200, response, {
            'x-bridge-client-id': scope.clientId,
            'x-bridge-task-id': scope.taskId,
            'x-bridge-chat-id': encodeURIComponent(dshChatId),
            'x-bridge-session-id': result.sessionId,
            'x-bridge-idempotent': result.idempotent ? 'true' : 'false',
          })
          return
        }

        const chatId = chatIdFrom(body, req)
        const requestId = requestIdFrom(body, req)
        if (!chatId) throw badRequest('缺少 chat_id（可放在 body.chat_id、metadata.chat_id 或 x-chat-id 头）', 'missing_chat_id')
        if (!requestId) throw badRequest('缺少 request_id（可放在 body.request_id、metadata.request_id、x-request-id 或 idempotency-key 头）', 'missing_request_id')
        if (!modelAllowed(body.model, config)) {
          throw badRequest(`未知模型 "${body.model}"；本桥接只提供 dsh-default`, 'model_not_found')
        }
        const maxTokens = body.max_tokens ?? body.max_completion_tokens ?? body.maxTokens
        if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
          throw badRequest('max_tokens 必须是正整数', 'invalid_max_tokens')
        }
        const contextMode = normalizeContextMode(contextModeFrom(body, req))
        const stream = body.stream === true
        const includeUsage = body.stream_options?.include_usage === true

        const abort = new AbortController()
        let streamKeepAlive

        if (stream) {
          // Send SSE headers before the (possibly long) DSH turn so the client
          // does not time out while the Agent works.
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-store',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          streamKeepAlive = setInterval(() => {
            try { res.write(': keep-alive\n\n') } catch { /* client gone */ }
          }, 15_000)
          keepAlives.add(streamKeepAlive)
        }

        try {
          const result = await engine.handle({
            chatId,
            requestId,
            messages: body.messages,
            contextMode,
            title: body.title ?? body.metadata?.title,
            maxTokens,
            signal: abort.signal,
          })
          Object.assign(receipt, { status: 'completed', http_status: 200, request_id: requestId, session_id: result.sessionId, idempotent: result.idempotent === true })
          const headers = {
            'x-bridge-chat-id': encodeURIComponent(chatId),
            'x-bridge-session-id': result.sessionId,
            'x-bridge-idempotent': result.idempotent ? 'true' : 'false',
          }
          if (stream) {
            if (streamKeepAlive) {
              clearInterval(streamKeepAlive)
              keepAlives.delete(streamKeepAlive)
              streamKeepAlive = undefined
            }
            await handleStream(res, { ...result, chatId }, requestId, includeUsage)
          } else {
            sendJson(res, 200, baseResponse({ ...result, chatId }, requestId), headers)
          }
        } catch (error) {
          Object.assign(receipt, { status: 'rejected', http_status: error?.status ?? 500, error_code: error?.code ?? 'internal_error' })
          if (stream) {
            if (streamKeepAlive) {
              clearInterval(streamKeepAlive)
              keepAlives.delete(streamKeepAlive)
              streamKeepAlive = undefined
            }
            if (!res.headersSent) {
              sendError(res, error)
            } else {
              const message = error instanceof Error ? error.message : String(error)
              sseChunk(res, { error: { message, type: error?.code ?? 'internal_error' } })
              res.write('data: [DONE]\n\n')
              res.end()
            }
          } else {
            sendError(res, error)
          }
          log(`[http] ${req.method} ${url.pathname} chat=${chatId} request=${requestId} -> ${error?.status ?? 500} ${error?.message ?? error}`)
        } finally {
          if (streamKeepAlive) {
            clearInterval(streamKeepAlive)
            keepAlives.delete(streamKeepAlive)
          }
        }
        return
      }

      sendJson(res, 404, { error: { message: `未知路由 ${req.method} ${url.pathname}`, type: 'not_found', code: 'not_found' } })
    } catch (error) {
      if (receipt) Object.assign(receipt, { status: 'rejected', http_status: error?.status ?? 500, error_code: error?.code ?? 'internal_error' })
      sendError(res, error, {}, receipt)
      log(`[http] ${req.method} ${url.pathname} -> ${error?.status ?? 500} ${error?.message ?? error}`)
    }
  })

  server.on('clientError', (error, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* ignore */ }
    log(`[http] clientError: ${error.message}`)
  })

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = error => reject(error)
        server.once('error', onError)
        server.listen(config.port, config.host, () => {
          server.removeListener('error', onError)
          const address = server.address()
          log(`[bridge] listening on http://${config.host}:${address?.port ?? config.port}`)
          resolve(address?.port ?? config.port)
        })
      })
    },
    close() {
      for (const timer of keepAlives) clearInterval(timer)
      keepAlives.clear()
      return new Promise(resolve => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
