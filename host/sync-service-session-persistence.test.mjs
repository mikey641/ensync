import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEnsyncSyncServer, FileSyncStore } from '../sync-service/server.mjs'

function publicBaseUrl(server) {
  const address = server.address()
  assert.equal(typeof address, 'object')
  return `http://127.0.0.1:${address.port}`
}

async function listen(context, options) {
  const server = createEnsyncSyncServer(options)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  return { server, baseUrl: publicBaseUrl(server) }
}

test('a sign-in session survives the sync service being restarted', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'ensync-sync-session-'))
  context.after(async () => { await rm(dir, { recursive: true, force: true }) })
  const dataPath = join(dir, 'ensync-sync-data.json')
  const sessionsPath = join(dir, 'ensync-sync-sessions-v1.json')
  const credentials = { username: 'session.persist', password: 'Session persistence pass 42!' }

  const first = await listen(context, {
    store: new FileSyncStore(dataPath),
    sessionsPath,
  })

  const registered = await fetch(`${first.baseUrl}/v1/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  }).then((response) => response.json())
  assert.equal(typeof registered.token, 'string')
  assert.ok(registered.token.length > 20)

  const authenticated = await fetch(`${first.baseUrl}/v1/account`, {
    headers: { Authorization: `Bearer ${registered.token}` },
  })
  assert.equal(authenticated.status, 200)
  const profile = await authenticated.json()
  assert.equal(profile.username, credentials.username)
  assert.equal(profile.twoFactorEnabled, false)
  assert.equal(profile.email, null)

  // A "new" service instance restores the earlier session from disk without a
  // fresh sign-in, even though its in-memory session map starts empty.
  const second = await listen(context, {
    store: new FileSyncStore(dataPath),
    sessionsPath,
  })

  const restored = await fetch(`${second.baseUrl}/v1/account`, {
    headers: { Authorization: `Bearer ${registered.token}` },
  })
  assert.equal(restored.status, 200)
  assert.equal((await restored.json()).username, credentials.username)

  const stored = await readFile(sessionsPath, 'utf8')
  assert.ok(stored.includes('ensync-sync-sessions'))
  // The raw bearer token must never be written to disk.
  assert.ok(!stored.includes(registered.token))
})
