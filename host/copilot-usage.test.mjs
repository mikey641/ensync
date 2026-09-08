import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCopilotQuota } from './copilot-usage.mjs'

const CHECKED_AT = '2026-09-07T00:00:00.000Z'
const LIVE_QUOTA = {
  quotaSnapshots: {
    chat: {
      isUnlimitedEntitlement: false,
      entitlementRequests: 200,
      usedRequests: 2,
      usageAllowedWithExhaustedQuota: false,
      overage: 0,
      overageAllowedWithExhaustedQuota: false,
      remainingPercentage: 98.9,
      resetDate: '2026-09-06T18:23:31.172-07:00',
      hasQuota: true,
      tokenBasedBilling: true,
    },
    completions: {
      remainingPercentage: 100,
    },
    premium_interactions: {
      remainingPercentage: 0,
      hasQuota: false,
    },
  },
}

test('parseCopilotQuota surfaces the chat agent-credit snapshot as the quota percentage', () => {
  const usage = parseCopilotQuota(LIVE_QUOTA, CHECKED_AT)

  assert.equal(usage.kind, 'subscription_quota')
  assert.equal(usage.source, 'cli')
  assert.equal(usage.usedPercent, 1.1)
  assert.equal(usage.remainingPercent, 98.9)
  assert.equal(usage.resetAt, null)
  assert.deepEqual(usage.details, [
    { label: 'Quota type', value: 'Copilot agent credits (chat)' },
    { label: 'Remaining', value: '98.9%' },
    { label: 'Used', value: '2 of 200' },
  ])
})

test('parseCopilotQuota reports an unlimited entitlement verbatim', () => {
  const usage = parseCopilotQuota({
    quotaSnapshots: {
      chat: {
        isUnlimitedEntitlement: true,
        entitlementRequests: -1,
        usedRequests: 12,
        remainingPercentage: 100,
      },
    },
  }, CHECKED_AT)

  assert.equal(usage.usedPercent, 0)
  assert.deepEqual(usage.details, [
    { label: 'Quota type', value: 'Copilot agent credits (chat)' },
    { label: 'Remaining', value: '100%' },
    { label: 'Used', value: 'Unlimited entitlement' },
  ])
})

test('parseCopilotQuota flags usage that may continue past the allowance', () => {
  const usage = parseCopilotQuota({
    quotaSnapshots: {
      chat: {
        remainingPercentage: 0,
        usageAllowedWithExhaustedQuota: true,
        overageAllowedWithExhaustedQuota: false,
        entitlementRequests: 200,
        usedRequests: 200,
      },
    },
  }, CHECKED_AT)

  assert.equal(usage.usedPercent, 100)
  assert.deepEqual(usage.details.at(-1), { label: 'Overage', value: 'Usage may continue past the allowance' })
})

test('parseCopilotQuota refuses missing, empty, or malformed snapshots', () => {
  assert.equal(parseCopilotQuota(null, CHECKED_AT), null)
  assert.equal(parseCopilotQuota({}, CHECKED_AT), null)
  assert.equal(parseCopilotQuota({ quotaSnapshots: {} }, CHECKED_AT), null)
  assert.equal(parseCopilotQuota({ quotaSnapshots: { chat: { remainingPercentage: 150 } } }, CHECKED_AT), null)
  assert.equal(parseCopilotQuota({ quotaSnapshots: { chat: { remainingPercentage: -1 } } }, CHECKED_AT), null)
})
