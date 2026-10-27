import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { applyDeployment, inspectDeployment, verifyRunning } from '../deploy.mjs'
import { buildInfo, packageFiles, LOADED_BUILD, PACKAGE_ROOT } from '../lib/build-info.js'
import { createBridgeServer } from '../lib/server.js'

function put(root, name, value) {
  mkdirSync(dirname(join(root, name)), { recursive: true })
  writeFileSync(join(root, name), value)
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'st-deploy-'))
  t.after(() => {
    if (!resolve(base).startsWith(resolve(tmpdir()) + sep)) throw new Error('fixture cleanup escaped temp')
    rmSync(base, { recursive: true, force: true })
  })
  const source = join(base, 'source')
  const profile = join(base, 'profile')
  const installed = join(profile, 'node_modules', 'ST-bridge')
  const vendor = join(profile, 'vendor', 'ST-bridge')
  for (const root of [source, installed, vendor]) {
    put(root, 'package.json', JSON.stringify({ name: 'ST-bridge', version: '0.4.0', type: 'module', main: 'index.js', files: ['index.js', 'lib', 'README.md'] }))
    put(root, 'index.js', 'export const value = 1\n')
    put(root, 'lib/old.js', 'export default 1\n')
    put(root, 'README.md', 'documentation')
  }
  put(profile, 'package.json', JSON.stringify({ private: true }))
  put(source, 'index.js', 'export const value = 2\n')
  put(source, 'lib/new.js', 'export default 2\n')
  rmSync(join(source, 'lib/old.js'))
  put(installed, 'settings.json', '{"private":"SECRET"}')
  put(vendor, 'state.json', '{"session":"PRIVATE"}')
  return { base, source, profile, installed, vendor }
}

const stopped = async () => {}

test('resolves and updates BOTH independent copies; preserves data and backs up removed code', async t => {
  const f = fixture(t)
  const plan = inspectDeployment(f)
  assert.equal(plan.entry, join(f.installed, 'index.js'))
  assert.equal(plan.targets.length, 2)
  const result = await applyDeployment(plan, { stopCheck: stopped })
  assert.ok(result.changed > 0)
  for (const root of [f.installed, f.vendor]) {
    assert.equal(buildInfo(root).revision, buildInfo(f.source).revision)
    assert.equal(existsSync(join(root, 'lib/old.js')), false)
  }
  assert.equal(readFileSync(join(f.installed, 'settings.json'), 'utf8'), '{"private":"SECRET"}')
  assert.equal(readFileSync(join(f.vendor, 'state.json'), 'utf8'), '{"session":"PRIVATE"}')
  assert.equal(readFileSync(join(result.backup, '0/lib/old.js'), 'utf8'), 'export default 1\n')
  assert.equal(inspectDeployment(f).targets.every(target => target.changes.length === 0), true)
  assert.deepEqual(await applyDeployment(inspectDeployment(f), { stopCheck: stopped }), { changed: 0, backup: null })
})

test('a running host prevents all deployment writes', async t => {
  const f = fixture(t)
  const original = readFileSync(join(f.installed, 'index.js'))
  await assert.rejects(applyDeployment(inspectDeployment(f), { stopCheck: async () => { throw new Error('still running') } }), /still running/)
  assert.deepEqual(readFileSync(join(f.installed, 'index.js')), original)
  assert.equal(existsSync(join(f.profile, '.st-bridge-backups')), false)
})

test('copy failure in the second target rolls back both copies, including newly created and removed files', async t => {
  const f = fixture(t)
  const before = [packageFiles(f.installed), packageFiles(f.vendor)]
  await assert.rejects(applyDeployment(inspectDeployment(f), { stopCheck: stopped, write(path, bytes) {
    writeFileSync(path, bytes)
    if (path === join(f.vendor, 'lib/new.js')) throw new Error('simulated disk failure')
  } }), /已回滚/)
  assert.deepEqual(packageFiles(f.installed), before[0])
  assert.deepEqual(packageFiles(f.vendor), before[1])
})

test('concurrent target changes and invalid source syntax are rejected before copying', async t => {
  const f = fixture(t)
  const plan = inspectDeployment(f)
  put(f.installed, 'index.js', 'export const changed = true\n')
  await assert.rejects(applyDeployment(plan, { stopCheck: stopped }), /目标已变化/)
  assert.equal(readFileSync(join(f.vendor, 'index.js'), 'utf8'), 'export const value = 1\n')
  put(f.source, 'index.js', 'export { broken')
  await assert.rejects(applyDeployment(inspectDeployment(f), { stopCheck: stopped }))
  assert.equal(readFileSync(join(f.installed, 'index.js'), 'utf8'), 'export const changed = true\n')
})

test('package manifest traversal, local data, and nested junctions are rejected', t => {
  const f = fixture(t)
  const pkg = JSON.parse(readFileSync(join(f.source, 'package.json')))
  for (const name of ['../outside', 'settings.json']) {
    put(f.source, 'package.json', JSON.stringify({ ...pkg, files: [name] }))
    assert.throws(() => packageFiles(f.source), /越界|非发布文件/)
  }
  put(f.source, 'package.json', JSON.stringify(pkg))
  symlinkSync(f.vendor, join(f.source, 'lib/link'), 'junction')
  assert.throws(() => packageFiles(f.source), /链接/)
})

test('source-link installation is deduplicated and never copied into itself', async t => {
  const f = fixture(t)
  for (const path of [f.installed, f.vendor]) {
    assert.ok(resolve(path).startsWith(resolve(f.base) + sep))
    rmSync(path, { recursive: true })
  }
  symlinkSync(f.source, f.installed, 'junction')
  symlinkSync(f.source, f.vendor, 'junction')
  const plan = inspectDeployment(f)
  assert.equal(plan.targets.length, 1)
  assert.equal(plan.targets[0].linkedToSource, true)
  assert.equal((await applyDeployment(plan, { stopCheck: stopped })).changed, 0)
})

test('loaded fingerprint is captured once; subsequent disk edits only change fresh disk identity', t => {
  const f = fixture(t)
  put(f.source, 'lib/build-info.js', readFileSync(join(PACKAGE_ROOT, 'lib/build-info.js')))
  const script = `import { LOADED_BUILD, buildInfo, PACKAGE_ROOT } from './lib/build-info.js'; import {appendFileSync} from 'node:fs'; const first=LOADED_BUILD.revision; appendFileSync('./index.js','\\n// changed'); console.log(JSON.stringify({same:LOADED_BUILD.revision===first,different:buildInfo(PACKAGE_ROOT).revision!==first}));`
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: f.source, encoding: 'utf8' })
  assert.deepEqual(JSON.parse(result), { same: true, different: true })
})

test('health returns loaded identity; runtime verification rejects a stale build', async t => {
  const service = createBridgeServer({ engine: {}, config: { host: '127.0.0.1', port: 0, authToken: 'local-test' }, log() {} })
  await service.listen()
  t.after(() => service.close())
  const port = service.server.address().port
  const health = await verifyRunning(LOADED_BUILD, { port, authToken: 'local-test' })
  assert.deepEqual(health.build, LOADED_BUILD)
  await assert.rejects(verifyRunning({ ...LOADED_BUILD, revision: 'stale' }, { port, authToken: 'local-test' }), /指纹/)
  await assert.rejects(verifyRunning(LOADED_BUILD, { port, authToken: 'wrong' }), /HTTP 401/)
})
