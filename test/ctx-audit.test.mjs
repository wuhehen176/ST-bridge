import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('audit keeps events separate, labels estimates, and leaves input unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-audit-'))
  try {
    const statePath = join(dir, 'state.json')
    const outputPath = join(dir, 'report.json')
    const input = JSON.stringify({ chats: { example: {
      fixedRules: [{ type: 'spec', text: 'PRIVATE_RULE_TEXT' }],
      requests: {
        old: { turn: 1, usage: { completion_tokens: 2 } },
        current: { turn: 2, usage: {
          prompt_tokens: 20, completion_tokens: 3,
          diagnostics: { usageEventCount: 7, maxUsageEventPromptTokens: 12,
            cacheReporting: 'unavailable' },
        } },
        partial: { turn: 3, usage: { prompt_tokens: 200000,
          prompt_cache_hit_tokens: 150000,
          diagnostics: { cacheReporting: 'reported', cacheCoverage: 'partial' },
        } },
        legacy: { turn: 4, usage: { prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: 80 },
        } },
      },
    } } })
    writeFileSync(statePath, input)
    const result = spawnSync(process.execPath, [
      'tools/ctx-audit.mjs', '--state', statePath, '--json', outputPath,
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(statePath, 'utf8'), input)
    assert.equal(result.stdout.includes('PRIVATE_RULE_TEXT'), false)
    assert.match(result.stdout, /事件数/)
    assert.match(result.stdout, /调用数/)
    assert.match(result.stdout, /估算/)
    const report = JSON.parse(readFileSync(outputPath, 'utf8'))
    assert.equal(report.chats[0].rows[1].usageEventCount, 7)
    assert.equal(report.chats[0].rows[1].modelCallCount, null)
    assert.equal(report.chats[0].rows[1].maxPromptTokens, null)
    assert.equal(report.chats[0].rows[1].maxUsageEventPromptTokens, 12)
    assert.equal(report.chats[0].median, 100)
    assert.equal(report.chats[0].rows[2].cacheHitTokens, 150000)
    assert.equal(report.chats[0].rows[2].cacheCoverage, 'partial')
    assert.equal(report.chats[0].rows[3].cacheHitTokens, 80)
    assert.equal(report.chats[0].rows[3].cacheCoverage, 'unknown')
    assert.equal(report.chats[0].drops.length, 1)
    assert.match(result.stdout, /不能据此判定上下文重建/)
  } finally {
    for (const name of ['state.json', 'report.json']) rmSync(join(dir, name), { force: true })
    rmdirSync(dir)
  }
})
