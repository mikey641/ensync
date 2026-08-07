import assert from 'node:assert/strict'
import test from 'node:test'

import { collectNativeRecentProjectCandidates } from '../src/lib/nativeRecentProjects.mjs'
import { commitWorkspaceSnapshot } from '../src/lib/workspacePersistence.mjs'

function storage() {
  const values = new Map()
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

function project(id, name, path) {
  return { id, name, path, host: 'local' }
}

test('native recent-project migration includes v3 and missing legacy v2 projects', () => {
  const localStorage = storage()
  commitWorkspaceSnapshot(localStorage, {
    projects: [project('relay', 'relay', '/Users/person/dev/relay')],
    activeProjectId: 'relay',
  }, { now: () => '2026-08-07T12:00:00.000Z' })
  localStorage.setItem('ensync-workspace-v2', JSON.stringify({
    projects: [
      project('nadlan', 'nadlan-desk', '/Users/person/dev/nadlan-desk'),
      project('old-relay', 'Relay old', '/Users/person/dev/relay/'),
    ],
    activeProjectId: 'nadlan',
    chats: [{ id: 'private-chat', messages: [{ content: 'private' }] }],
  }))

  assert.deepEqual(collectNativeRecentProjectCandidates(localStorage, {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'canonical',
  }), [
    { name: 'relay', path: '/Users/person/dev/relay', host: 'local' },
    { name: 'nadlan-desk', path: '/Users/person/dev/nadlan-desk', host: 'local' },
  ])
})

test('native recent-project migration ignores corrupt legacy state', () => {
  const localStorage = storage()
  localStorage.setItem('ensync-workspace-v2', '{corrupt')

  assert.deepEqual(collectNativeRecentProjectCandidates(localStorage, {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'canonical',
  }), [])
})
