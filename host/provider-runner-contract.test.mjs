import assert from 'node:assert/strict'
import test from 'node:test'
import { ENSYNC_MULTI_AGENT_MARKER, ENSYNC_SUPERPOWERS_POLICY } from './multi-agent-prompt.mjs'
import {
  providerRunnerIds,
  supportsAnyProviderRunner,
  withProviderRunnerInstructions,
} from './provider-runner-contract.mjs'
import { getProviderCatalog } from './providers.mjs'

test('every enabled provider runner is catalog-supported and bound to Superpowers on every topology', () => {
  const catalog = getProviderCatalog()
  const supported = catalog
    .filter((provider) => provider.chatExecution === 'supported')
    .map((provider) => provider.id)
    .sort()

  for (const topology of ['local', 'ssh']) {
    assert.deepEqual([...providerRunnerIds(topology)].sort(), supported)
    for (const providerId of supported) {
      const prompt = withProviderRunnerInstructions(providerId, topology, 'Implement safely.')
      assert.match(prompt, new RegExp(`^${ENSYNC_MULTI_AGENT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
      assert.match(prompt, /bundled Superpowers contract applies to every Ensync provider runner/)
      assert.match(prompt, /Implement safely\.$/)
      assert.equal(
        catalog.find((provider) => provider.id === providerId)?.agentCoordination.policy,
        ENSYNC_SUPERPOWERS_POLICY,
      )
    }
  }
  for (const provider of catalog) {
    assert.equal(
      supportsAnyProviderRunner(provider.id),
      provider.chatExecution === 'supported',
    )
  }
})

test('discovery-only providers cannot be presented as policy-enabled runners', () => {
  const discoveryOnly = getProviderCatalog().filter((provider) => provider.chatExecution === 'discovery_only')

  for (const provider of discoveryOnly) {
    assert.throws(
      () => withProviderRunnerInstructions(provider.id, 'local', 'Do not run.'),
      /does not have a tested local runner/,
    )
    assert.throws(
      () => withProviderRunnerInstructions(provider.id, 'ssh', 'Do not run.'),
      /does not have a tested ssh runner/,
    )
  }
})
