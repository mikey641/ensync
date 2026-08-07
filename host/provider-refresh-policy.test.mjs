import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROVIDER_REFRESH_HIDDEN_INTERVAL_MS,
  PROVIDER_REFRESH_INTERVAL_MS,
  PROVIDER_REFRESH_OFFLINE_BASE_MS,
  PROVIDER_REFRESH_OFFLINE_MAX_MS,
  nextProviderRefreshDelay,
} from '../src/lib/providerRefreshPolicy.mjs'

test('visible online windows poll the shared Host cache at a bounded interval', () => {
  assert.equal(nextProviderRefreshDelay({ visible: true, online: true }), PROVIDER_REFRESH_INTERVAL_MS)
})

test('hidden windows slow provider reads without inventing telemetry', () => {
  assert.equal(
    nextProviderRefreshDelay({ visible: false, online: true }),
    PROVIDER_REFRESH_HIDDEN_INTERVAL_MS,
  )
  assert.equal(
    nextProviderRefreshDelay({ visible: false, online: false, consecutiveFailures: 9 }),
    PROVIDER_REFRESH_HIDDEN_INTERVAL_MS,
  )
})

test('offline retries back off and remain capped', () => {
  assert.equal(
    nextProviderRefreshDelay({ visible: true, online: false, consecutiveFailures: 1 }),
    PROVIDER_REFRESH_OFFLINE_BASE_MS,
  )
  assert.equal(
    nextProviderRefreshDelay({ visible: true, online: false, consecutiveFailures: 2 }),
    PROVIDER_REFRESH_OFFLINE_BASE_MS * 2,
  )
  assert.equal(
    nextProviderRefreshDelay({ visible: true, online: false, consecutiveFailures: 99 }),
    PROVIDER_REFRESH_OFFLINE_MAX_MS,
  )
})
