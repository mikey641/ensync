import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCodexAppServerProbe } from './codex-app-server.mjs'

test('Codex app-server parser keeps exact quota data and the real model catalog', () => {
  const result = parseCodexAppServerProbe({
    1: { result: { account: { type: 'chatgpt', planType: 'pro' } } },
    2: {
      result: {
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 71, windowDurationMins: 10_080, resetsAt: 1_800_086_400 },
            credits: { hasCredits: false, unlimited: false, balance: '0' },
          },
          codex_fast: {
            limitId: 'codex_fast',
            limitName: 'GPT Fast',
            primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
          },
        },
      },
    },
    3: {
      result: {
        data: [
          { id: 'gpt-default', model: 'gpt-default', displayName: 'GPT Default', isDefault: true, hidden: false },
          { id: 'gpt-fast', model: 'gpt-fast', displayName: 'GPT Fast', isDefault: false, hidden: false },
          { id: 'hidden', model: 'hidden', hidden: true },
        ],
      },
    },
  }, '2026-08-06T09:00:00.000Z')

  assert.equal(result.usage.usedPercent, 71)
  assert.equal(result.usage.kind, 'subscription_quota')
  assert.equal(result.usage.remainingPercent, 29)
  assert.equal(result.usage.resetAt, new Date(1_800_086_400_000).toISOString())
  assert.equal(result.usage.resetWindow, 'Weekly')
  assert.equal(result.usage.plan, 'pro')
  assert.equal(result.usage.model, 'gpt-default')
  assert.deepEqual(result.usage.details, [
    { label: 'Quota type', value: 'Subscription quota' },
    { label: 'Current window', value: 'Weekly' },
    { label: 'Remaining', value: '29%' },
    { label: 'Used', value: '71%' },
    { label: 'GPT Fast · Weekly', value: '100% remaining · 0% used' },
    { label: 'Credits', value: '0' },
  ])
  assert.deepEqual(result.models.map((model) => model.id), ['gpt-default', 'gpt-fast'])
})

test('Codex app-server parser falls back to the canonical rateLimits bucket', () => {
  const result = parseCodexAppServerProbe({
    2: {
      result: {
        rateLimits: {
          limitId: 'codex',
          planType: 'plus',
          primary: { usedPercent: 32, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
          credits: { hasCredits: false, unlimited: false, balance: '0' },
        },
      },
    },
  })

  assert.equal(result.usage.usedPercent, 32)
  assert.equal(result.usage.remainingPercent, 68)
  assert.equal(result.usage.resetWindow, 'Weekly')
  assert.deepEqual(result.usage.details, [
    { label: 'Quota type', value: 'Subscription quota' },
    { label: 'Current window', value: 'Weekly' },
    { label: 'Remaining', value: '68%' },
    { label: 'Used', value: '32%' },
    { label: 'Credits', value: '0' },
  ])
})

test('Codex app-server parser does not manufacture missing usage or models', () => {
  assert.equal(parseCodexAppServerProbe({ 1: { result: { account: null } } }), null)
})
