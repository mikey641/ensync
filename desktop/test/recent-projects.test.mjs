import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRecentProjectHandlers, createRecentProjectStore } from '../src/recent-projects.mjs'

function project(name, path, extra = {}) {
  return { name, path, host: 'local', ...extra }
}

test('shell store merges concurrent windows without losing projects and remembers current first', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-recent-projects-'))
  const store = createRecentProjectStore({
    filePath: join(directory, 'global-recent-projects-v1.json'),
    now: () => '2026-08-07T12:00:00.000Z',
  })
  const senderA = {}
  const senderB = {}
  const broadcasts = []
  const handlers = createRecentProjectHandlers({
    isAuthorized: (event) => event.sender === senderA || event.sender === senderB,
    store,
    onChanged: (state) => broadcasts.push(state),
  })

  handlers.migrate({ sender: senderA }, [
    project('Nadlan Desk', '/Users/mikeyhasson/dev/nadlan-desk', { verified: true, context: { files: ['secret'] } }),
  ])
  handlers.migrate({ sender: senderB }, [project('Relay old', '/Users/mikeyhasson/dev/relay')])
  handlers.remember({ sender: senderB }, project('Relay', '/Users/mikeyhasson/dev/relay/'))

  assert.deepEqual(store.list(), [
    project('Relay', '/Users/mikeyhasson/dev/relay/'),
    project('Nadlan Desk', '/Users/mikeyhasson/dev/nadlan-desk'),
  ])
  assert.equal('verified' in store.list()[1], false)
  assert.equal('context' in store.list()[1], false)
  assert.equal(broadcasts.length, 3)
  assert.equal(handlers.get({ sender: {} }), null)
  assert.equal(handlers.remember({ sender: {} }, project('No', '/private/no')), null)
})

test('checksummed store recovers newest staging and falls back to backup corruption-safely', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-recent-projects-'))
  const filePath = join(directory, 'global-recent-projects-v1.json')
  const store = createRecentProjectStore({ filePath })
  store.remember(project('Nadlan Desk', '/work/nadlan-desk'))
  store.remember(project('Relay', '/work/relay'))
  const newest = readFileSync(filePath)

  writeFileSync(`${filePath}.staging`, newest)
  writeFileSync(filePath, '{corrupt')
  assert.deepEqual(createRecentProjectStore({ filePath }).list().map((item) => item.path), [
    '/work/relay',
    '/work/nadlan-desk',
  ])

  writeFileSync(filePath, '{corrupt-again')
  assert.deepEqual(createRecentProjectStore({ filePath }).list().map((item) => item.path), [
    '/work/nadlan-desk',
  ])
})

test('the shell registry drops a home directory and cleans one already stored', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-recent-projects-'))
  const filePath = join(directory, 'global-recent-projects-v1.json')
  const homePath = '/Users/mikeyhasson'
  // A registry written before Ensync stopped focusing the home directory.
  const polluted = createRecentProjectStore({ filePath })
  polluted.remember(project('mikeyhasson', homePath))
  polluted.remember(project('Relay', '/Users/mikeyhasson/dev/relay'))
  assert.deepEqual(polluted.list().map((item) => item.path), ['/Users/mikeyhasson/dev/relay', homePath])

  const store = createRecentProjectStore({ filePath, homePath })
  assert.deepEqual(store.list().map((item) => item.path), ['/Users/mikeyhasson/dev/relay'])
  // Cleaned on disk, not only in memory, and not restorable by a later merge.
  assert.deepEqual(
    createRecentProjectStore({ filePath }).list().map((item) => item.path),
    ['/Users/mikeyhasson/dev/relay'],
  )
  store.migrate([project('mikeyhasson', `${homePath}/`), project('Apartments', '/Users/mikeyhasson/apartment-finder')])
  store.remember(project('mikeyhasson', homePath))
  assert.deepEqual(store.list().map((item) => item.path), [
    '/Users/mikeyhasson/dev/relay',
    '/Users/mikeyhasson/apartment-finder',
  ])

  const handlers = createRecentProjectHandlers({ isAuthorized: () => true, store })
  assert.equal(handlers.get({ sender: {} }).homePath, homePath)
  assert.equal(handlers.remember({ sender: {} }, project('mikeyhasson', homePath)).homePath, homePath)
})
