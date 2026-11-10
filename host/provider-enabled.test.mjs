import assert from 'node:assert/strict'
import test from 'node:test'

import { enabledProviderDefinitions, enabledProviderIds, isProviderEnabled, ProviderStatusService } from './providers.mjs'

test('unset ENSYNC_PROVIDERS keeps every provider', () => {
  assert.equal(enabledProviderIds({}), null)
  assert.ok(enabledProviderDefinitions({}).length > 1)
  assert.equal(isProviderEnabled('codex', {}), true)
})

test('ENSYNC_PROVIDERS=claude offers only Claude Code', () => {
  const env = { ENSYNC_PROVIDERS: 'claude' }
  assert.deepEqual([...enabledProviderIds(env)], ['claude'])
  assert.deepEqual(enabledProviderDefinitions(env).map((provider) => provider.id), ['claude'])
  assert.equal(isProviderEnabled('claude', env), true)
  assert.equal(isProviderEnabled('codex', env), false)
  assert.equal(isProviderEnabled('nope', env), false)
})

test('unknown names are ignored, and a list of only unknown names means all', () => {
  assert.deepEqual([...enabledProviderIds({ ENSYNC_PROVIDERS: 'claude, bogus' })], ['claude'])
  assert.equal(enabledProviderIds({ ENSYNC_PROVIDERS: 'bogus' }), null)
})

test('the status service never probes a disabled provider', async () => {
  const previous = process.env.ENSYNC_PROVIDERS
  process.env.ENSYNC_PROVIDERS = 'claude'
  try {
    const probed = []
    const service = new ProviderStatusService({
      inspectProvider: async (definition) => {
        probed.push(definition.id)
        return { id: definition.id, installed: false, authentication: { state: 'unknown' } }
      },
    })
    const providers = await service.list({ refresh: true })
    assert.deepEqual(probed, ['claude'])
    assert.deepEqual(providers.map((provider) => provider.id), ['claude'])
    assert.equal(await service.get('codex', { refresh: true }), null)
  } finally {
    if (previous === undefined) delete process.env.ENSYNC_PROVIDERS
    else process.env.ENSYNC_PROVIDERS = previous
  }
})
