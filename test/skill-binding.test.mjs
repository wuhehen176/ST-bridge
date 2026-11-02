import assert from 'node:assert/strict'
import test from 'node:test'
import { boundSkillFor, loadBoundSkill, renderSkillContent } from '../lib/skill-binding.js'
import { clientEndpoints } from '../lib/client-endpoints.js'

const skill = {
  name: 'tavern-lite',
  description: 'test',
  provider: 'filesystem',
  invocation: { userInvocable: true, modelInvocable: true },
  content: 'WRITE_ONLY_JSON',
}

test('client endpoints accept kebab-case skill bindings and reject invalid names', () => {
  const entries = clientEndpoints([
    { id: 'yuzi-phone', label: '玉子', taskId: 'phone', skillId: 'tavern-lite', enabled: true },
    { id: 'shujuku', label: '数据库', taskId: 'database', enabled: true },
  ])
  assert.equal(entries[0].skillId, 'tavern-lite')
  assert.equal(entries[1].skillId, undefined)
  assert.equal(boundSkillFor({ clientEndpoints: entries }, 'yuzi-phone'), 'tavern-lite')
  assert.equal(boundSkillFor({ clientEndpoints: entries }, 'baibai-image'), null)
  assert.throws(() => clientEndpoints([{ id: 'x', label: 'x', taskId: 'default', skillId: 'Bad Skill', enabled: true }]))
})

test('loadBoundSkill renders a canonical envelope and hashes it', async () => {
  const calls = []
  const loaded = await loadBoundSkill({
    skills: {
      get: async (name, options) => {
        calls.push({ name, options })
        return skill
      },
    },
  }, { skillId: 'tavern-lite', cwd: 'D:/work', scope: 'scope:test' })
  assert.equal(calls[0].name, 'tavern-lite')
  assert.equal(calls[0].options.cwd, 'D:/work')
  assert.equal(calls[0].options.scope, 'scope:test')
  assert.match(loaded.text, /<skill_content name="tavern-lite">/)
  assert.match(loaded.text, /WRITE_ONLY_JSON/)
  assert.equal(loaded.hash.length, 64)
  assert.equal(loaded.provider, 'filesystem')
  assert.equal(renderSkillContent(skill), loaded.text)
})

test('loadBoundSkill rejects missing, non-invocable, empty and oversized skills', async () => {
  const registry = value => ({ skills: { get: async () => value } })
  await assert.rejects(loadBoundSkill(registry(undefined), { skillId: 'tavern-lite' }), error => error.code === 'skill_not_found')
  await assert.rejects(loadBoundSkill(registry({ ...skill, invocation: { userInvocable: false, modelInvocable: true } }), { skillId: 'tavern-lite' }), error => error.code === 'skill_not_invocable')
  await assert.rejects(loadBoundSkill(registry({ ...skill, content: '' }), { skillId: 'tavern-lite' }), error => error.code === 'skill_empty')
  await assert.rejects(loadBoundSkill(registry({ ...skill, content: 'x'.repeat(70 * 1024) }), { skillId: 'tavern-lite' }), error => error.code === 'skill_too_large')
})

test('loadBoundSkill reports registry absence and timeout', async () => {
  await assert.rejects(loadBoundSkill({}, { skillId: 'tavern-lite' }), error => error.code === 'skill_registry_unavailable')
  await assert.rejects(loadBoundSkill({ skills: { get: () => new Promise(() => {}) } }, { skillId: 'tavern-lite', timeoutMs: 10 }), error => error.code === 'skill_timeout')
})
