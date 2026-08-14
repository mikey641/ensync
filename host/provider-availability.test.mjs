import assert from 'node:assert/strict'
import test from 'node:test'
import { availabilityRank, rankProvidersByAvailability } from './provider-availability.mjs'

function provider(id, overrides = {}) {
  const { usedPercent = null, ...rest } = overrides
  return {
    id,
    connectionState: 'ready',
    chatExecution: 'supported',
    installed: true,
    usage: {
      kind: 'subscription_quota',
      source: usedPercent === null ? 'unavailable' : 'cli',
      usedPercent,
      remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    },
    ...rest,
  }
}

const order = ['droid', 'codex', 'claude', 'copilot', 'cursor', 'ollama']

test('verified remaining capacity ranks runners ahead of exhausted and unknown ones', () => {
  const ranked = rankProvidersByAvailability(
    [
      provider('codex', { usedPercent: 100 }),
      provider('claude', { usedPercent: 71 }),
      provider('droid', { usedPercent: 15 }),
    ],
    order,
  )
  assert.deepEqual(ranked.map((entry) => entry.id), ['droid', 'claude', 'codex'])
})

test('an exhausted runner still outranks discovery-only and disconnected providers', () => {
  const ranked = rankProvidersByAvailability(
    [
      provider('cursor', { connectionState: 'unavailable', installed: false, chatExecution: 'discovery_only' }),
      provider('copilot', { chatExecution: 'discovery_only' }),
      provider('codex', { usedPercent: 100 }),
    ],
    order,
  )
  assert.deepEqual(ranked.map((entry) => entry.id), ['codex', 'copilot', 'cursor'])
})

test('a runner with unverified usage sits between proven capacity and proven exhaustion', () => {
  const ranked = rankProvidersByAvailability(
    [
      provider('codex', { usedPercent: 100 }),
      provider('claude'),
      provider('droid', { usedPercent: 15 }),
    ],
    order,
  )
  assert.deepEqual(ranked.map((entry) => entry.id), ['droid', 'claude', 'codex'])
})

test('the local runtime stays last even when it is ready', () => {
  const ranked = rankProvidersByAvailability(
    [
      provider('ollama', { chatExecution: 'discovery_only', usage: { kind: 'local_runtime', usedPercent: null } }),
      provider('cursor', { connectionState: 'unavailable', installed: false, chatExecution: 'discovery_only' }),
      provider('droid', { usedPercent: 15 }),
    ],
    order,
  )
  assert.deepEqual(ranked.map((entry) => entry.id), ['droid', 'cursor', 'ollama'])
})

test('equal remaining capacity falls back to the navigation order, not probe order', () => {
  const ranked = rankProvidersByAvailability(
    [
      provider('claude', { usedPercent: 20 }),
      provider('codex', { usedPercent: 20 }),
      provider('droid', { usedPercent: 20 }),
    ],
    order,
  )
  assert.deepEqual(ranked.map((entry) => entry.id), ['droid', 'codex', 'claude'])
})

test('an installed provider awaiting login outranks one that is not installed', () => {
  const ranked = rankProvidersByAvailability(
    [
      provider('cursor', { connectionState: 'unavailable', installed: false, chatExecution: 'discovery_only' }),
      provider('copilot', { connectionState: 'needs_authentication', chatExecution: 'discovery_only' }),
    ],
    order,
  )
  assert.deepEqual(ranked.map((entry) => entry.id), ['copilot', 'cursor'])
})

test('ranking never invents capacity from an unverified usage source', () => {
  const guessed = provider('droid', { usedPercent: 15 })
  guessed.usage.source = 'unavailable'
  assert.equal(availabilityRank(guessed), availabilityRank(provider('droid')))
})

test('ranking tolerates minimal provider records without throwing', () => {
  const ranked = rankProvidersByAvailability([{ id: 'codex' }, { id: 'droid' }], order)
  assert.deepEqual(ranked.map((entry) => entry.id), ['droid', 'codex'])
})

test('ranking returns a new array and leaves the input untouched', () => {
  const input = [provider('codex', { usedPercent: 100 }), provider('droid', { usedPercent: 15 })]
  const ranked = rankProvidersByAvailability(input, order)
  assert.notEqual(ranked, input)
  assert.deepEqual(input.map((entry) => entry.id), ['codex', 'droid'])
})
