import assert from 'node:assert/strict'
import test from 'node:test'

import { recoverArchivedProjectHistory } from '../src/lib/archivedProjectHistory.mjs'
import { commitWorkspaceSnapshot, createWorkspaceSnapshotKeys } from '../src/lib/workspacePersistence.mjs'

function createStorage() {
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

const canonical = { id: '11111111-1111-4111-8111-111111111111', kind: 'canonical' }
const retiredId = '22222222-2222-4222-8222-222222222222'
const relay = { id: 'local-relay', name: 'relay', path: '/Users/example/relay', host: 'local' }
const nadlan = { id: 'local-nadlan', name: 'nadlan-desk', path: '/Users/example/nadlan-desk', host: 'local' }

test('canonical hydration recovers real project chats from a retired native window', () => {
  const storage = createStorage()
  const keys = createWorkspaceSnapshotKeys((key) => `ensync-native-workspace:${retiredId}:${key}`)
  const retired = {
    projects: [relay],
    activeProjectId: relay.id,
    chats: [
      { id: 'relay-chat-a', projectId: relay.id, title: 'Build apps', messages: [{ role: 'user', content: 'continue' }] },
      { id: 'relay-chat-b', projectId: relay.id, title: 'Provider fixes', messages: [{ role: 'agent', content: 'done' }] },
    ],
    tabs: [
      { id: 'relay-tab-a', chatId: 'relay-chat-a' },
      { id: 'relay-tab-b', chatId: 'relay-chat-b' },
    ],
    activeTabId: 'relay-tab-a',
    drafts: { 'relay-chat-a': 'keep this draft' },
    inFlightRuns: {
      'relay-chat-a': {
        jobId: 'job-turn-1234567890123456',
        turnId: 'turn-a',
        provider: 'codex',
        projectId: relay.id,
      },
    },
  }
  commitWorkspaceSnapshot(storage, retired, { keys, now: () => '2026-08-07T20:00:00.000Z' })
  const sourceBytes = storage.getItem(keys.primary)
  const current = {
    projects: [nadlan, relay],
    activeProjectId: relay.id,
    chats: [
      { id: 'nadlan-chat', projectId: nadlan.id, messages: [{ role: 'user', content: 'keep Nadlan' }] },
      { id: 'relay-empty', projectId: relay.id, title: 'New conversation', messages: [] },
    ],
    tabs: [{ id: 'relay-empty-tab', chatId: 'relay-empty' }],
    activeTabId: 'relay-empty-tab',
    autoFallback: false,
  }

  const recovered = recoverArchivedProjectHistory(current, storage, {
    identity: canonical,
    retainedWorkspaceIds: [canonical.id],
  })
  assert.deepEqual(recovered.summary, { scannedWorkspaces: 1, recoveredProjects: 1, addedChats: 2 })
  assert.equal(recovered.state.chats.some((chat) => chat.id === 'nadlan-chat'), true)
  assert.equal(recovered.state.chats.some((chat) => chat.id === 'relay-chat-a'), true)
  assert.equal(recovered.state.chats.some((chat) => chat.id === 'relay-chat-b'), true)
  assert.equal(recovered.state.drafts['relay-chat-a'], 'keep this draft')
  assert.equal(recovered.state.inFlightRuns['relay-chat-a'].jobId, 'job-turn-1234567890123456')
  assert.equal(recovered.state.activeTabId, 'relay-tab-a')
  assert.equal(recovered.state.autoFallback, false)
  assert.equal(storage.getItem(keys.primary), sourceBytes)

  const repeated = recoverArchivedProjectHistory(recovered.state, storage, {
    identity: canonical,
    retainedWorkspaceIds: [canonical.id],
  })
  assert.equal(repeated.summary.recoveredProjects, 0)
  assert.equal(repeated.state.chats.length, recovered.state.chats.length)
})

test('meaningful canonical project history wins over retired copies', () => {
  const storage = createStorage()
  const keys = createWorkspaceSnapshotKeys((key) => `ensync-native-workspace:${retiredId}:${key}`)
  commitWorkspaceSnapshot(storage, {
    projects: [relay],
    chats: [{ id: 'retired-chat', projectId: relay.id, messages: [{ role: 'user', content: 'old' }] }],
    tabs: [],
  }, { keys })
  const current = {
    projects: [relay],
    chats: [{ id: 'current-chat', projectId: relay.id, messages: [{ role: 'user', content: 'current' }] }],
    tabs: [],
  }
  const result = recoverArchivedProjectHistory(current, storage, {
    identity: canonical,
    retainedWorkspaceIds: [canonical.id],
  })
  assert.equal(result.summary.recoveredProjects, 0)
  assert.deepEqual(result.state.chats, current.chats)
  assert.equal(result.state.archivedProjectRecoveryIds.length, 1)
  const repeated = recoverArchivedProjectHistory(result.state, storage, {
    identity: canonical,
    retainedWorkspaceIds: [canonical.id],
  })
  assert.strictEqual(repeated.state, result.state)
})

test('isolated workspaces never absorb archived histories', () => {
  const storage = createStorage()
  const state = { projects: [relay], chats: [], tabs: [] }
  const result = recoverArchivedProjectHistory(state, storage, {
    identity: { id: retiredId, kind: 'isolated' },
    retainedWorkspaceIds: [retiredId],
  })
  assert.strictEqual(result.state, state)
  assert.equal(result.summary.scannedWorkspaces, 0)
})
