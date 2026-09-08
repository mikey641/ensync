import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  mergeAllowedOrigins,
  resolveLocalSyncServiceOptions,
  startLocalSyncService,
} from '../src/local-sync-service.mjs'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = resolve(desktopRoot, '..')

test('local sync service resolves only when no explicit URL is configured', () => {
  assert.equal(resolveLocalSyncServiceOptions({
    isPackaged: false,
    resourcesPath: '/unused',
    repositoryRoot,
    env: { ENSYNC_SYNC_SERVICE_URL: 'https://sync.example.com' },
  }), null)

  const resolved = resolveLocalSyncServiceOptions({
    isPackaged: false,
    resourcesPath: '/unused',
    repositoryRoot,
    env: {},
  })
  assert.equal(resolved.entryPath, join(repositoryRoot, 'sync-service', 'server.mjs'))
  assert.equal(resolved.host, '127.0.0.1')
  assert.equal(resolved.port, '43122')
})

test('an explicit sync port overrides the stable default', () => {
  const resolved = resolveLocalSyncServiceOptions({
    isPackaged: false,
    resourcesPath: '/unused',
    repositoryRoot,
    env: { ENSYNC_SYNC_PORT: '51234' },
  })
  assert.equal(resolved.port, '51234')
})

test('the bundled service always allows the hosted phone PWA origin', () => {
  assert.equal(mergeAllowedOrigins(undefined), 'https://ensync.vercel.app')
  assert.equal(mergeAllowedOrigins(''), 'https://ensync.vercel.app')
  assert.equal(
    mergeAllowedOrigins('https://sync.example.com'),
    'https://sync.example.com,https://ensync.vercel.app',
  )
  assert.equal(
    mergeAllowedOrigins('https://ensync.vercel.app,https://sync.example.com'),
    'https://ensync.vercel.app,https://sync.example.com',
  )
})

test('packaged builds resolve the sync service beside app resources', () => {
  const resolved = resolveLocalSyncServiceOptions({
    isPackaged: true,
    resourcesPath: '/Applications/Ensync.app/Contents/Resources',
    repositoryRoot,
    env: {},
  })
  assert.equal(
    resolved.entryPath,
    join('/Applications/Ensync.app/Contents/Resources', 'sync-service', 'server.mjs'),
  )
})

test('local sync service binds a loopback URL and fails closed on exit or timeout', async (context) => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'ensync-sync-service-'))
  context.after(() => rm(userDataPath, { recursive: true, force: true }))

  const started = await startLocalSyncService({
    isPackaged: false,
    resourcesPath: '/unused',
    repositoryRoot,
    userDataPath,
    env: { ENSYNC_SYNC_PORT: '0' },
    startupTimeoutMs: 10_000,
  })
  assert.match(String(started.url), /^http:\/\/127\.0\.0\.1:\d+$/)
  context.after(() => started.stop())
  await started.stop()
})

test('local sync service returns null when the child exits before becoming ready', async (context) => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'ensync-sync-service-'))
  context.after(() => rm(userDataPath, { recursive: true, force: true }))

  const started = await startLocalSyncService({
    isPackaged: false,
    resourcesPath: '/unused',
    // A repositoryRoot without the service makes the child die immediately.
    repositoryRoot: userDataPath,
    userDataPath,
    env: { ENSYNC_SYNC_PORT: '0' },
    startupTimeoutMs: 5_000,
  })
  assert.equal(started.url, null)
})
