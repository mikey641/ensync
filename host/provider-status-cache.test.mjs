import assert from 'node:assert/strict'
import test from 'node:test'
import { ProviderStatusService } from './providers.mjs'

function status(provider, generation) {
  return { id: provider.id, generation }
}

test('provider status service coalesces simultaneous reads and serves its shared cache', async () => {
  let calls = 0
  const service = new ProviderStatusService({
    definitions: [{ id: 'codex' }],
    cacheDurationMs: 60_000,
    inspectProvider: async (provider) => status(provider, ++calls),
  })

  const [first, second, third] = await Promise.all([
    service.list(),
    service.list(),
    service.list(),
  ])

  assert.equal(calls, 1)
  assert.deepEqual(first, [{ id: 'codex', generation: 1 }])
  assert.deepEqual(second, first)
  assert.deepEqual(third, first)
  assert.deepEqual(await service.list(), first)
  assert.equal(calls, 1)
})

test('manual force bypasses a valid cache but still shares an active probe', async () => {
  let calls = 0
  const service = new ProviderStatusService({
    definitions: [{ id: 'codex' }],
    cacheDurationMs: 60_000,
    inspectProvider: async (provider) => status(provider, ++calls),
  })

  await service.list()
  const [forced, coalesced] = await Promise.all([
    service.list({ refresh: true }),
    service.list(),
  ])

  assert.equal(calls, 2)
  assert.deepEqual(forced, [{ id: 'codex', generation: 2 }])
  assert.deepEqual(coalesced, forced)
})

function verified(usedPercent, checkedAt = '2026-08-10T18:00:00.000Z') {
  return {
    id: 'claude',
    installed: true,
    authentication: { state: 'authenticated' },
    usage: {
      availability: 'partial',
      source: 'cli',
      kind: 'subscription_quota',
      plan: 'max',
      model: null,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetAt: null,
      resetLabel: 'Aug 16 at 1am (Asia/Jerusalem)',
      resetWindow: 'Week (all models)',
      checkedAt,
      details: [{ label: 'Week (all models)', value: `${usedPercent}% used` }],
      reason: `Claude Code /usage reported exact ${usedPercent}% usage.`,
    },
  }
}

function blanked(overrides = {}) {
  return {
    id: 'claude',
    installed: true,
    authentication: { state: 'authenticated' },
    ...overrides,
    usage: {
      availability: 'unavailable',
      source: 'unavailable',
      kind: 'subscription_quota',
      plan: null,
      model: null,
      usedPercent: null,
      remainingPercent: null,
      resetAt: null,
      checkedAt: '2026-08-10T18:01:00.000Z',
      details: [],
      reason: 'No verified non-consuming quota probe.',
      ...(overrides.usage ?? {}),
    },
  }
}

test('a failed probe keeps the last verified percentage instead of blanking the card', async () => {
  const readings = [verified(74), blanked(), blanked()]
  let call = 0
  const service = new ProviderStatusService({
    definitions: [{ id: 'claude' }],
    cacheDurationMs: 0,
    inspectProvider: async () => readings[call++],
  })

  const [first] = await service.list({ refresh: true })
  assert.equal(first.usage.usedPercent, 74)
  assert.notEqual(first.usage.stale, true)

  const [second] = await service.list({ refresh: true })
  assert.equal(second.usage.usedPercent, 74, 'a killed probe must not erase a verified reading')
  assert.equal(second.usage.stale, true)
  assert.equal(second.usage.source, 'cli')
  assert.equal(second.usage.checkedAt, '2026-08-10T18:00:00.000Z', 'the retained reading keeps its own measurement time')
  assert.match(second.usage.reason, /last verified/i)

  const [third] = await service.list({ refresh: true })
  assert.equal(third.usage.usedPercent, 74)
})

test('a fresh verified reading replaces the retained one', async () => {
  const readings = [verified(74), blanked(), verified(81, '2026-08-10T18:02:00.000Z'), blanked()]
  let call = 0
  const service = new ProviderStatusService({
    definitions: [{ id: 'claude' }],
    cacheDurationMs: 0,
    inspectProvider: async () => readings[call++],
  })

  await service.list({ refresh: true })
  await service.list({ refresh: true })
  const [fresh] = await service.list({ refresh: true })
  assert.equal(fresh.usage.usedPercent, 81)
  assert.notEqual(fresh.usage.stale, true)

  const [retained] = await service.list({ refresh: true })
  assert.equal(retained.usage.usedPercent, 81)
  assert.equal(retained.usage.checkedAt, '2026-08-10T18:02:00.000Z')
})

test('a retained percentage is dropped once it is older than the retention window', async () => {
  const readings = [verified(74), blanked()]
  let call = 0
  let clock = 1_000
  const service = new ProviderStatusService({
    definitions: [{ id: 'claude' }],
    cacheDurationMs: 0,
    verifiedUsageRetentionMs: 30_000,
    now: () => clock,
    inspectProvider: async () => readings[call++],
  })

  await service.list({ refresh: true })
  clock += 30_001
  const [aged] = await service.list({ refresh: true })
  assert.equal(aged.usage.usedPercent, null, 'a stale reading must expire rather than freeze forever')
  assert.equal(aged.usage.availability, 'unavailable')
})

test('a retained percentage is dropped when the provider stops being authenticated', async () => {
  const readings = [
    verified(74),
    blanked({ authentication: { state: 'not_authenticated' } }),
    blanked({ installed: false }),
  ]
  let call = 0
  const service = new ProviderStatusService({
    definitions: [{ id: 'claude' }],
    cacheDurationMs: 0,
    inspectProvider: async () => readings[call++],
  })

  await service.list({ refresh: true })
  const [loggedOut] = await service.list({ refresh: true })
  assert.equal(loggedOut.usage.usedPercent, null, 'a logged-out provider must not show an old quota')

  const [uninstalled] = await service.list({ refresh: true })
  assert.equal(uninstalled.usage.usedPercent, null)
})

test('an invalidation during a probe reruns once before publishing fresh status', async () => {
  let calls = 0
  let releaseFirst
  const firstProbe = new Promise((resolve) => { releaseFirst = resolve })
  const service = new ProviderStatusService({
    definitions: [{ id: 'codex' }],
    cacheDurationMs: 60_000,
    inspectProvider: async (provider) => {
      calls += 1
      if (calls === 1) await firstProbe
      return status(provider, calls)
    },
  })

  const originalRead = service.list()
  await Promise.resolve()
  service.invalidate()
  const readAfterRun = service.list()
  releaseFirst()

  const [original, refreshed] = await Promise.all([originalRead, readAfterRun])
  assert.equal(calls, 2)
  assert.deepEqual(original, [{ id: 'codex', generation: 2 }])
  assert.deepEqual(refreshed, original)
  assert.deepEqual(await service.list(), original)
})
