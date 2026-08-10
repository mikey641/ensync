import assert from 'node:assert/strict'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import {
  DaemonLeaseError,
  DaemonLeaseService,
  hostSourceStamp,
  shouldKeepDaemonAlive,
  shouldRetireForStaleSource,
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

function fakeHostSource(files) {
  return {
    readdir: async () => Object.keys(files),
    stat: async (path) => {
      const entry = files[basename(path)]
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return entry
    },
  }
}

const BUNDLE = {
  'server.mjs': { size: 100, mtimeMs: 1_000 },
  'daemon-lifecycle.mjs': { size: 50, mtimeMs: 2_000 },
}

test('the host source stamp is stable for unchanged files and blind to directory order', async () => {
  const stamp = await hostSourceStamp('/bundle', fakeHostSource(BUNDLE))
  assert.match(stamp, /^[0-9a-f]{64}$/)
  assert.equal(await hostSourceStamp('/bundle', fakeHostSource(BUNDLE)), stamp)
  assert.equal(await hostSourceStamp('/bundle', {
    readdir: async () => Object.keys(BUNDLE).reverse(),
    stat: fakeHostSource(BUNDLE).stat,
  }), stamp)
})

test('re-shipping a host module changes the stamp even when the file size is identical', async () => {
  const stamp = await hostSourceStamp('/bundle', fakeHostSource(BUNDLE))
  const retouched = await hostSourceStamp('/bundle', fakeHostSource({
    ...BUNDLE,
    'server.mjs': { size: 100, mtimeMs: 9_999 },
  }))
  const resized = await hostSourceStamp('/bundle', fakeHostSource({
    ...BUNDLE,
    'server.mjs': { size: 101, mtimeMs: 1_000 },
  }))
  const added = await hostSourceStamp('/bundle', fakeHostSource({
    ...BUNDLE,
    'chat.mjs': { size: 7, mtimeMs: 1_000 },
  }))
  assert.notEqual(retouched, stamp)
  assert.notEqual(resized, stamp)
  assert.notEqual(added, stamp)
})

test('the stamp covers shipped modules only, ignoring tests and non-module files', async () => {
  const stamp = await hostSourceStamp('/bundle', fakeHostSource(BUNDLE))
  assert.equal(await hostSourceStamp('/bundle', fakeHostSource({
    ...BUNDLE,
    'server.test.mjs': { size: 4_000, mtimeMs: 8_000 },
    'provider-runner-contract.d.mts': { size: 12, mtimeMs: 8_000 },
    'README.md': { size: 30, mtimeMs: 8_000 },
  })), stamp)
})

test('an unreadable host directory stamps as unknown instead of throwing', async () => {
  const failures = [
    { readdir: async () => { throw new Error('EACCES') }, stat: async () => BUNDLE['server.mjs'] },
    { readdir: async () => Object.keys(BUNDLE), stat: async () => { throw new Error('ENOENT') } },
    { readdir: async () => null, stat: async () => BUNDLE['server.mjs'] },
    { readdir: async () => [], stat: async () => BUNDLE['server.mjs'] },
    { readdir: async () => ['server.mjs'], stat: async () => ({ size: Number.NaN, mtimeMs: 1 }) },
    { readdir: async () => ['server.mjs'], stat: async () => ({ size: 1 }) },
    { readdir: async () => ['README.md'], stat: async () => BUNDLE['server.mjs'] },
  ]
  for (const options of failures) {
    assert.equal(await hostSourceStamp('/bundle', options), null)
  }
  assert.equal(await hostSourceStamp('', fakeHostSource(BUNDLE)), null)
  assert.equal(await hostSourceStamp(undefined, fakeHostSource(BUNDLE)), null)
})

test('a real host directory stamps from disk and follows a re-shipped file', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-host-stamp-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'server.mjs'), 'export const build = 1\n')
  await writeFile(join(directory, 'server.test.mjs'), 'test only\n')

  const before = await hostSourceStamp(directory)
  assert.match(before, /^[0-9a-f]{64}$/)
  assert.equal(await hostSourceStamp(directory), before)

  await writeFile(join(directory, 'server.mjs'), 'export const build = 2\n')
  await utimes(join(directory, 'server.mjs'), new Date(), new Date(Date.now() + 5_000))
  assert.notEqual(await hostSourceStamp(directory), before)
})

test('a daemon retires only when its own source changed and no work is left', () => {
  assert.equal(shouldRetireForStaleSource('old', 'new', false), true)

  // Same code: nothing to retire for.
  assert.equal(shouldRetireForStaleSource('same', 'same', false), false)
  // Running work always outranks a stale bundle.
  assert.equal(shouldRetireForStaleSource('old', 'new', true), false)
  // An unknown stamp on either side must never be read as a change.
  assert.equal(shouldRetireForStaleSource(null, 'new', false), false)
  assert.equal(shouldRetireForStaleSource('old', null, false), false)
  assert.equal(shouldRetireForStaleSource(null, null, false), false)
  assert.equal(shouldRetireForStaleSource('', 'new', false), false)
  assert.equal(shouldRetireForStaleSource('old', '', false), false)
  // Only an explicit "not busy" authorizes retiring.
  for (const keepAlive of [undefined, null, 0, '', 'no']) {
    assert.equal(shouldRetireForStaleSource('old', 'new', keepAlive), false)
  }
})

test('the idle watchdog retires a stale daemon and spares a busy one', async () => {
  const leases = new DaemonLeaseService()
  const keepAlive = (hasRunningJobs) => shouldKeepDaemonAlive(leases.activeCount(), hasRunningJobs)

  const loaded = await hostSourceStamp('/bundle', fakeHostSource(BUNDLE))
  const shipped = await hostSourceStamp('/bundle', fakeHostSource({
    ...BUNDLE,
    'server.mjs': { size: 100, mtimeMs: 3_000 },
  }))

  assert.equal(shouldRetireForStaleSource(loaded, shipped, keepAlive(true)), false)
  assert.equal(shouldRetireForStaleSource(loaded, shipped, keepAlive(false)), true)

  leases.claim(OWNER)
  assert.equal(shouldRetireForStaleSource(loaded, shipped, keepAlive(false)), false)
})
