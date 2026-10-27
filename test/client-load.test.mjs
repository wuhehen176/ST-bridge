import assert from 'node:assert/strict'
import test from 'node:test'

test('browser bundle registers a settings.section page', async () => {
  let factory
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        assert.equal(entry.id, 'baobaohui-bridge')
        factory = entry.factory
      },
    },
  }
  const ReactStub = {
    createElement: () => null,
    useState: value => [value, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
    useRef: value => ({ current: value }),
  }
  await import('../client.js')
  assert.equal(typeof factory, 'function')
  const plugin = factory(() => ReactStub)
  assert.deepEqual(plugin.inject, ['slots', 'connection'])

  let section
  const ctx = {
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    slots: {
      inject(name, register) {
        assert.equal(name, 'settings.section')
        register()
      },
      register(spec, component) {
        section = { spec, component }
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  assert.ok(section)
  assert.equal(section.spec.name, 'settings.section')
  assert.equal(section.spec.id, 'baobaohui-bridge')
  assert.equal(typeof section.spec.label(), 'string')
  assert.equal(typeof section.component, 'function')
})
