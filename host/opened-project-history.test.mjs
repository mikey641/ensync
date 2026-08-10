import assert from 'node:assert/strict'
import test from 'node:test'

import {
  recoverFocusedProjectHistory,
  recoverOpenedProjectHistory,
} from '../src/lib/openedProjectHistory.mjs'
import { commitWorkspaceSnapshot, createWorkspaceSnapshotKeys } from '../src/lib/workspacePersistence.mjs'
import { workspaceStorageKey } from '../src/lib/nativeWorkspaceIdentity.mjs'

function createStorage() {
  const values = new Map()
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

const canonical = { id: '11111111-1111-4111-8111-111111111111', kind: 'canonical' }
const retired = { id: '22222222-2222-4222-8222-222222222222', kind: 'isolated' }
const opened = { id: '33333333-3333-4333-8333-333333333333', kind: 'isolated' }
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

test('reopening a manually closed project window recovers its retired history', () => {
  const storage = createStorage()
  const sourceKeys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, canonical))
  const retiredKeys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, retired))
  commitWorkspaceSnapshot(storage, {
    projects: [relay],
    activeProjectId: relay.id,
    chats: [{ id: 'relay-chat', projectId: relay.id, messages: [{ role: 'user', content: 'keep Relay' }] }],
    tabs: [{ id: 'relay-tab', chatId: 'relay-chat' }],
  }, { keys: sourceKeys, now: () => '2026-08-08T00:00:00.000Z' })
  commitWorkspaceSnapshot(storage, {
    projects: [nadlan],
    activeProjectId: nadlan.id,
    chats: [{ id: 'nadlan-history', projectId: nadlan.id, messages: [{ role: 'user', content: 'restore me' }] }],
    tabs: [{ id: 'nadlan-tab', chatId: 'nadlan-history' }],
    activeTabId: 'nadlan-tab',
    drafts: { 'nadlan-history': 'closed-window draft' },
  }, { keys: retiredKeys, now: () => '2026-08-08T00:01:00.000Z' })
  const retiredBytes = storage.getItem(retiredKeys.primary)

  const result = recoverOpenedProjectHistory(null, storage, {
    projectLaunch: {
      projectId: nadlan.id,
      projectPath: nadlan.path,
      sourceWorkspace: canonical,
    },
  })

  assert.deepEqual(result.summary, { recovered: true, addedChats: 1 })
  assert.deepEqual(result.state.chats.map((chat) => chat.id), ['nadlan-history'])
  assert.equal(result.state.activeTabId, 'nadlan-tab')
  assert.equal(result.state.drafts['nadlan-history'], 'closed-window draft')
  assert.equal(storage.getItem(retiredKeys.primary), retiredBytes)
})

test('a stored project owner is a recovery source when its native window cannot be focused', () => {
  const storage = createStorage()
  const retainedKeys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, opened))
  commitWorkspaceSnapshot(storage, {
    projects: [nadlan],
    chats: [{ id: 'stored-history', projectId: nadlan.id, messages: [{ role: 'user', content: 'active elsewhere' }] }],
    tabs: [],
  }, { keys: retainedKeys })

  const result = recoverOpenedProjectHistory(null, storage, {
    projectLaunch: {
      projectId: nadlan.id,
      projectPath: nadlan.path,
      sourceWorkspace: canonical,
    },
  })

  assert.deepEqual(result.summary, { recovered: true, addedChats: 1 })
  assert.deepEqual(result.state.chats.map((chat) => chat.id), ['stored-history'])
})

test('an isolated Relay window can reopen Nadlan history owned by a closed canonical window', () => {
  const storage = createStorage()
  const relayWindow = { id: '44444444-4444-4444-8444-444444444444', kind: 'isolated' }
  const sourceKeys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, relayWindow))
  const canonicalKeys = createWorkspaceSnapshotKeys()
  commitWorkspaceSnapshot(storage, {
    projects: [relay],
    activeProjectId: relay.id,
    chats: [{ id: 'relay-live', projectId: relay.id, messages: [{ role: 'user', content: 'Relay stays open' }] }],
    tabs: [],
  }, { keys: sourceKeys })
  commitWorkspaceSnapshot(storage, {
    projects: [nadlan, relay],
    activeProjectId: nadlan.id,
    chats: [
      { id: 'nadlan-canonical-a', projectId: nadlan.id, messages: [{ role: 'user', content: 'Nadlan history A' }] },
      { id: 'nadlan-canonical-b', projectId: nadlan.id, messages: [{ role: 'agent', content: 'Nadlan history B' }] },
      { id: 'relay-old', projectId: relay.id, messages: [{ role: 'user', content: 'do not copy' }] },
    ],
    tabs: [
      { id: 'nadlan-tab-a', chatId: 'nadlan-canonical-a' },
      { id: 'nadlan-tab-b', chatId: 'nadlan-canonical-b' },
    ],
    activeTabId: 'nadlan-tab-b',
  }, { keys: canonicalKeys })

  const result = recoverOpenedProjectHistory(null, storage, {
    projectLaunch: {
      projectId: nadlan.id,
      projectPath: nadlan.path,
      sourceWorkspace: relayWindow,
    },
  })

  assert.deepEqual(result.summary, { recovered: true, addedChats: 2 })
  assert.deepEqual(result.state.chats.map((chat) => chat.id), [
    'nadlan-canonical-a',
    'nadlan-canonical-b',
  ])
  assert.equal(result.state.activeTabId, 'nadlan-tab-b')
})

test('Cmd+N then selecting Nadlan hydrates its history into the empty new window', () => {
  const storage = createStorage()
  const freshWindow = { id: '55555555-5555-4555-8555-555555555555', kind: 'isolated' }
  const freshKeys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, freshWindow))
  const canonicalKeys = createWorkspaceSnapshotKeys()
  commitWorkspaceSnapshot(storage, {
    projects: [{ id: 'home', name: 'example', path: '/Users/example', host: 'local' }],
    activeProjectId: 'home',
    chats: [{ id: 'empty-chat', projectId: 'home', messages: [] }],
    tabs: [{ id: 'empty-tab', chatId: 'empty-chat' }],
    activeTabId: 'empty-tab',
  }, { keys: freshKeys })
  commitWorkspaceSnapshot(storage, {
    projects: [nadlan],
    activeProjectId: nadlan.id,
    chats: [
      { id: 'nadlan-history-a', projectId: nadlan.id, messages: [{ role: 'user', content: 'is there an online crm skill?' }] },
      { id: 'nadlan-history-b', projectId: nadlan.id, messages: [{ role: 'user', content: 'run our two cron jobs' }] },
    ],
    tabs: [
      { id: 'nadlan-tab-a', chatId: 'nadlan-history-a' },
      { id: 'nadlan-tab-b', chatId: 'nadlan-history-b' },
    ],
    activeTabId: 'nadlan-tab-a',
    drafts: { 'nadlan-history-b': 'keep this draft' },
  }, { keys: canonicalKeys })
  const freshBytes = storage.getItem(freshKeys.primary)
  const canonicalBytes = storage.getItem(canonicalKeys.primary)
  const inspectedNadlan = { ...nadlan, name: 'Nadlan Desk', verified: true }

  const result = recoverFocusedProjectHistory({
    projects: [{ id: 'home', name: 'example', path: '/Users/example', host: 'local' }],
    activeProjectId: 'home',
    chats: [{ id: 'empty-chat', projectId: 'home', messages: [] }],
    tabs: [{ id: 'empty-tab', chatId: 'empty-chat' }],
    activeTabId: 'empty-tab',
  }, storage, {
    project: inspectedNadlan,
    currentWorkspace: freshWindow,
  })

  assert.deepEqual(result.summary, { recovered: true, addedChats: 2 })
  assert.deepEqual(result.state.projects, [inspectedNadlan])
  assert.deepEqual(result.state.chats.map((chat) => chat.id), [
    'nadlan-history-a',
    'nadlan-history-b',
  ])
  assert.ok(result.state.chats.every((chat) => chat.projectId === inspectedNadlan.id))
  assert.equal(result.state.activeTabId, 'nadlan-tab-a')
  assert.equal(result.state.drafts['nadlan-history-b'], 'keep this draft')
  assert.equal(storage.getItem(freshKeys.primary), freshBytes)
  assert.equal(storage.getItem(canonicalKeys.primary), canonicalBytes)
})
