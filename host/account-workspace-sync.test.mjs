import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isAccountWorkspace,
  accountWorkspaceHasSettings,
  mergeAccountWorkspace,
  prepareAccountWorkspace,
} from '../src/lib/accountWorkspaceSync.mjs'

test('account workspace exports conversations with server-owned reconnect state', () => {
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
        turnId: 'turn-a',
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
    inFlightRuns: {
      'chat-a': {
        turnId: 'turn-a', provider: 'codex', jobId: 'job-turn-a-codex-1', executionTarget: 'local',
        attemptedProviders: ['codex'], providerProcessStarted: true, startedAt: '2026-08-07T10:00:00.000Z',
      },
    },
    promptQueues: { 'chat-a': [{ prompt: 'Run next' }] },
    chatExecutionEvents: { 'chat-a': [{ type: 'output', text: 'terminal output' }] },
    drafts: { 'chat-a': 'local draft' },
    placement: 'end',
    conversationLayout: 'tabs',
    autoFallback: false,
    autoContextSkill: true,
    fallbackProviderOrder: ['claude', 'codex'],
    displayPreferences: { theme: 'light', textSize: 'comfortable', completionIndicator: 'header' },
    agentUpdatePreferences: {
      mode: 'automatic',
      lastReminderAt: '2026-08-07T10:00:00.000Z',
      lastMaintenanceAt: null,
    },
    completionNotificationSettings: { mode: 'speech', voiceURI: 'device-voice' },
    splitLayout: { order: ['tab-a'] },
  })

  assert.equal(isAccountWorkspace(workspace), true)
  assert.equal(accountWorkspaceHasSettings(workspace), true)
  assert.equal(workspace.version, 3)
  assert.equal(workspace.chatSessions['chat-a'].sessionId, 'vendor-secret')
  assert.equal(workspace.inFlightRuns['chat-a'].jobId, 'job-turn-a-codex-1')
  assert.equal('promptQueues' in workspace, false)
  assert.equal(workspace.chatExecutionEvents['chat-a'][0].text, 'terminal output')
  assert.equal('drafts' in workspace, false)
  assert.equal(workspace.chats[0].messages[0].deliveryStatus, 'pending')
  assert.equal(workspace.chats[0].messages[0].attachments, undefined)
  assert.equal(workspace.chats[0].continuation.sessionResumable, true)
  assert.deepEqual(workspace.chats[0].continuation.gitBefore, { branch: 'main' })
  assert.deepEqual(Object.keys(workspace.projects[0]).sort(), ['color', 'host', 'id', 'name', 'path'])
  assert.deepEqual(workspace.settings, {
    placement: 'end',
    conversationLayout: 'tabs',
    autoFallback: false,
    autoContextSkill: true,
    fallbackProviderOrder: ['claude', 'codex'],
    display: { theme: 'light', textSize: 'comfortable', completionIndicator: 'header' },
    agentUpdates: {
      mode: 'automatic',
      lastReminderAt: '2026-08-07T10:00:00.000Z',
      lastMaintenanceAt: null,
    },
  })
  assert.equal('completionNotificationSettings' in workspace, false)
  assert.equal('splitLayout' in workspace, false)
})

test('account settings follow the remote revision unless this client has a local settings edit', () => {
  const local = {
    chats: [],
    projects: [],
    placement: 'adjacent',
    conversationLayout: 'split',
    autoFallback: true,
    autoContextSkill: false,
    fallbackProviderOrder: ['codex', 'claude'],
    displayPreferences: { theme: 'dark', textSize: 'large', completionIndicator: 'dot' },
    agentUpdatePreferences: { mode: 'manual', lastReminderAt: null, lastMaintenanceAt: null },
  }
  const remote = prepareAccountWorkspace({
    chats: [],
    projects: [],
    placement: 'end',
    conversationLayout: 'tabs',
    autoFallback: false,
    autoContextSkill: true,
    fallbackProviderOrder: ['claude', 'codex'],
    displayPreferences: { theme: 'light', textSize: 'comfortable', completionIndicator: 'tab' },
    agentUpdatePreferences: { mode: 'automatic', lastReminderAt: null, lastMaintenanceAt: null },
  })

  const pulled = mergeAccountWorkspace(local, remote).state
  assert.equal(pulled.placement, 'end')
  assert.equal(pulled.autoFallback, false)
  assert.deepEqual(pulled.displayPreferences, remote.settings.display)
  assert.equal(pulled.agentUpdatePreferences.mode, 'automatic')

  const locallyEdited = mergeAccountWorkspace(local, remote, { preferLocalSettings: true }).state
  assert.equal(locallyEdited.placement, 'adjacent')
  assert.equal(locallyEdited.autoFallback, true)
  assert.deepEqual(locallyEdited.displayPreferences, local.displayPreferences)
  assert.equal(locallyEdited.agentUpdatePreferences.mode, 'manual')
})

test('legacy account documents keep local settings while upgrading to v3', () => {
  const legacy = {
    format: 'ensync-account-conversations',
    version: 2,
    chats: [],
    projects: [],
    chatSessions: {},
    inFlightRuns: {},
    chatExecutionEvents: {},
  }
  const local = {
    chats: [],
    projects: [],
    placement: 'end',
    displayPreferences: { theme: 'dark', textSize: 'large', completionIndicator: 'header' },
  }

  assert.equal(isAccountWorkspace(legacy), true)
  assert.equal(accountWorkspaceHasSettings(legacy), false)
  const merged = mergeAccountWorkspace(local, legacy).state
  assert.equal(merged.placement, 'end')
  assert.equal(merged.displayPreferences.theme, 'dark')
  assert.equal(prepareAccountWorkspace(merged).version, 3)
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
  assert.equal(prepareAccountWorkspace(merged.state).chats[0].continuation.sessionResumable, true)
  assert.deepEqual(merged.state.drafts, local.drafts)
  assert.strictEqual(merged.state.projects.find((project) => project.id === 'project-a'), local.projects[0])
  const imported = merged.state.projects.find((project) => project.id === 'project-b')
  assert.equal(imported.verified, false)
  assert.deepEqual(imported.context.files, [])
})

test('a live server job imported from another computer remains reconnectable', () => {
  const remote = prepareAccountWorkspace({
    chats: [{
      id: 'chat-live', projectId: 'project-live', title: 'Live', subtitle: 'Working now', group: 'Today', provider: 'codex',
      messages: [{
        id: 'message-live', turnId: 'turn-live-1234', role: 'user', content: 'Keep running', time: '10:00', deliveryStatus: 'pending',
      }],
    }],
    projects: [{ id: 'project-live', name: 'Server project', path: '/srv/project', host: 'local' }],
    chatSessions: { 'chat-live': { provider: 'codex', sessionId: 'server-session', syncedMessageCount: 2 } },
    inFlightRuns: {
      'chat-live': {
        turnId: 'turn-live-1234', provider: 'codex', jobId: 'job-turn-live-1234-codex-1', executionTarget: 'local',
        attemptedProviders: ['codex'], providerProcessStarted: true, startedAt: '2026-08-08T10:00:00.000Z',
      },
    },
    chatExecutionEvents: { 'chat-live': [{ type: 'started', sequence: 1 }] },
  })

  const merged = mergeAccountWorkspace({ chats: [], projects: [] }, remote).state
  assert.equal(merged.chatSessions['chat-live'].sessionId, 'server-session')
  assert.equal(merged.inFlightRuns['chat-live'].jobId, 'job-turn-live-1234-codex-1')
  assert.equal(merged.chatExecutionEvents['chat-live'][0].sequence, 1)
})

test('pending or queued messages without a server job key cannot become executable on another client', () => {
  const workspace = prepareAccountWorkspace({
    chats: [{
      id: 'chat-orphan', projectId: 'project-a', title: 'Orphan', group: 'Today', provider: 'codex',
      messages: [
        { id: 'message-pending', turnId: 'turn-pending', role: 'user', content: 'Pending', time: '10:00', deliveryStatus: 'pending' },
        { id: 'message-queued', turnId: 'turn-queued', role: 'user', content: 'Queued', time: '10:01', deliveryStatus: 'queued' },
      ],
    }],
    projects: [],
  })
  assert.deepEqual(
    workspace.chats[0].messages.map((message) => message.deliveryStatus),
    ['interrupted', 'interrupted'],
  )
  assert.deepEqual(workspace.inFlightRuns, {})
})
