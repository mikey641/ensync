import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chatRunPreferences,
  effortForModelSize,
  sizeForModelEffort,
} from '../src/lib/chatPreferences.mjs'

test('fixed provider, model size, and fallback are independent run preferences', () => {
  assert.deepEqual(
    chatRunPreferences({ providerMode: 'fixed', sizeTier: 'xl' }, false),
    {
      automaticProvider: false,
      fallbackEnabled: false,
      requestedEffort: 'max',
    },
  )
  assert.deepEqual(
    chatRunPreferences({ providerMode: 'fixed', sizeTier: 'small' }, true),
    {
      automaticProvider: false,
      fallbackEnabled: true,
      requestedEffort: 'low',
    },
  )
})

test('Auto provider remains independent from model size and fallback', () => {
  assert.deepEqual(
    chatRunPreferences({ providerMode: 'auto', sizeTier: 'large' }, false),
    {
      automaticProvider: true,
      fallbackEnabled: false,
      requestedEffort: 'high',
    },
  )
})

test('friendly model sizes map only to supported provider effort levels', () => {
  assert.equal(effortForModelSize(null), null)
  assert.equal(effortForModelSize('medium'), 'medium')
  assert.equal(effortForModelSize('invalid'), null)
  assert.equal(sizeForModelEffort('max'), 'xl')
  assert.equal(sizeForModelEffort(null), null)
})
