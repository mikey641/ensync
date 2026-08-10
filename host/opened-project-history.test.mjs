import assert from 'node:assert/strict'
import test from 'node:test'

import { recoverOpenedProjectHistory } from '../src/lib/openedProjectHistory.mjs'
import { commitWorkspaceSnapshot, createWorkspaceSnapshotKeys } from '../src/lib/workspacePersistence.mjs'
import { workspaceStorageKey } from '../src/lib/nativeWorkspaceIdentity.mjs'

function createStorage() {
  const values = new Map()
  return {
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

const canonical = { id: '11111111-1111-4111-8111-111111111111', kind: 'canonical' }
const relay = { id: 'local-relay', name: 'relay', path: '/Users/example/relay', host: 'local' }
const nadlan = { id: 'local-nadlan', name: 'nadlan-desk', path: '/Users/example/nadlan-desk', host: 'local' }

test('opening another project copies only its scoped history and leaves the source untouched', () => {
  const storage = createStorage()
  const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, canonical))
  commitWorkspaceSnapshot(storage, {
    projects: [relay, nadlan],
    activeProjectId: relay.id,
    chats: [
      { id: 'relay-chat', projectId: relay.id, messages: [{ role: 'user', content: 'keep Relay open' }] },
      { id: 'nadlan-chat', projectId: nadlan.id, messages: [{ role: 'user', content: 'open Nadlan' }] },
    ],
    tabs: [
      { id: 'relay-tab', chatId: 'relay-chat' },
      { id: 'nadlan-tab', chatId: 'nadlan-chat' },
    ],
    activeTabId: 'relay-tab',
    drafts: { 'relay-chat': 'relay draft', 'nadlan-chat': 'nadlan draft' },
    inFlightRuns: { 'nadlan-chat': { jobId: 'job-nadlan' } },
    splitLayout: {
      paneSizes: { 'relay-tab': 2, 'nadlan-tab': 1 },
      hiddenTabIds: ['relay-tab'],
      maximizedTabId: 'relay-tab',
    },
  }, { keys })
  const sourceBytes = storage.getItem(keys.primary)

  const result = recoverOpenedProjectHistory(null, storage, {
    projectLaunch: {
      projectId: nadlan.id,
      projectPath: nadlan.path,
      sourceWorkspace: canonical,
    },
  })
  assert.deepEqual(result.summary, { recovered: true, addedChats: 1 })
  assert.deepEqual(result.state.projects, [nadlan])
  assert.deepEqual(result.state.chats.map((chat) => chat.id), ['nadlan-chat'])
  assert.deepEqual(result.state.tabs, [{ id: 'nadlan-tab', chatId: 'nadlan-chat' }])
  assert.equal(result.state.activeTabId, 'nadlan-tab')
  assert.deepEqual(result.state.drafts, { 'nadlan-chat': 'nadlan draft' })
  assert.equal(result.state.inFlightRuns['nadlan-chat'].jobId, 'job-nadlan')
  assert.deepEqual(result.state.splitLayout, {
    paneSizes: { 'nadlan-tab': 1 },
    hiddenTabIds: [],
    maximizedTabId: null,
  })
  assert.equal(storage.getItem(keys.primary), sourceBytes)
})

test('an already hydrated project window wins over its source snapshot', () => {
  const storage = createStorage()
  const current = {
    projects: [nadlan],
    chats: [{ id: 'current', projectId: nadlan.id, messages: [{ role: 'user', content: 'current' }] }],
    tabs: [],
  }
  const result = recoverOpenedProjectHistory(current, storage, {
    projectLaunch: {
      projectId: nadlan.id,
      projectPath: nadlan.path,
      sourceWorkspace: canonical,
    },
  })
  assert.strictEqual(result.state, current)
  assert.deepEqual(result.summary, { recovered: false, addedChats: 0 })
})

test('a missing source snapshot opens an honest empty project workspace', () => {
  const result = recoverOpenedProjectHistory(null, createStorage(), {
    projectLaunch: {
      projectId: nadlan.id,
      projectPath: nadlan.path,
      sourceWorkspace: canonical,
    },
  })
  assert.deepEqual(result.state, {
    projects: [],
    activeProjectId: nadlan.id,
    chats: [],
    tabs: [],
    activeTabId: '',
  })
  assert.deepEqual(result.summary, { recovered: false, addedChats: 0 })
})
