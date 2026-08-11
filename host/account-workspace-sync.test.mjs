import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isAccountWorkspace,
  mergeAccountWorkspace,
  prepareAccountWorkspace,
} from '../src/lib/accountWorkspaceSync.mjs'

test('account workspace exports conversations without machine-local execution state', () => {
  const workspace = prepareAccountWorkspace({
    chats: [{
      id: 'chat-a',
      projectId: 'project-a',
      title: 'Keep me',
      subtitle: 'Working',
      group: 'Today',
      provider: 'codex',
      messages: [{
        id: 'message-a',
        role: 'user',
        content: 'Inspect the image',
        time: '10:00',
        deliveryStatus: 'pending',
        sessionResumable: true,
        attachments: [{ name: 'secret.png', path: '/Users/me/secret.png' }],
      }],
      continuation: {
        turnId: 'turn-a',
        status: 'completed',
        provider: 'codex',
        model: null,
        sizeTier: null,
        executionTarget: 'ssh:me@private-host',
        sessionResumable: true,
        attemptedProviders: ['codex'],
        fallbackReason: null,
        completedAt: '2026-08-07T10:00:00.000Z',
        gitBefore: { branch: 'main' },
        gitAfter: { branch: 'feature' },
      },
    }],
    projects: [{
      id: 'project-a', name: 'Relay', path: '/Users/me/relay', host: 'local', color: '#fff', verified: true,
      context: { files: ['private.md'] },
    }],
    chatSessions: { 'chat-a': { provider: 'codex', sessionId: 'vendor-secret' } },
    promptQueues: { 'chat-a': [{ prompt: 'Run next' }] },
    chatExecutionEvents: { 'chat-a': [{ type: 'output', text: 'terminal output' }] },
    drafts: { 'chat-a': 'local draft' },
  })

  assert.equal(isAccountWorkspace(workspace), true)
  assert.equal('chatSessions' in workspace, false)
  assert.equal('promptQueues' in workspace, false)
  assert.equal('chatExecutionEvents' in workspace, false)
  assert.equal('drafts' in workspace, false)
  assert.equal(workspace.chats[0].messages[0].deliveryStatus, 'interrupted')
  assert.equal(workspace.chats[0].messages[0].attachments, undefined)
  assert.equal(workspace.chats[0].continuation.sessionResumable, false)
  assert.equal(workspace.chats[0].continuation.gitBefore, null)
  assert.deepEqual(Object.keys(workspace.projects[0]).sort(), ['color', 'host', 'id', 'name', 'path'])
})

test('account workspace merge unions stable chats and messages without making remote projects verified', () => {
  const local = {
    chats: [{
      id: 'chat-shared', projectId: 'project-a', title: 'Shared', subtitle: 'Local', group: 'Today', provider: 'codex',
      messages: [
        { id: 'message-1', role: 'user', content: 'First', time: '10:00', deliveryStatus: 'completed', attachments: [{ name: 'local.txt', path: '/local/local.txt' }] },
        { id: 'message-3', role: 'user', content: 'Local branch', time: '10:02', deliveryStatus: 'completed' },
      ],
      continuation: { status: 'completed', sessionResumable: true, gitAfter: { branch: 'local' } },
    }],
    projects: [{ id: 'project-a', name: 'Local', path: '/local', verified: true, context: { files: ['seen'] } }],
    drafts: { 'chat-shared': 'stays local' },
  }
  const remote = prepareAccountWorkspace({
    chats: [
      {
        id: 'chat-shared', projectId: 'project-a', title: 'Shared', subtitle: 'Remote', group: 'Today', provider: 'codex',
        messages: [
          { id: 'message-1', role: 'user', content: 'First', time: '10:00', deliveryStatus: 'pending' },
          { id: 'message-2', role: 'agent', content: 'Remote reply', time: '10:01' },
        ],
      },
      { id: 'chat-remote', projectId: 'project-b', title: 'Other computer', subtitle: 'Done', group: 'Yesterday', provider: 'claude', messages: [] },
    ],
    projects: [{ id: 'project-b', name: 'Remote', path: 'C:\\code\\remote', color: '#123' }],
  })

  const merged = mergeAccountWorkspace(local, remote)
  assert.equal(merged.importedChats, 1)
  assert.equal(merged.totalChats, 2)
  assert.deepEqual(merged.state.chats[0].messages.map((message) => message.id), ['message-1', 'message-2', 'message-3'])
  assert.equal(merged.state.chats[0].messages[0].deliveryStatus, 'completed')
  assert.equal(merged.state.chats[0].messages[0].attachments[0].path, '/local/local.txt')
  assert.equal(merged.state.chats[0].continuation.sessionResumable, true)
  assert.equal(prepareAccountWorkspace(merged.state).chats[0].messages[0].attachments, undefined)
  assert.equal(prepareAccountWorkspace(merged.state).chats[0].continuation.sessionResumable, false)
  assert.deepEqual(merged.state.drafts, local.drafts)
  assert.strictEqual(merged.state.projects.find((project) => project.id === 'project-a'), local.projects[0])
  const imported = merged.state.projects.find((project) => project.id === 'project-b')
  assert.equal(imported.verified, false)
  assert.deepEqual(imported.context.files, [])
})

test('transferred account messages become interrupted remotely while a local target queue remains stronger', () => {
  const remote = prepareAccountWorkspace({
    chats: [{
      id: 'chat-a', projectId: 'project-a', title: 'Shared', subtitle: '', group: 'Today', provider: 'codex',
      messages: [{ id: 'message-a', role: 'user', content: 'Transferred', time: '10:00', deliveryStatus: 'transferred' }],
    }],
    projects: [{ id: 'project-a', name: 'Project', path: '/repo' }],
  })
  assert.equal(remote.chats[0].messages[0].deliveryStatus, 'interrupted')
  assert.equal(remote.chats[0].messages[0].handoffTransferred, true)

  const merged = mergeAccountWorkspace({
    chats: [{
      id: 'chat-a', projectId: 'project-a', title: 'Shared', subtitle: '', group: 'Today', provider: 'codex',
      messages: [{ id: 'message-a', role: 'user', content: 'Transferred', time: '10:00', deliveryStatus: 'queued' }],
    }],
    projects: [{ id: 'project-a', name: 'Project', path: '/repo', verified: true }],
  }, remote)
  assert.equal(merged.state.chats[0].messages[0].deliveryStatus, 'queued')
})
