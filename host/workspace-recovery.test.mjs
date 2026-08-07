import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeRecoveredWorkspaceState } from '../src/lib/workspaceRecovery.mjs'

test('recovery merges historical chats without replacing live work or settings', () => {
  const current = {
    projects: [
      { id: 'project-home', name: 'Home now', path: '/Users/person' },
      { id: 'project-relay', name: 'relay', path: '/Users/person/dev/relay' },
    ],
    activeProjectId: 'project-relay',
    chats: [
      { id: 'chat-live', projectId: 'project-relay', title: 'Current', messages: [{ id: 'live', role: 'user', content: 'new work' }] },
      { id: 'chat-collision', projectId: 'project-relay', title: 'Live collision', messages: [] },
    ],
    tabs: [
      { id: 'tab-live', chatId: 'chat-live' },
      { id: 'tab-collision', chatId: 'chat-collision' },
    ],
    activeTabId: 'tab-live',
    drafts: { 'chat-live': 'current draft' },
    chatErrors: { 'chat-live': null },
    inFlightRuns: { 'chat-live': { turnId: 'turn-live', provider: 'codex', startedAt: '2026-08-07T12:00:00.000Z' } },
    placement: 'end',
    conversationLayout: 'tabs',
  }
  const recovered = {
    projects: [
      { id: 'old-home', name: 'Home then', path: '/Users/person' },
      { id: 'project-relay', name: 'nadlan-desk', path: '/Users/person/dev/nadlan-desk' },
    ],
    activeProjectId: 'project-relay',
    chats: [
      { id: 'chat-old', projectId: 'old-home', title: 'Old home', messages: [] },
      {
        id: 'chat-collision', projectId: 'project-relay', title: 'Historical collision', provider: 'claude',
        messages: [{ id: 'old-user', role: 'user', content: 'recover me', deliveryStatus: 'pending', turnId: 'old-turn' }],
      },
    ],
    tabs: [
      { id: 'tab-old', chatId: 'chat-old' },
      { id: 'tab-collision', chatId: 'chat-collision' },
    ],
    drafts: { 'chat-collision': 'historical draft' },
    chatErrors: {},
    chatExecutionEvents: { 'chat-collision': [{ type: 'output', text: 'old output' }] },
    promptQueues: { 'chat-collision': [{ id: 'queued-old' }] },
    inFlightRuns: {
      'chat-collision': {
        turnId: 'old-turn', provider: 'claude', executionTarget: 'local', attemptedProviders: ['claude'],
        providerProcessStarted: true,
      },
    },
    splitLayout: {
      paneSizes: { 'tab-old': 2, 'tab-collision': 3 },
      hiddenTabIds: ['tab-collision'],
      maximizedTabId: 'tab-collision',
    },
    placement: 'adjacent',
    conversationLayout: 'split',
  }
  const currentBefore = JSON.stringify(current)
  const recoveredBefore = JSON.stringify(recovered)

  const result = mergeRecoveredWorkspaceState(current, recovered, {
    now: () => '2026-08-07T12:30:00.000Z',
  })
  const historicalChatId = result.mappings.chatIdMap.get('chat-collision')
  const historicalTabId = result.mappings.tabIdMap.get('tab-collision')

  assert.deepEqual(result.summary, {
    addedProjects: 1,
    addedChats: 2,
    addedTabs: 2,
    reconciledRecoveredRuns: 1,
  })
  assert.equal(result.state.activeProjectId, 'project-relay')
  assert.equal(result.state.activeTabId, 'tab-live')
  assert.equal(result.state.placement, 'end')
  assert.equal(result.state.conversationLayout, 'tabs')
  assert.deepEqual(result.state.inFlightRuns, current.inFlightRuns)
  assert.equal(result.state.drafts['chat-live'], 'current draft')
  assert.equal(result.state.drafts[historicalChatId], 'historical draft')
  assert.equal(result.state.promptQueues[historicalChatId][0].id, 'queued-old')
  assert.equal(result.state.chats.find((chat) => chat.id === historicalChatId).messages[0].deliveryStatus, 'interrupted')
  assert.equal(result.state.chats.find((chat) => chat.id === historicalChatId).continuation.status, 'reconciliation_required')
  assert.equal(result.state.chatExecutionEvents[historicalChatId].at(-1).outcome, 'interrupted')
  assert.equal(result.state.splitLayout.paneSizes[historicalTabId], 3)
  assert.ok(result.state.splitLayout.hiddenTabIds.includes(historicalTabId))
  assert.equal(result.state.splitLayout.maximizedTabId, historicalTabId)
  assert.equal(result.mappings.projectIdMap.get('old-home'), 'project-home')
  assert.notEqual(result.mappings.projectIdMap.get('project-relay'), 'project-relay')
  assert.equal(JSON.stringify(current), currentBefore)
  assert.equal(JSON.stringify(recovered), recoveredBefore)

  const repeated = mergeRecoveredWorkspaceState(result.state, recovered, {
    now: () => '2026-08-07T12:30:00.000Z',
  })
  assert.equal(repeated.summary.addedChats, 0)
  assert.equal(repeated.summary.addedTabs, 0)
  assert.equal(repeated.summary.addedProjects, 0)
})

test('equivalent chats and their tab-scoped state are not duplicated', () => {
  const chat = { id: 'chat-a', projectId: 'project-a', title: 'Same', messages: [] }
  const tab = { id: 'tab-a', chatId: 'chat-a' }
  const current = {
    projects: [{ id: 'project-a', path: 'C:\\Work\\Relay' }],
    chats: [chat], tabs: [tab], drafts: {}, splitLayout: { paneSizes: { 'tab-a': 4 }, hiddenTabIds: [] },
  }
  const recovered = {
    projects: [{ id: 'old-project', path: 'c:/Work/Relay/' }],
    chats: [{ ...chat, projectId: 'old-project' }], tabs: [tab], drafts: { 'chat-a': 'historical' },
    splitLayout: { paneSizes: { 'tab-a': 1 }, hiddenTabIds: ['tab-a'], maximizedTabId: 'tab-a' },
  }
  const result = mergeRecoveredWorkspaceState(current, recovered)
  assert.equal(result.state.projects.length, 1)
  assert.equal(result.state.chats.length, 1)
  assert.equal(result.state.tabs.length, 1)
  assert.equal(result.state.drafts['chat-a'], 'historical')
  assert.equal(result.state.splitLayout.paneSizes['tab-a'], 4)
  assert.deepEqual(result.state.splitLayout.hiddenTabIds, ['tab-a'])
})
