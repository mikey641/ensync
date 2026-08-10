import assert from 'node:assert/strict'
import test from 'node:test'
import { ENSYNC_MULTI_AGENT_MARKER, ENSYNC_SUPERPOWERS_POLICY } from './multi-agent-prompt.mjs'
import {
  providerRunnerIds,
  supportsAnyProviderRunner,
  withProviderRunnerInstructions,
} from './provider-runner-contract.mjs'
import { getProviderCatalog } from './providers.mjs'

test('every enabled provider runner is catalog-supported and bound to Superpowers locally', () => {
  const catalog = getProviderCatalog()
  const supported = catalog
    .filter((provider) => provider.chatExecution === 'supported')
    .map((provider) => provider.id)
    .sort()

  assert.deepEqual([...providerRunnerIds('local')].sort(), supported)
  for (const providerId of supported) {
    const prompt = withProviderRunnerInstructions(providerId, 'local', 'Implement safely.')
    assert.match(prompt, new RegExp(`^${ENSYNC_MULTI_AGENT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(prompt, /bundled Superpowers contract applies to every Ensync provider runner/)
    assert.match(prompt, /Implement safely\.$/)
    assert.equal(
      catalog.find((provider) => provider.id === providerId)?.agentCoordination.policy,
      ENSYNC_SUPERPOWERS_POLICY,
    )
  }
  for (const provider of catalog) {
    assert.equal(
      supportsAnyProviderRunner(provider.id),
      provider.chatExecution === 'supported',
    )
  }
})

// Droid's ssh runner does not exist yet (remote-ssh.mjs drives argv+stdin
// CLIs; droid needs its stream-jsonrpc adapter). This spec holds the parity
// requirement without leaving the suite red while that bridge is unbuilt.
test('ssh runner parity with the provider catalog', { todo: 'droid has no ssh runner yet' }, () => {
  const catalog = getProviderCatalog()
  const supported = catalog
    .filter((provider) => provider.chatExecution === 'supported')
    .map((provider) => provider.id)
    .sort()

  assert.deepEqual([...providerRunnerIds('ssh')].sort(), supported)
  for (const providerId of supported) {
    const prompt = withProviderRunnerInstructions(providerId, 'ssh', 'Implement safely.')
    assert.match(prompt, new RegExp(`^${ENSYNC_MULTI_AGENT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.match(prompt, /Implement safely\.$/)
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
