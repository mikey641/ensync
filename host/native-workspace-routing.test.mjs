import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findRetainedWorkspaceForProject,
  workspaceProjectHistoryScore,
} from '../src/lib/nativeWorkspaceRouting.mjs'
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
const isolated = { id: '22222222-2222-4222-8222-222222222222', kind: 'isolated' }
const project = { id: 'relay', path: '/Users/example/relay' }

test('an empty new conversation is not treated as saved project history', () => {
  assert.equal(workspaceProjectHistoryScore({
    projects: [project],
    chats: [{ id: 'chat-empty', projectId: project.id, title: 'New conversation', messages: [] }],
  }, project), 0)
  assert.ok(workspaceProjectHistoryScore({
    projects: [project],
    chats: [{ id: 'chat-saved', projectId: project.id, messages: [{ role: 'user', content: 'keep me' }] }],
  }, project) > 0)
})

test('project selection finds the retained window with checksummed saved conversations', () => {
  const storage = createStorage()
  const canonicalKeys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, canonical))
  const isolatedKeys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, isolated))
  commitWorkspaceSnapshot(storage, {
    projects: [project],
    chats: [{ id: 'chat-saved', projectId: project.id, messages: [{ role: 'user', content: 'saved' }] }],
  }, { keys: canonicalKeys, now: () => '2026-08-07T10:00:00.000Z' })
  commitWorkspaceSnapshot(storage, {
    projects: [project],
    chats: [{ id: 'chat-empty', projectId: project.id, title: 'New conversation', messages: [] }],
  }, { keys: isolatedKeys, now: () => '2026-08-07T10:01:00.000Z' })

  const target = findRetainedWorkspaceForProject(storage, {
    currentWorkspace: isolated,
    retainedWorkspaces: [isolated, canonical],
    project,
  })
  assert.equal(target?.workspace.id, canonical.id)
  assert.equal(target?.workspace.kind, 'canonical')
  assert.equal(target?.projectId, project.id)

  assert.equal(findRetainedWorkspaceForProject(storage, {
    currentWorkspace: canonical,
    retainedWorkspaces: [isolated, canonical],
    project,
  }), null)
})

test('project routing matches Windows paths case-insensitively without merging state', () => {
  const storage = createStorage()
  const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, isolated))
  commitWorkspaceSnapshot(storage, {
    projects: [{ id: 'stored-id', path: 'C:\\Work\\Relay' }],
    chats: [{ id: 'chat', projectId: 'stored-id', messages: [{ role: 'agent', content: 'done' }] }],
  }, { keys })
  const result = findRetainedWorkspaceForProject(storage, {
    currentWorkspace: canonical,
    retainedWorkspaces: [canonical, isolated],
    project: { id: 'new-id', path: 'c:/work/relay/' },
  })
  assert.equal(result?.workspace.id, isolated.id)
  assert.equal(result?.projectId, 'stored-id')
})
