import assert from 'node:assert/strict'
import test from 'node:test'

import { recoverRecentProjectHistory } from '../src/lib/recentProjectHistory.mjs'
import {
  commitWorkspaceSnapshot,
  createWorkspaceSnapshotKeys,
} from '../src/lib/workspacePersistence.mjs'

const CANONICAL_ID = '11111111-1111-4111-8111-111111111111'
const RETIRED_ID = '22222222-2222-4222-8222-222222222222'
const RETAINED_ID = '33333333-3333-4333-8333-333333333333'

function storage() {
  const values = new Map()
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
    values,
  }
}

function scopedKeys(id) {
  return createWorkspaceSnapshotKeys((key) => `ensync-native-workspace:${id}:${key}`)
}

function project(id, name, path) {
  return {
    id,
    name,
    path,
    host: 'local',
    context: {
      relayDirectory: true,
      files: ['private-old-file.md'],
      featureFiles: ['features/private-old-file.md'],
      truncated: false,
      error: null,
      instructionAdapters: [],
    },
    inspectedAt: '2026-08-07T10:00:00.000Z',
    color: '#abcdef',
    verified: true,
  }
}

test('canonical startup recovers only deduplicated project history from retired workspaces', () => {
  const localStorage = storage()
  const retired = {
    projects: [
      project('local-relay', 'relay', '/Users/person/dev/relay'),
      project('local-current-old', 'Current old', '/Users/person/dev/current'),
    ],
    activeProjectId: 'local-relay',
    chats: [{ id: 'private-chat', projectId: 'local-relay', messages: [{ role: 'user', content: 'private' }] }],
    tabs: [{ id: 'private-tab', chatId: 'private-chat' }],
    drafts: { 'private-chat': 'private draft' },
    splitLayout: { hiddenTabIds: ['private-tab'] },
  }
  commitWorkspaceSnapshot(localStorage, retired, {
    keys: scopedKeys(RETIRED_ID),
    now: () => '2026-08-07T10:00:00.000Z',
  })
  commitWorkspaceSnapshot(localStorage, {
    projects: [project('local-secret', 'Still active elsewhere', '/Users/person/dev/secret')],
  }, {
    keys: scopedKeys(RETAINED_ID),
    now: () => '2026-08-07T10:01:00.000Z',
  })
  const retiredBytes = localStorage.getItem(scopedKeys(RETIRED_ID).primary)
  const chats = [{ id: 'live-chat', projectId: 'local-current', messages: [] }]
  const current = {
    projects: [project('local-current', 'Current', '/Users/person/dev/current')],
    activeProjectId: 'local-current',
    chats,
    tabs: [{ id: 'live-tab', chatId: 'live-chat' }],
  }

  const result = recoverRecentProjectHistory(current, localStorage, {
    identity: { id: CANONICAL_ID, kind: 'canonical' },
    retainedWorkspaceIds: [CANONICAL_ID, RETAINED_ID],
  })

  assert.deepEqual(result.summary, { scannedWorkspaces: 1, addedProjects: 1 })
  assert.equal(result.state.activeProjectId, 'local-current')
  assert.strictEqual(result.state.chats, chats)
  assert.deepEqual(result.state.tabs, current.tabs)
  assert.equal(result.state.drafts, undefined)
  assert.deepEqual(result.state.projects.map((item) => item.path), [
    '/Users/person/dev/current',
    '/Users/person/dev/relay',
  ])
  assert.equal(result.state.projects[1].verified, false)
  assert.deepEqual(result.state.projects[1].context.files, [])
  assert.equal(result.state.projects.some((item) => item.path.endsWith('/secret')), false)
  assert.equal(localStorage.getItem(scopedKeys(RETIRED_ID).primary), retiredBytes)

  const repeated = recoverRecentProjectHistory(result.state, localStorage, {
    identity: { id: CANONICAL_ID, kind: 'canonical' },
    retainedWorkspaceIds: [CANONICAL_ID, RETAINED_ID],
  })
  assert.deepEqual(repeated.summary, { scannedWorkspaces: 0, addedProjects: 0 })
  assert.strictEqual(repeated.state, result.state)
})

test('canonical startup merges project-only history from legacy state even when v3 already exists', () => {
  const localStorage = storage()
  const currentChats = [{ id: 'live-chat', projectId: 'local-relay', messages: [] }]
  const current = {
    projects: [project('local-relay', 'relay', '/Users/person/dev/relay')],
    activeProjectId: 'local-relay',
    chats: currentChats,
  }
  const legacy = {
    projects: [
      project('legacy-nadlan', 'nadlan-desk', '/Users/person/dev/nadlan-desk'),
      project('legacy-relay', 'old relay', '/Users/person/dev/relay/'),
    ],
    activeProjectId: 'legacy-nadlan',
    chats: [{ id: 'private-chat', projectId: 'legacy-nadlan', messages: [{ role: 'user', content: 'private' }] }],
    drafts: { 'private-chat': 'private draft' },
  }

  const result = recoverRecentProjectHistory(current, localStorage, {
    identity: { id: CANONICAL_ID, kind: 'canonical' },
    retainedWorkspaceIds: [CANONICAL_ID],
    legacyStates: [legacy],
  })

  assert.deepEqual(result.summary, { scannedWorkspaces: 0, addedProjects: 1 })
  assert.equal(result.state.activeProjectId, 'local-relay')
  assert.strictEqual(result.state.chats, currentChats)
  assert.deepEqual(result.state.projects.map((item) => item.path), [
    '/Users/person/dev/relay',
    '/Users/person/dev/nadlan-desk',
  ])
  assert.equal(result.state.projects[1].verified, false)
  assert.deepEqual(result.state.projects[1].context.files, [])
  assert.equal(result.state.drafts, undefined)

  const repeated = recoverRecentProjectHistory(result.state, localStorage, {
    identity: { id: CANONICAL_ID, kind: 'canonical' },
    retainedWorkspaceIds: [CANONICAL_ID],
    legacyStates: [legacy],
  })
  assert.deepEqual(repeated.summary, { scannedWorkspaces: 0, addedProjects: 0 })
  assert.strictEqual(repeated.state, result.state)
})

test('isolated and browser workspaces never inherit retired project history', () => {
  const localStorage = storage()
  commitWorkspaceSnapshot(localStorage, {
    projects: [project('local-relay', 'relay', '/Users/person/dev/relay')],
  }, { keys: scopedKeys(RETIRED_ID) })
  const current = { projects: [], activeProjectId: '' }

  const isolated = recoverRecentProjectHistory(current, localStorage, {
    identity: { id: CANONICAL_ID, kind: 'isolated' },
    retainedWorkspaceIds: [CANONICAL_ID],
  })
  const browser = recoverRecentProjectHistory(current, localStorage, {
    identity: { id: null, kind: 'canonical' },
    retainedWorkspaceIds: [],
  })

  assert.strictEqual(isolated.state, current)
  assert.strictEqual(browser.state, current)
  assert.equal(isolated.summary.addedProjects, 0)
  assert.equal(browser.summary.addedProjects, 0)
})

test('path normalization deduplicates Windows history and corrupt snapshots are ignored', () => {
  const localStorage = storage()
  commitWorkspaceSnapshot(localStorage, {
    projects: [project('old-relay', 'relay', 'c:/Work/Relay/')],
  }, { keys: scopedKeys(RETIRED_ID), now: () => '2026-08-07T10:00:00.000Z' })
  localStorage.setItem(scopedKeys(RETAINED_ID).primary, '{corrupt')
  const current = {
    projects: [project('relay-now', 'Relay now', 'C:\\Work\\Relay')],
    activeProjectId: 'relay-now',
  }

  const result = recoverRecentProjectHistory(current, localStorage, {
    identity: { id: CANONICAL_ID, kind: 'canonical' },
    retainedWorkspaceIds: [CANONICAL_ID],
  })

  assert.deepEqual(result.summary, { scannedWorkspaces: 1, addedProjects: 0 })
  assert.equal(result.state.projects.length, 1)
  assert.equal(result.state.activeProjectId, 'relay-now')
  assert.equal(result.state.recentProjectRecoveryIds.length, 1)
})
