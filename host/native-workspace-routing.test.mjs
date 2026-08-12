import assert from 'node:assert/strict'
import test from 'node:test'

import {
  exactNativeChatFocusCanApply,
  findReferencedOwningConversation,
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
const anotherIsolated = { id: '33333333-3333-4333-8333-333333333333', kind: 'isolated' }
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

test('a shortened protected branch in the latest agent response resolves one exact retained conversation', () => {
  const storage = createStorage()
  const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, isolated))
  commitWorkspaceSnapshot(storage, {
    projects: [{ id: 'nadlan', name: 'Nadlan Desk', path: '/Users/example/nadlan-desk' }],
    chats: [{
      id: 'chat-task-7',
      projectId: 'nadlan',
      title: 'Legacy rental import',
      workspace: { branch: 'ensync/chat-aff577456dcd7cdc9b90feb1' },
      messages: [{ role: 'user', content: 'Implement Task 7' }],
    }],
  }, { keys })

  const target = findReferencedOwningConversation(storage, {
    currentWorkspace: canonical,
    retainedWorkspaces: [canonical, isolated],
    chat: {
      id: 'chat-wrong',
      workspace: { branch: 'ensync/chat-111274a3f047657140a300db' },
      messages: [{
        role: 'agent',
        content: 'Please reopen the original ensync/chat-aff577… conversation and send continue there.',
      }],
    },
  })

  assert.deepEqual(target, {
    workspaceId: isolated.id,
    projectId: 'nadlan',
    projectPath: '/Users/example/nadlan-desk',
    projectName: 'Nadlan Desk',
    chatId: 'chat-task-7',
    chatTitle: 'Legacy rental import',
    branch: 'ensync/chat-aff577456dcd7cdc9b90feb1',
  })
})

test('a shortened workspace ID resolves another conversation in the current native window', () => {
  const storage = createStorage()
  const currentState = {
    projects: [{ id: 'relay', name: 'Ensync', path: 'C:\\Work\\Relay' }],
    chats: [{
      id: 'chat-wrong',
      projectId: 'relay',
      title: 'Wrong retry',
      workspace: { branch: 'ensync/chat-6fc99d71e61fe26545171e10' },
      messages: [{
        role: 'agent',
        content: 'This run is bound to the 6fc99… worktree. The conflicted files exist in the protected 0f96… conversation workspace.',
      }],
    }, {
      id: 'chat-conflict-owner',
      projectId: 'relay',
      title: 'Land and reconcile changes',
      workspace: { branch: 'ensync/chat-0f96d38ffe0c213a56274a16' },
      messages: [{ role: 'user', content: 'land and reconcile any change' }],
    }],
  }

  assert.deepEqual(findReferencedOwningConversation(storage, {
    currentWorkspace: canonical,
    retainedWorkspaces: [canonical],
    currentState,
    chat: currentState.chats[0],
  }), {
    workspaceId: canonical.id,
    projectId: 'relay',
    projectPath: 'C:\\Work\\Relay',
    projectName: 'Ensync',
    chatId: 'chat-conflict-owner',
    chatTitle: 'Land and reconcile changes',
    branch: 'ensync/chat-0f96d38ffe0c213a56274a16',
  })
})

test('owning conversation resolution fails closed for ambiguous prefixes, stale roles, and unchecked storage', () => {
  const storage = createStorage()
  for (const [workspace, suffix] of [[isolated, '9b90feb1'], [anotherIsolated, 'aaaaaaaa']]) {
    const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, workspace))
    commitWorkspaceSnapshot(storage, {
      projects: [{ id: `project-${suffix}`, path: `/Users/example/${suffix}` }],
      chats: [{
        id: `chat-${suffix}`,
        projectId: `project-${suffix}`,
        title: suffix,
        workspace: { branch: `ensync/chat-aff577456dcd7cdc${suffix}` },
        messages: [{ role: 'user', content: 'saved' }],
      }],
    }, { keys })
  }
  const request = {
    currentWorkspace: canonical,
    retainedWorkspaces: [canonical, isolated, anotherIsolated],
    chat: {
      id: 'chat-wrong',
      workspace: { branch: 'ensync/chat-current000000000000000000' },
      messages: [{ role: 'agent', content: 'Open ensync/chat-aff577…' }],
    },
  }
  assert.equal(findReferencedOwningConversation(storage, request), null)
  assert.equal(findReferencedOwningConversation(storage, {
    ...request,
    retainedWorkspaces: [canonical, isolated],
    chat: { ...request.chat, messages: [{ role: 'user', content: 'Open ensync/chat-aff577…' }] },
  }), null)

  const corrupt = createStorage()
  const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, isolated))
  corrupt.setItem(keys.primary, JSON.stringify({ chats: [{ workspace: { branch: 'ensync/chat-aff577456dcd7cdc9b90feb1' } }] }))
  assert.equal(findReferencedOwningConversation(corrupt, {
    ...request,
    retainedWorkspaces: [canonical, isolated],
  }), null)
})

test('exact idle-chat focus validation requires one workspace, project, normalized path, and chat binding', () => {
  const request = {
    workspaceId: isolated.id,
    projectId: 'project-relay',
    projectPath: 'C:\\Work\\Relay',
    chatId: 'chat-relay',
  }
  const current = {
    workspaceId: isolated.id,
    projectId: 'project-relay',
    projectPath: 'c:/work/relay/',
    chatId: 'chat-relay',
  }
  assert.equal(exactNativeChatFocusCanApply(request, current), true)
  assert.equal(exactNativeChatFocusCanApply({ ...request, workspaceId: canonical.id }, current), false)
  assert.equal(exactNativeChatFocusCanApply({ ...request, chatId: 'chat-other' }, current), false)
  assert.equal(exactNativeChatFocusCanApply({ ...request, projectPath: 'C:\\Work\\Other' }, current), false)
  assert.equal(exactNativeChatFocusCanApply({ ...request, jobId: 'job-not-idle' }, current), false)
})
