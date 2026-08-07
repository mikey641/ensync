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
