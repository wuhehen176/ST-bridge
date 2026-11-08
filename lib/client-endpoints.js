import { BridgeError, badRequest } from './errors.js'
import { normalizeTaskId } from './session-protocol.js'
import { isPlainObject } from './util.js'

const ID = /^[a-z][a-z0-9_-]{0,63}$/
const SKILL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PRESET = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/
const DEFAULTS = [
  { id: 'yuzi-phone', label: '玉子手机', taskId: 'phone', enabled: true },
  { id: 'shujuku', label: '数据库', taskId: 'database', enabled: true },
]

function optionalText(value, field, max, code) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw badRequest(`${field}必须是字符串`, code)
  const text = value.trim()
  if (!text) return ''
  if (text.length > max) {
    throw badRequest(`${field}长度不能超过${max}个字符`, code)
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw badRequest(`${field}包含非法控制字符`, code)
  }
  return text
}

export function clientEndpoints(value) {
  const entries = value === undefined ? DEFAULTS : value
  if (!Array.isArray(entries) || entries.length > 64) throw badRequest('插件接入清单必须为数组，最多64项', 'invalid_client_endpoints')
  const seen = new Set()
  return entries.map(entry => {
    if (!isPlainObject(entry) || typeof entry.id !== 'string' || !ID.test(entry.id)) {
      throw badRequest('插件ID须为小写字母开头的1-64位字母、数字、下划线或短横线', 'invalid_client_endpoint_id')
    }
    if (seen.has(entry.id)) throw badRequest(`插件ID重复：${entry.id}`, 'duplicate_client_endpoint')
    seen.add(entry.id)
    if (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 128) throw badRequest('插件显示名称必须为1-128位字符串', 'invalid_client_endpoint_label')
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw badRequest('插件启用状态须为布尔值', 'invalid_client_endpoint_enabled')
    if (entry.persistentSession !== undefined && typeof entry.persistentSession !== 'boolean') {
      throw badRequest('持续会话状态须为布尔值', 'invalid_client_endpoint_persistent_session')
    }
    if (entry.skillId !== undefined && entry.skillId !== null && entry.skillId !== ''
      && (typeof entry.skillId !== 'string' || !SKILL.test(entry.skillId))) {
      throw badRequest('专属 Skill 必须是 kebab-case 名称', 'invalid_client_endpoint_skill')
    }
    const provider = optionalText(entry.provider, 'Provider', 128, 'invalid_client_endpoint_provider')
    const model = optionalText(entry.model, '模型', 200, 'invalid_client_endpoint_model')
    if (Boolean(provider) !== Boolean(model)) {
      throw badRequest('插件模型与 Provider 必须同时填写或同时留空', 'invalid_client_endpoint_model')
    }
    const agentPreset = optionalText(entry.agentPreset, 'Agent 预设', 128, 'invalid_client_endpoint_preset')
    if (agentPreset && !PRESET.test(agentPreset)) {
      throw badRequest('Agent 预设 ID 格式不正确', 'invalid_client_endpoint_preset')
    }
    const cwd = optionalText(entry.cwd, '工作区', 2048, 'invalid_client_endpoint_cwd')
    let maxTokens = null
    if (entry.maxTokens !== undefined && entry.maxTokens !== null && entry.maxTokens !== '') {
      maxTokens = typeof entry.maxTokens === 'number'
        ? entry.maxTokens
        : Number(entry.maxTokens)
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 1_000_000) {
        throw badRequest('插件 max_tokens 必须是 1-1000000 的整数', 'invalid_client_endpoint_max_tokens')
      }
    }
    return {
      id: entry.id,
      label: entry.label.trim(),
      taskId: normalizeTaskId(entry.taskId),
      enabled: entry.enabled !== false,
      ...(entry.persistentSession === true ? { persistentSession: true } : {}),
      ...(entry.skillId ? { skillId: entry.skillId } : {}),
      ...(provider ? { provider, model } : {}),
      ...(agentPreset ? { agentPreset } : {}),
      ...(cwd ? { cwd } : {}),
      ...(maxTokens !== null ? { maxTokens } : {}),
    }
  })
}

/** Resolve per-plugin model overrides without making disabled plugins a config error. */
export function clientEndpointConfig(config, id) {
  if (typeof id !== 'string' || !id) return null
  try {
    return clientEndpoints(config.clientEndpoints).find(entry => entry.id === id) ?? null
  } catch {
    return null
  }
}

/** Only business routes get aliases. Never alias management, pairing or self-test routes. */
export function clientEndpointPath(pathname) {
  const match = /^\/clients\/([a-z][a-z0-9_-]{0,63})\/v1\/(models|chat\/completions)$/.exec(pathname)
  return match ? { id: match[1], canonical: `/v1/${match[2]}` } : null
}

export function findClientEndpoint(config, id) {
  const entry = clientEndpoints(config.clientEndpoints).find(item => item.id === id)
  if (!entry) throw new BridgeError(404, 'client_endpoint_not_found', `未登记的插件接入：${id}`)
  if (!entry.enabled) throw new BridgeError(403, 'client_endpoint_disabled', `插件接入已停用：${id}`)
  return entry
}

export function endpointSession(entry, body, session, { chatId, clientId, taskId } = {}) {
  const declared = [session?.client_id, session?.clientId, body.client_id, body.clientId, clientId].filter(value => value !== undefined && value !== null && value !== '')
  if (declared.some(value => value !== entry.id)) throw new BridgeError(409, 'client_endpoint_conflict', '接入地址与请求中的 client_id 不一致，请为各插件使用独立预设')
  const chat = session?.chat_id || session?.chatId || chatId
  if (typeof chat !== 'string' || !chat.trim()) throw badRequest('插件专属地址仍需当前酒馆 chat_id；请启用手机扩展的自动聊天隔离', 'missing_chat_id')
  return {
    ...session,
    protocol_version: session?.protocol_version ?? 1,
    client_id: entry.id,
    chat_id: chat,
    task_id: normalizeTaskId(session?.task_id ?? session?.taskId ?? body.task_id ?? body.taskId ?? taskId ?? entry.taskId),
    action: session?.action ?? 'generate',
    fixed_message_count: session?.fixed_message_count ?? 0,
    fixed_message_types: session?.fixed_message_types ?? [],
  }
}
