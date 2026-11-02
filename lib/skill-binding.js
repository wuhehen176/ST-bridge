import { createHash } from 'node:crypto'
import { BridgeError } from './errors.js'
import { clientEndpoints } from './client-endpoints.js'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 5_000

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function escapeText(value) {
  return String(value).replaceAll('&', '&lt;').replaceAll('>', '&gt;')
}

function resourceHint(skill) {
  const base = skill?.resourceBase
  if (base === undefined) return [`Resources for this skill are managed by provider "${escapeText(skill.provider)}".`, 'Load referenced resources only as needed.']
  if (base.kind === 'directory') return [`Base directory for this skill: ${escapeText(base.path)}`, 'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.']
  if (base.kind === 'url') return [`Base URL for this skill: ${escapeText(base.url)}`, 'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.']
  if (base.kind === 'opaque') return [`Resources for this skill: ${escapeText(base.description)}`, 'Load referenced resources only as needed.']
  return ['Resources for this skill are managed by the provider.', 'Load referenced resources only as needed.']
}

/**
 * Canonical model-facing skill envelope. Kept in sync with DSH's
 * renderSkillContent() so injected content matches the native skill tool.
 */
export function renderSkillContent(skill) {
  return [
    `<skill_content name="${escapeAttribute(skill.name)}">`,
    '<skill_resources>',
    ...resourceHint(skill),
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

export function boundSkillFor(config, clientId) {
  if (!clientId) return null
  const entry = clientEndpoints(config.clientEndpoints).find(item => item.id === clientId && item.enabled !== false)
  return entry?.skillId ?? null
}

function timeoutError() {
  return new BridgeError(503, 'skill_timeout', '读取 Skill 超时；请检查 Skill 文件或 provider')
}

/**
 * Load one skill through the Host registry. First version injects a
 * self-contained body only; resources and scripts are not read automatically.
 */
export async function loadBoundSkill(ctx, { skillId, cwd, scope, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!skillId) return null
  if (typeof skillId !== 'string' || !SKILL_NAME.test(skillId)) {
    throw new BridgeError(400, 'invalid_skill_id', 'skillId 必须是 kebab-case 的 Skill 名称')
  }
  const registry = ctx?.skills
  if (!registry || typeof registry.get !== 'function') {
    throw new BridgeError(503, 'skill_registry_unavailable', 'DSH 未提供 Skill 注册表，无法加载绑定 Skill')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
  let skill
  try {
    skill = await Promise.race([
      registry.get(skillId, { cwd, scope, signal: controller.signal }),
      new Promise((_, reject) => setTimeout(() => reject(timeoutError()), Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))),
    ])
  } catch (error) {
    if (error instanceof BridgeError) throw error
    if (controller.signal.aborted) throw timeoutError()
    throw new BridgeError(503, 'skill_load_failed', `读取 Skill 失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
  if (!skill) throw new BridgeError(400, 'skill_not_found', `绑定 Skill 不存在：${skillId}`)
  if (skill.name !== skillId) throw new BridgeError(400, 'skill_not_found', `Skill 名称不匹配：期望 ${skillId}，实际 ${skill.name}`)
  if (skill.invocation?.userInvocable !== true) {
    throw new BridgeError(400, 'skill_not_invocable', `Skill ${skillId} 不允许管理员显式调用`)
  }
  if (typeof skill.content !== 'string' || skill.content.trim() === '') {
    throw new BridgeError(400, 'skill_empty', `Skill ${skillId} 正文为空`)
  }
  const text = renderSkillContent(skill)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_SKILL_BYTES) {
    throw new BridgeError(400, 'skill_too_large', `Skill ${skillId} 超过 ${MAX_SKILL_BYTES} UTF-8 字节限制`)
  }
  return {
    id: skill.name,
    provider: skill.provider,
    hash: createHash('sha256').update(text).digest('hex'),
    text,
    bytes,
  }
}
