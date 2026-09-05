import assert from 'node:assert/strict'
import test from 'node:test'
import {
  providerRunnerIds,
  supportsAnyProviderRunner,
  supportsProviderRunner,
} from './provider-runner-contract.mjs'
import { getProviderCatalog } from './providers.mjs'

test('every enabled local provider has a tested runner without coordination metadata', () => {
  const catalog = getProviderCatalog()
  const supported = catalog
    .filter((provider) => provider.chatExecution === 'supported')
    .map((provider) => provider.id)
    .sort()

  assert.deepEqual([...providerRunnerIds('local')].sort(), supported)
  for (const providerId of supported) {
    assert.equal(supportsProviderRunner(providerId, 'local'), true)
  }
  for (const provider of catalog) {
    assert.equal(supportsAnyProviderRunner(provider.id), provider.chatExecution === 'supported')
  }
})

// Droid and Cursor do not have contained SSH runners yet. This holds the
// parity requirement without claiming an unsafe remote path exists.
test('ssh runner parity with the provider catalog', { skip: 'Droid and Cursor need contained SSH runners' }, () => {
  const supported = getProviderCatalog()
    .filter((provider) => provider.chatExecution === 'supported')
    .map((provider) => provider.id)
    .sort()
  assert.deepEqual([...providerRunnerIds('ssh')].sort(), supported)
})

test('discovery-only providers cannot be presented as runnable', () => {
  const discoveryOnly = getProviderCatalog().filter((provider) => provider.chatExecution === 'discovery_only')
  for (const provider of discoveryOnly) {
    assert.equal(supportsProviderRunner(provider.id, 'local'), false)
    assert.equal(supportsProviderRunner(provider.id, 'ssh'), false)
  }
})

test('every provider has an explicit automatic-landing resolution capability', () => {
  const catalog = getProviderCatalog()
  const resolvers = []
  for (const provider of catalog) {
    assert.ok(provider.landingResolution)
    assert.ok(['supported', 'discovery_only', 'unavailable'].includes(provider.landingResolution.state))
    assert.equal(typeof provider.landingResolution.reason, 'string')
    if (provider.landingResolution.state === 'supported') {
      resolvers.push(provider.id)
      assert.equal(provider.chatExecution, 'supported')
      assert.equal(provider.landingResolution.modelPolicy, 'provider_default')
      assert.equal(provider.landingResolution.model, null)
      assert.equal(provider.landingResolution.effort, 'max')
    } else {
      assert.notEqual(provider.chatExecution, 'supported')
      assert.equal(provider.landingResolution.modelPolicy, null)
      assert.equal(provider.landingResolution.effort, null)
    }
  }
  assert.deepEqual(resolvers.sort(), ['claude', 'codex', 'droid'])
})
