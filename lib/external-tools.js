import { badRequest, conflict, BridgeError, timeoutError } from './errors.js'
import { normalizeMessages, composeInitialPrompt, messageHash } from './context.js'
import { normalizeClientId, normalizeTaskId, resolveScope, parseFixedRules, scopedTitle, sessionIdFor } from './session-protocol.js'
import { newChatRecord } from './store.js'
import { nowIso, sha256, sleep } from './util.js'
import { recoverTurn } from './turn.js'

/** Deliberately non-streaming native function calls, one external execution at a time. */
export function externalToolRequest(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const active = Array.isArray(body.tools) && body.tools.length > 0
    || messages.some(m => m?.role === 'tool' || Array.isArray(m?.tool_calls) && m.tool_calls.length > 0)
  if (!active) return undefined
  if (!Array.isArray(body.messages) || !body.messages.length) throw badRequest('工具请求的 messages 必须是非空数组', 'invalid_messages')
  if (body.stream === true) throw badRequest('外部工具第一版仅支持 stream:false', 'tool_stream_unsupported')
  if (body.functions != null && (!Array.isArray(body.functions) || body.functions.length) || body.function_call != null) throw badRequest('请使用 tools/function 协议，暂不支持旧 functions 协议', 'legacy_tools_unsupported')
  if (body.tool_choice != null && body.tool_choice !== 'auto') throw badRequest('外部工具第一版仅支持 tool_choice:auto', 'tool_choice_unsupported')
  if (body.parallel_tool_calls === true) throw badRequest('外部工具第一版串行执行，请设 parallel_tool_calls:false', 'parallel_tools_unsupported')
  if (body.response_format?.type === 'json_schema') throw badRequest('工具模式暂不支持严格 response_format/json_schema', 'unsupported_response_format')
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 32)) throw badRequest('tools 必须是最多 32 项的数组', 'invalid_tools')
  const seen = new Set()
  const tools = (body.tools ?? []).map(tool => {
    const f = tool?.function
    if (tool?.type !== 'function' || !f || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(f.name ?? '') || f.name === 'run_code' || seen.has(f.name)) throw badRequest('工具名称无效、重复或使用保留名称 run_code', 'invalid_tools')
    if (f.strict === true) throw badRequest('第一版不承诺 strict 约束采样，请移除 strict:true', 'strict_tools_unsupported')
    if (!f.parameters || f.parameters.type !== 'object' || Array.isArray(f.parameters)) throw badRequest('function.parameters 必须是 object JSON Schema', 'invalid_tools')
    seen.add(f.name)
    return { name: f.name, description: String(f.description ?? ''), parameters: structuredClone(f.parameters) }
  })
  if (messages.filter(m => m?.role === 'tool').some(m => typeof m.tool_call_id !== 'string' || !m.tool_call_id || typeof m.content !== 'string')) throw badRequest('工具结果必须包含 tool_call_id 和字符串 content', 'invalid_tool_result')
  if (messages.some(m => m?.tool_calls !== undefined && (m.role !== 'assistant' || !Array.isArray(m.tool_calls) || m.tool_calls.some(c => !c || typeof c.id !== 'string' || c.type !== 'function' || typeof c.function?.name !== 'string' || typeof c.function?.arguments !== 'string')))) throw badRequest('assistant.tool_calls 格式无效', 'invalid_tool_calls')
  const results = []
  for (let i = messages.length - 1; i >= 0 && messages[i]?.role === 'tool'; i--) results.unshift(messages[i])
  return { tools, results }
}

export class ExternalTools {
  constructor(engine) { this.engine = engine; this.live = new Map() }

  cancel(scopeKey, stop = true) {
    const chat = this.engine.store.getChat(scopeKey)
    const live = this.live.get(chat?.sessionId)
    if (!live) return
    live.stopped = true
    live.waiting?.reject(new Error('External tool session cancelled'))
    if (stop) live.agent?.cancel?.({ kind: 'user' })
    for (const off of live.disposers) off?.()
    this.live.delete(chat.sessionId)
    this.engine.runtimeFor(chat.sessionId).externalTools = undefined
  }

  async handle(input) {
    const e = this.engine
    if (input.protocolVersion !== 1 || (input.action ?? 'generate') !== 'generate') throw badRequest('工具协议只用于 dsh_session v1 generate', 'invalid_tool_session')
    const chatId = String(input.chatId ?? '').trim(), requestId = String(input.requestId ?? '').trim()
    if (!chatId || chatId.length > 256 || !requestId || requestId.length > 256) throw badRequest('工具请求需要有效的 chat_id/request_id', 'invalid_tool_session')
    const clientId = normalizeClientId(input.clientId), taskId = normalizeTaskId(input.taskId)
    if (e.config.allowedClientIds?.length && !e.config.allowedClientIds.includes(clientId ?? 'baibai-image')) throw new BridgeError(403, 'client_not_allowed', 'client_id 不在允许列表中')
    const scope = resolveScope({ clientId, chatId, taskId })
    const hash = sha256(JSON.stringify({ messages: input.messages, tools: input.externalTools.tools, scope: scope.scopeKey, fixedCount: input.fixedCount, fixedTypes: input.fixedTypes, params: input.params, maxTokens: input.maxTokens }))
    return e.enqueue(scope.scopeKey, async () => {
      let chat = e.store.getChat(scope.scopeKey)
      if (input.sessionId && input.sessionId !== chat?.sessionId) throw new BridgeError(410, 'session_gone', '工具请求的 session_id 不属于当前范围')
      const cached = e.store.getRequest(scope.scopeKey, requestId)
      if (cached) {
        if (cached.requestHash !== hash) throw conflict('同一 request_id 的工具请求内容发生变化', 'request_id_conflict')
        if (cached.status === 'done') return { ...cached.result, idempotent: true }
        if (cached.status === 'error') throw new BridgeError(cached.httpStatus, cached.errorCode, cached.errorMessage)
        throw conflict('上次工具请求尚未确认完成；不得重复执行，请检查会话或显式重建', 'tool_request_in_progress')
      }
      const results = input.externalTools.results
      let live = this.live.get(chat?.sessionId)
      if (results.length) {
        const pending = chat?.externalToolPending
        if (!pending || results.length !== 1 || results[0].tool_call_id !== pending.call.id) throw conflict('工具结果与当前待执行调用不匹配', 'tool_result_mismatch')
        if (pending.resultHash) throw conflict('该工具结果已接收，使用原 request_id 重试', 'tool_result_already_received')
        if (!live?.waiting || live.waiting.call.id !== pending.call.id || live.stopped) throw conflict('DSH 工具等待已中断（可能重启或超时）；保留待执行记录，请检查数据库执行结果后显式重建会话，桥接不会自动重放', 'tool_continuation_unavailable')
        if (input.externalTools.tools.length && sha256(JSON.stringify(input.externalTools.tools)) !== live.schemaHash) throw conflict('工具回填期间不能更换工具定义', 'tool_schema_changed')
        this.validateEcho(input.messages, pending.call)
      } else {
        if (chat?.externalToolPending) throw conflict('先回填待执行工具结果，或显式重建会话', 'tool_result_required')
        if (!input.externalTools.tools.length) throw badRequest('首次工具请求需要 tools', 'missing_tools')
        // Only a known session may carry completed protocol history; never invent tool results.
        this.validateHistory(input.messages ?? [], chat)
        const textMessages = (input.messages ?? []).filter(m => m?.role !== 'tool' && !m?.tool_calls?.length)
        const { messages } = normalizeMessages(textMessages)
        const rules = parseFixedRules(messages, input.fixedCount ?? 0, input.fixedTypes ?? [])
        const dynamic = messages.slice(input.fixedCount ?? 0)
        let leading = 0
        while (dynamic[leading]?.role === 'system') leading++
        if (!dynamic.slice(leading).some(m => m.role === 'user')) throw badRequest('工具初始请求需要 user 正文', 'missing_user_message')
        if (chat?.fixedRules?.length && rules.length && JSON.stringify(chat.fixedRules) !== JSON.stringify(rules)) throw conflict('固定规范已变化，请先 sync_rules 或显式重建会话', 'tool_rules_changed')
        const body = dynamic.slice(leading)
        const previous = chat?.externalInputHashes ?? []
        const hashes = body.map(m => m.hash)
        const hasHistory = input.messages.some(m => m.tool_calls?.length)
        const prefixMatches = previous.length > 0 && previous.every((hash, i) => hashes[i] === hash)
        if (hasHistory && previous.length && !prefixMatches) throw conflict('工具历史的正文已改写或缺失，请显式重建会话；不会静默覆盖原历史', 'tool_context_changed')
        const fresh = prefixMatches ? body.slice(previous.length) : body
        if (!fresh.some(m => m.role === 'user')) throw conflict('工具请求没有新增 user 正文', 'missing_new_user_message')
        const sid = chat?.sessionId || sessionIdFor(scope.scopeKey, requestId, 'external-tools')
        if (!chat) {
          chat = newChatRecord({ ...scope, sessionId: sid, title: scopedTitle(chatId, dynamic, undefined, scope.clientId, scope.taskId), cwd: e.effectiveCwd() })
          e.store.putChat(scope.scopeKey, chat)
        }
        // Install only caller-owned schemas, on this Agent's scoped registry.
        const runtime = e.runtimeFor(sid, (input.fixedCount ?? 0) > 0 ? rules : chat.fixedRules)
        runtime.protocol = true; runtime.params = input.params ?? {}; runtime.dynamicSystem = dynamic.slice(0, leading)
        await e.createOrResumeSession(chat, { sessionId: sid, title: chat.title, maxTokens: input.maxTokens, fixedRules: runtime.fixedRules, reason: 'external-tools' })
        const agent = e.ctx.agents.get(sid)
        if (!agent?.ctx?.tools?.register || !agent.ctx.tools.presentAs || !agent.ctx.tools.restrict || !agent.ctx.tools.guard) throw new BridgeError(501, 'external_tools_unavailable', '当前 DSH 运行时没有完整的 Agent 作用域工具注册与隔离接口')
        if (live) this.cancel(scope.scopeKey)
        live = { scope, sessionId: sid, originRequestId: requestId, schemaHash: sha256(JSON.stringify(input.externalTools.tools)), schemas: input.externalTools.tools, disposers: [], agent, waiting: null, stopped: false }
        this.live.set(sid, live); runtime.externalTools = live
        try {
          live.disposers.push(agent.ctx.tools.presentAs('native'))
          live.disposers.push(agent.ctx.tools.restrict({ allow: [] }))
          live.disposers.push(agent.ctx.tools.guard(exec => live.stopped || !live.schemas.some(s => s.name === exec.name) ? 'Only caller-provided external tools are allowed' : undefined))
          for (const schema of live.schemas) live.disposers.push(agent.ctx.tools.register({
            ...schema, isConcurrencySafe: () => false, timeoutMs: e.config.requestTimeoutMs + 5000,
            output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
            execute: (args, exec) => this.execute(live, schema.name, args, exec),
          }))
        } catch (error) { this.cancel(scope.scopeKey); throw new BridgeError(501, 'external_tools_unavailable', `DSH 无法注册工具定义：${error.message}`) }
        live.inputHashes = prefixMatches || !previous.length ? hashes : [...previous, ...hashes]
        e.store.updateChat(scope.scopeKey, { sessionId: sid, protocol: 1, fixedRules: runtime.fixedRules, knownMessages: [], externalToolPending: null })
        live.prompt = composeInitialPrompt(fresh)
      }
      const sid = live.sessionId
      const record = { action: 'external-tools', status: 'pending', requestHash: hash, sessionId: sid,
        ...(results.length ? { toolResult: { id: results[0].tool_call_id, hash: sha256(results[0].content) } } : {}),
        createdAt: nowIso(), updatedAt: nowIso() }
      e.store.putRequest(scope.scopeKey, requestId, record)
      try {
        if (results.length) {
          const pending = e.store.getChat(scope.scopeKey).externalToolPending
          // Persist receipt before releasing the Agent; retries must not apply the result twice.
          e.store.updateChat(scope.scopeKey, { externalToolPending: { ...pending, resultHash: sha256(results[0].content), resultRequestId: requestId } })
          const waiting = live.waiting; live.waiting = null; waiting.resolve(results[0].content)
        } else {
          await e.sendPrompt(sid, requestId, live.prompt)
          delete live.prompt
        }
        const result = await this.wait(live)
        e.store.putRequest(scope.scopeKey, requestId, { ...record, status: 'done', result, updatedAt: nowIso() })
        return result
      } catch (error) {
        const status = error instanceof BridgeError ? error.status : 502
        e.store.putRequest(scope.scopeKey, requestId, { ...record, status: 'error', httpStatus: status, errorCode: error.code || 'external_tool_failed', errorMessage: error.message, updatedAt: nowIso() })
        this.cancel(scope.scopeKey)
        throw error
      }
    })
  }

  validateEcho(messages, call) {
    const echo = [...messages].reverse().find(m => m?.role === 'assistant' && m.tool_calls?.length)
    if (echo && (echo.tool_calls.length !== 1 || JSON.stringify(echo.tool_calls[0]) !== JSON.stringify(call))) {
      // Compare fields rather than object property ordering.
      const c = echo.tool_calls[0]
      if (echo.tool_calls.length !== 1 || c.id !== call.id || c.type !== 'function' || c.function?.name !== call.function.name || c.function?.arguments !== call.function.arguments) throw conflict('assistant 工具调用与桥接记录不一致', 'tool_call_mismatch')
    }
  }

  validateHistory(messages, chat) {
    const records = Object.values(chat?.requests ?? {}).filter(r => r.sessionId === chat?.sessionId)
    const known = new Map(records.flatMap(r => (r.result?.toolCalls ?? []).map(call => [call.id, call])))
    for (const m of messages) {
      for (const call of m?.tool_calls ?? []) {
        const saved = known.get(call.id)
        if (!saved || call.type !== 'function' || call.function?.name !== saved.function.name || call.function?.arguments !== saved.function.arguments) throw conflict('历史工具调用不属于当前会话或内容已改写', 'unexpected_tool_history')
      }
      if (m?.role === 'tool' && !records.some(r => r.toolResult?.id === m.tool_call_id && r.toolResult.hash === sha256(m.content))) throw conflict('历史工具结果未在当前会话确认', 'unexpected_tool_history')
    }
  }

  execute(live, name, args, exec) {
    if (live.stopped || live.waiting || !live.schemas.some(s => s.name === name) || typeof exec.callId !== 'string') throw new Error('External tool call is not active in this session')
    exec.signal?.throwIfAborted()
    const call = { id: exec.callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }
    return new Promise((resolve, reject) => {
      const finish = fn => value => { clearTimeout(timer); exec.signal?.removeEventListener('abort', abort); fn(value) }
      const abort = () => { live.stopped = true; finish(reject)(new Error('DSH external tool execution aborted')) }
      const timer = setTimeout(() => { live.stopped = true; finish(reject)(new Error('External tool result timed out; manual reconciliation required')) }, this.engine.config.requestTimeoutMs)
      timer.unref?.()
      live.waiting = { call, resolve: finish(resolve), reject: finish(reject) }
      exec.signal?.addEventListener('abort', abort, { once: true })
      try {
        this.engine.store.updateChat(live.scope.scopeKey, { externalToolPending: { call, originRequestId: live.originRequestId, sessionId: live.sessionId, schemaHash: live.schemaHash, createdAt: nowIso() } })
      } catch (error) { live.waiting = null; live.stopped = true; finish(reject)(error) }
    })
  }

  async wait(live) {
    const e = this.engine, deadline = Date.now() + e.config.requestTimeoutMs
    while (Date.now() < deadline) {
      if (live.stopped) throw conflict('外部工具等待已取消或超时，请先核对执行状态', 'tool_continuation_unavailable')
      if (live.waiting) return { action: 'generate', answer: null, toolCalls: [live.waiting.call], finishReason: 'tool_calls', sessionId: live.sessionId, idempotent: false }
      const events = await e.readEvents(live.sessionId)
      const result = recoverTurn(events, live.originRequestId)
      if (result) {
        if (!result.ok) throw e.turnFailure(result, live.sessionId)
        e.store.updateChat(live.scope.scopeKey, { externalToolPending: null, lastTurn: result.turn,
          externalInputHashes: [...live.inputHashes, messageHash('assistant', result.answer)] })
        this.cancel(live.scope.scopeKey, false)
        return { ...result, action: 'generate', sessionId: live.sessionId, idempotent: false }
      }
      await sleep(50)
    }
    throw timeoutError('等待外部工具调用或 DSH 最终回答超时')
  }
}
