import assert from 'node:assert/strict'
import test from 'node:test'

import { initializeNativeWorkspaceIdentity } from '../src/lib/nativeWorkspaceIdentity.mjs'
import { initializeNativeWorkspaceRecovery } from '../src/lib/nativeWorkspaceRecovery.mjs'
import {
  commitWorkspaceSnapshot,
  readWorkspaceSnapshot,
} from '../src/lib/workspacePersistence.mjs'

const CANDIDATE_ID = 'a'.repeat(64)

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

function encodedSnapshot(state) {
  const source = storage()
  commitWorkspaceSnapshot(source, state, { now: () => '2026-08-07T10:00:00.000Z' })
  return source.getItem('ensync-workspace-snapshot-v3')
}

test('operator-selected recovery merges before hydration and preserves the live snapshot as backup', async () => {
  const localStorage = storage()
  const current = {
    projects: [{ id: 'relay', path: '/current/relay' }],
    activeProjectId: 'relay',
    chats: [{ id: 'live', projectId: 'relay', title: 'Live', messages: [] }],
    tabs: [{ id: 'live-tab', chatId: 'live' }],
    activeTabId: 'live-tab',
    inFlightRuns: { live: { turnId: 'live-turn', provider: 'codex' } },
  }
  commitWorkspaceSnapshot(localStorage, current, { now: () => '2026-08-07T10:01:00.000Z' })
  const currentEncoded = localStorage.getItem('ensync-workspace-snapshot-v3')
  const recovered = {
    projects: [{ id: 'historical-project', path: '/historical/project' }],
    chats: [{ id: 'historical', projectId: 'historical-project', title: 'Historical', messages: [] }],
    tabs: [{ id: 'historical-tab', chatId: 'historical' }],
    activeTabId: 'historical-tab',
  }
  await initializeNativeWorkspaceIdentity({ navigator: { userAgent: 'Chrome' }, localStorage })
  const target = {
    navigator: { userAgent: 'Chrome' },
    localStorage,
    ensyncDesktop: {
      getWorkspaceRecoveryCandidate: async () => ({ id: CANDIDATE_ID, encoded: encodedSnapshot(recovered) }),
    },
  }

  const applied = await initializeNativeWorkspaceRecovery(target)
  assert.equal(applied.status, 'applied')
  assert.deepEqual(applied.summary, {
    addedProjects: 1, addedChats: 1, addedTabs: 1, reconciledRecoveredRuns: 0,
  })
  const state = readWorkspaceSnapshot(localStorage).state
  assert.equal(state.activeProjectId, 'relay')
  assert.equal(state.activeTabId, 'live-tab')
  assert.deepEqual(state.inFlightRuns, current.inFlightRuns)
  assert.deepEqual(state.chats.map((chat) => chat.id), ['live', 'historical'])
  assert.deepEqual(state.workspaceRecoveryIds, [CANDIDATE_ID])
  assert.equal(localStorage.getItem('ensync-workspace-snapshot-v3-backup'), currentEncoded)

  const repeated = await initializeNativeWorkspaceRecovery(target)
  assert.equal(repeated.status, 'already_applied')
})

test('declining a recovery candidate performs no storage writes', async () => {
  const localStorage = storage()
  commitWorkspaceSnapshot(localStorage, { chats: [] })
  const before = [...localStorage.values.entries()]
  await initializeNativeWorkspaceIdentity({ navigator: { userAgent: 'Chrome' }, localStorage })
  const result = await initializeNativeWorkspaceRecovery({
    localStorage,
    ensyncDesktop: {
      getWorkspaceRecoveryCandidate: async () => ({
        id: CANDIDATE_ID,
        encoded: encodedSnapshot({ chats: [{ id: 'old', messages: [] }] }),
      }),
    },
  }, { confirmRecovery: () => false })
  assert.equal(result.status, 'declined')
  assert.deepEqual([...localStorage.values.entries()], before)
})

test('isolated native windows cannot consume a canonical recovery candidate', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const localStorage = storage()
  await initializeNativeWorkspaceIdentity({
    navigator: { userAgent: 'Electron/43.3.0' },
    localStorage,
    ensyncDesktop: {
      getWorkspaceIdentity: async () => ({ id, kind: 'isolated', retainedWorkspaceIds: [id] }),
    },
  })
  let requested = false
  const result = await initializeNativeWorkspaceRecovery({
    localStorage,
    ensyncDesktop: { getWorkspaceRecoveryCandidate: async () => { requested = true; return null } },
  })
  assert.equal(result.status, 'unavailable')
  assert.equal(requested, false)
  assert.equal(localStorage.values.size, 0)
})
