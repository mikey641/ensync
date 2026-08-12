import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { RepositoryLandLeaseError, withRepositoryLandLease } from './repository-land-lease.mjs'

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-land-lease-test-'))
  const commonGitDirectory = join(root, '.git')
  await mkdir(commonGitDirectory, { recursive: true })
  context.after(() => rm(root, { recursive: true, force: true }))
  return { root, commonGitDirectory }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('repository land callbacks serialize and a waiter reports once', async (context) => {
  const f = await fixture(context)
  const firstEntered = deferred()
  const releaseFirst = deferred()
  const order = []
  let active = 0
  let maximumActive = 0
  let waits = 0
  const first = withRepositoryLandLease(f.commonGitDirectory, async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    order.push('first-start')
    firstEntered.resolve()
    await releaseFirst.promise
    order.push('first-end')
    active -= 1
    return 'first'
  }, { pollMs: 5, heartbeatMs: 10 })
  await firstEntered.promise
  const second = withRepositoryLandLease(f.commonGitDirectory, async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    order.push('second')
    active -= 1
    return 'second'
  }, { pollMs: 5, heartbeatMs: 10, onWait: () => { waits += 1 } })
  await new Promise((resolve) => setTimeout(resolve, 25))
  releaseFirst.resolve()

  assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])
  assert.equal(maximumActive, 1)
  assert.equal(waits, 1)
  assert.deepEqual(order, ['first-start', 'first-end', 'second'])
})

test('a cancelled waiter never enters or steals the repository lease', async (context) => {
  const f = await fixture(context)
  const firstEntered = deferred()
  const releaseFirst = deferred()
  const controller = new AbortController()
  const first = withRepositoryLandLease(f.commonGitDirectory, async () => {
    firstEntered.resolve()
    await releaseFirst.promise
  }, { pollMs: 5, heartbeatMs: 10 })
  await firstEntered.promise
  let entered = false
  const second = withRepositoryLandLease(f.commonGitDirectory, async () => {
    entered = true
  }, { pollMs: 5, heartbeatMs: 10, signal: controller.signal })
  controller.abort()

  await assert.rejects(second, (error) => error instanceof RepositoryLandLeaseError
    && error.code === 'repository_land_cancelled')
  assert.equal(entered, false)
  releaseFirst.resolve()
  await first
})

test('a stale dead owner is quarantined before acquisition', async (context) => {
  const f = await fixture(context)
  const lockPath = join(f.commonGitDirectory, 'ensync', 'repository-land.lock')
  await mkdir(lockPath, { recursive: true })
  await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
    schemaVersion: 1,
    token: 'abandoned-owner',
    pid: 999_999_999,
    updatedAt: '2020-01-01T00:00:00.000Z',
  }))
  let entered = false

  await withRepositoryLandLease(f.commonGitDirectory, async () => {
    entered = true
  }, { pollMs: 5, heartbeatMs: 10, staleMs: 20 })

  assert.equal(entered, true)
  await assert.rejects(readFile(join(lockPath, 'owner.json'), 'utf8'), (error) => error?.code === 'ENOENT')
})

test('callback failure releases the lease for the next land', async (context) => {
  const f = await fixture(context)
  await assert.rejects(
    withRepositoryLandLease(f.commonGitDirectory, async () => { throw new Error('land check failed') }),
    /land check failed/,
  )
  assert.equal(await withRepositoryLandLease(f.commonGitDirectory, async () => 'recovered'), 'recovered')
})
