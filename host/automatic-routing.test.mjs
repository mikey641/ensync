import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_FALLBACK_PROVIDER_ORDER,
  normalizeFallbackProviderOrder,
  orderedAutomaticProviders,
  selectAutomaticProvider,
} from '../src/lib/automaticRouting.mjs'

function provider(id, options = {}) {
  return {
    id,
    connected: true,
    chatExecution: 'supported',
    usage: 20,
    ...options,
  }
}

test('fallback priority is normalized independently from catalog order', () => {
  assert.deepEqual(DEFAULT_FALLBACK_PROVIDER_ORDER, ['codex', 'claude'])
  assert.deepEqual(normalizeFallbackProviderOrder(['claude', 'claude', 'copilot']), ['claude', 'codex'])
  assert.deepEqual(
    orderedAutomaticProviders([provider('claude'), provider('codex')], ['codex', 'claude']).map(({ id }) => id),
    ['codex', 'claude'],
  )
})

test('ranking wins when multiple providers have verified available usage', () => {
  const providers = [
    provider('claude', { usage: 5 }),
    provider('codex', { usage: 68 }),
  ]
  assert.equal(selectAutomaticProvider(providers, ['codex', 'claude'])?.id, 'codex')
})

test('disconnected, unsupported, and verified exhausted providers are skipped', () => {
  const providers = [
    provider('codex', { usage: 100 }),
    provider('claude', { usage: 42 }),
    provider('copilot', { usage: 0, chatExecution: 'discovery_only' }),
  ]
  assert.equal(selectAutomaticProvider(providers, ['codex', 'copilot', 'claude'])?.id, 'claude')
  assert.equal(selectAutomaticProvider([
    provider('codex', { connected: false, usage: 1 }),
    provider('claude', { usage: 42 }),
  ], ['codex', 'claude'])?.id, 'claude')
})

test('unknown usage is a last resort and remains ranked within unknown candidates', () => {
  assert.equal(selectAutomaticProvider([
    provider('codex', { usage: null }),
    provider('claude', { usage: 90 }),
  ], ['codex', 'claude'])?.id, 'claude')
  assert.equal(selectAutomaticProvider([
    provider('codex', { usage: null }),
    provider('claude', { usage: null }),
  ], ['claude', 'codex'])?.id, 'claude')
  assert.equal(selectAutomaticProvider([
    provider('codex', { usage: 100 }),
    provider('claude', { usage: null }),
  ], ['codex', 'claude'])?.id, 'claude')
  assert.equal(selectAutomaticProvider([
    provider('codex', { usage: -1 }),
    provider('claude', { usage: 30 }),
  ], ['codex', 'claude'])?.id, 'claude')
})

test('safe fallback uses the same priority and never repeats an attempted provider', () => {
  const providers = [provider('claude', { usage: 10 }), provider('codex', { usage: 60 })]
  const first = selectAutomaticProvider(providers, ['codex', 'claude'])
  const fallback = selectAutomaticProvider(providers, ['codex', 'claude'], [first.id])
  assert.equal(first.id, 'codex')
  assert.equal(fallback?.id, 'claude')
  assert.equal(selectAutomaticProvider(providers, ['codex', 'claude'], ['codex', 'claude']), null)
})
