import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DaemonLeaseError,
  DaemonLeaseService,
  shouldKeepDaemonAlive,
} from './daemon-lifecycle.mjs'
import { createEnsyncHost } from './server.mjs'

const TOKEN = 'a'.repeat(64)
const OWNER = 'shell_1111111111111111'

test('daemon leases expire and cannot be revived without a new claim', () => {
  let now = 1_000
  const leases = new DaemonLeaseService({ now: () => now, leaseMs: 100 })
  leases.claim(OWNER)
  assert.equal(leases.has(OWNER), true)
  now = 1_101
  assert.equal(leases.has(OWNER), false)
  assert.throws(
    () => leases.heartbeat(OWNER),
    (error) => error instanceof DaemonLeaseError && error.code === 'daemon_owner_expired',
  )
})

test('an active provider job keeps the detached Host alive after every app lease is gone', () => {
  const leases = new DaemonLeaseService()
  leases.claim(OWNER)
  leases.release(OWNER)

  assert.equal(leases.activeCount(), 0)
  assert.equal(shouldKeepDaemonAlive(leases.activeCount(), true), true)
  assert.equal(shouldKeepDaemonAlive(leases.activeCount(), false), false)
})

test('a daemon Host requires both its bearer token and a live native-shell lease', async (context) => {
  const leases = new DaemonLeaseService()
  const server = createEnsyncHost({
    authToken: TOKEN,
    daemonLeaseService: leases,
    statusService: { list: async () => [] },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 401)
  assert.equal((await fetch(`${baseUrl}/api/providers`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).status, 403)
  const claim = await fetch(`${baseUrl}/api/daemon/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId: OWNER }),
  })
  assert.equal(claim.status, 200)
  const providers = await fetch(`${baseUrl}/api/providers`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Ensync-Owner': OWNER },
  })
  assert.equal(providers.status, 200)
})
