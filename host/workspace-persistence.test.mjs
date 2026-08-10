import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKSPACE_SNAPSHOT_BACKUP_KEY,
  WORKSPACE_SNAPSHOT_STAGING_KEY,
  WORKSPACE_SNAPSHOT_STORAGE_KEY,
  commitWorkspaceSnapshot,
  compactWorkspaceSnapshot,
  createWorkspaceSnapshotKeys,
  INTERRUPTION_MESSAGE,
  readWorkspaceSnapshot,
  reconcileInterruptedWorkspaceState,
} from '../src/lib/workspacePersistence.mjs'
import { workspaceStorageKey } from '../src/lib/nativeWorkspaceIdentity.mjs'
import {
  largestPaneScrollLeft,
  selectSplitLayoutSource,
  splitPaneDisplayWeights,
} from '../src/lib/splitLayoutPersistence.mjs'
import { queuedPromptGate } from '../src/lib/promptQueue.mjs'

function createStorage() {
  const values = new Map()
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
    values,
  }
}

test('the transactional snapshot layout wins over the legacy split-only key', () => {
  const snapshot = { paneSizes: { tab: 3 }, hiddenTabIds: ['tab'], maximizedTabId: null }
  const legacy = { paneSizes: { tab: 1 }, hiddenTabIds: [], maximizedTabId: 'tab' }
  assert.strictEqual(selectSplitLayoutSource(snapshot, legacy), snapshot)
  assert.strictEqual(selectSplitLayoutSource(undefined, legacy), legacy)
})

test('temporary largest-pane sizing keeps every visible pane in the layout', () => {
  const storedSizes = { 'tab-a': 2, 'tab-b': 0.5, 'tab-c': 2 }

  assert.deepEqual(
    splitPaneDisplayWeights(['tab-a', 'tab-b', 'tab-c'], storedSizes, 'tab-b'),
    { 'tab-a': 2, 'tab-b': 8, 'tab-c': 2 },
  )
  assert.deepEqual(
    splitPaneDisplayWeights(['tab-a', 'tab-b', 'tab-c'], storedSizes, null),
    storedSizes,
  )
  assert.deepEqual(storedSizes, { 'tab-a': 2, 'tab-b': 0.5, 'tab-c': 2 })
})

test('the largest pane scrolls fully into view instead of hanging past the right window edge', () => {
  // Five 300px siblings push the enlarged pane past a 2528px viewport.
  assert.equal(
    largestPaneScrollLeft({
      scrollLeft: 0,
      paneLeft: 1530,
      paneWidth: 1685,
      viewportWidth: 2528,
      scrollWidth: 3215,
    }),
    687,
  )
})

test('an already fully visible largest pane keeps the user\'s scroll position', () => {
  assert.equal(
    largestPaneScrollLeft({
      scrollLeft: 687,
      paneLeft: 1530,
      paneWidth: 1685,
      viewportWidth: 2528,
      scrollWidth: 3215,
    }),
    687,
  )
  assert.equal(
    largestPaneScrollLeft({
      scrollLeft: 100,
      paneLeft: 150,
      paneWidth: 900,
      viewportWidth: 1200,
      scrollWidth: 1600,
    }),
    100,
  )
})

test('a largest pane scrolled off to the left realigns to its own left edge', () => {
  assert.equal(
    largestPaneScrollLeft({
      scrollLeft: 900,
      paneLeft: 300,
      paneWidth: 800,
      viewportWidth: 1200,
      scrollWidth: 2400,
    }),
    300,
  )
})

test('largest-pane scroll targets clamp to the scrollable range', () => {
  // A pane wider than the viewport shows its left edge.
  assert.equal(
    largestPaneScrollLeft({
      scrollLeft: 0,
      paneLeft: 600,
      paneWidth: 1500,
      viewportWidth: 1200,
      scrollWidth: 2100,
    }),
    600,
  )
  // Targets never exceed the real scrollable range or go negative.
  assert.equal(
    largestPaneScrollLeft({
      scrollLeft: 0,
      paneLeft: 1200,
      paneWidth: 1500,
      viewportWidth: 1200,
      scrollWidth: 2100,
    }),
    900,
  )
  assert.equal(
    largestPaneScrollLeft({
      scrollLeft: 40,
      paneLeft: 0,
      paneWidth: 600,
      viewportWidth: 1200,
      scrollWidth: 1200,
    }),
    0,
  )
  // Non-finite measurements leave the scroll position alone.
  assert.equal(
    largestPaneScrollLeft({
      scrollLeft: 25,
      paneLeft: Number.NaN,
      paneWidth: 800,
      viewportWidth: 1200,
      scrollWidth: 2400,
    }),
    25,
  )
})

test('workspace snapshots commit atomically with a previous-version fallback', () => {
  const storage = createStorage()
  const first = { chats: [{ id: 'chat-a' }], drafts: { 'chat-a': 'first' } }
  const second = { chats: [{ id: 'chat-a' }], drafts: { 'chat-a': 'second' } }

  assert.deepEqual(commitWorkspaceSnapshot(storage, first, { now: () => '2026-08-06T10:00:00.000Z' }), {
    revision: 1,
    committedAt: '2026-08-06T10:00:00.000Z',
    source: 'primary',
  })
  commitWorkspaceSnapshot(storage, second, { now: () => '2026-08-06T10:01:00.000Z' })

  assert.deepEqual(readWorkspaceSnapshot(storage)?.state, second)
  assert.equal(readWorkspaceSnapshot(storage)?.revision, 2)
  assert.equal(storage.getItem(WORKSPACE_SNAPSHOT_STAGING_KEY), null)
  assert.ok(storage.getItem(WORKSPACE_SNAPSHOT_BACKUP_KEY))

  storage.setItem(WORKSPACE_SNAPSHOT_STORAGE_KEY, '{corrupt')
  const recovered = readWorkspaceSnapshot(storage)
  assert.deepEqual(recovered?.state, first)
  assert.equal(recovered?.source, 'backup')
  assert.equal(recovered?.recovered, true)
})

test('native workspace snapshots isolate new windows without migrating or changing the canonical v3 keys', () => {
  const storage = createStorage()
  const canonical = { chats: [{ id: 'main-chat' }], drafts: { 'main-chat': 'main draft' } }
  commitWorkspaceSnapshot(storage, canonical, { now: () => '2026-08-06T10:00:00.000Z' })
  const canonicalBytes = storage.getItem(WORKSPACE_SNAPSHOT_STORAGE_KEY)
  const firstIdentity = { id: '11111111-1111-4111-8111-111111111111', kind: 'isolated' }
  const secondIdentity = { id: '22222222-2222-4222-8222-222222222222', kind: 'isolated' }
  const firstKeys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, firstIdentity))
  const secondKeys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, secondIdentity))

  assert.equal(readWorkspaceSnapshot(storage, { keys: firstKeys }), null)
  assert.equal(readWorkspaceSnapshot(storage, { keys: secondKeys }), null)
  commitWorkspaceSnapshot(storage, { chats: [], drafts: {} }, { keys: firstKeys })
  commitWorkspaceSnapshot(storage, { chats: [{ id: 'second-chat' }], drafts: {} }, { keys: secondKeys })

  assert.deepEqual(readWorkspaceSnapshot(storage)?.state, canonical)
  assert.equal(storage.getItem(WORKSPACE_SNAPSHOT_STORAGE_KEY), canonicalBytes)
  assert.deepEqual(readWorkspaceSnapshot(storage, { keys: firstKeys })?.state, { chats: [], drafts: {} })
  assert.deepEqual(readWorkspaceSnapshot(storage, { keys: secondKeys })?.state.chats, [{ id: 'second-chat' }])
  assert.notEqual(firstKeys.primary, secondKeys.primary)
})

test('workspace snapshots preserve explicit per-chat execution-panel choices', () => {
  const storage = createStorage()
  const state = {
    chats: [{ id: 'chat-a' }, { id: 'chat-b' }],
    executionPanelOpenByChat: { 'chat-a': true, 'chat-b': false },
  }

  commitWorkspaceSnapshot(storage, state, { now: () => '2026-08-06T10:00:00.000Z' })

  assert.deepEqual(readWorkspaceSnapshot(storage)?.state.executionPanelOpenByChat, {
    'chat-a': true,
    'chat-b': false,
  })
})

test('workspace snapshots preserve unsent and queued file attachments by chat', () => {
  const storage = createStorage()
  const attachment = { name: 'reference.png', path: '/tmp/reference.png' }
  const state = {
    chats: [{ id: 'chat-a', messages: [] }],
    drafts: { 'chat-a': 'Inspect this' },
    draftAttachments: { 'chat-a': [attachment] },
    promptQueues: {
      'chat-a': [{
        id: 'queue-a',
        turnId: 'turn-a',
        messageId: 'message-a',
        prompt: 'Then compare it',
        attachments: [attachment],
        enqueuedAt: '2026-08-07T10:00:00.000Z',
        predecessorTurnId: null,
        preferences: { providerMode: 'fixed' },
      }],
    },
  }

  commitWorkspaceSnapshot(storage, state, { now: () => '2026-08-07T10:00:01.000Z' })
  assert.deepEqual(readWorkspaceSnapshot(storage)?.state, state)
})

test('a fully written staging snapshot survives failed primary promotion', () => {
  const storage = createStorage()
  const originalSetItem = storage.setItem.bind(storage)
  storage.setItem = (key, value) => {
    if (key === WORKSPACE_SNAPSHOT_STORAGE_KEY) throw new Error('quota')
    originalSetItem(key, value)
  }

  const result = commitWorkspaceSnapshot(storage, { drafts: { chat: 'kept' } })
  assert.equal(result.source, 'staging')
  assert.deepEqual(readWorkspaceSnapshot(storage)?.state, { drafts: { chat: 'kept' } })
})

test('execution-event compaction never drops core workspace state', () => {
  const state = {
    chats: [{ id: 'chat-a', messages: [{ content: 'important' }] }],
    tabs: [{ id: 'tab-a', chatId: 'chat-a' }],
    activeTabId: 'tab-a',
    drafts: { 'chat-a': 'unsent prompt' },
    splitLayout: { paneSizes: { 'tab-a': 2 }, hiddenTabIds: [], maximizedTabId: 'tab-a' },
    chatExecutionEvents: {
      'chat-a': Array.from({ length: 20 }, (_, index) => ({
        type: 'output',
        stream: 'stdout',
        text: `${index}:${'x'.repeat(900)}`,
        redacted: false,
        at: `2026-08-06T10:00:${String(index).padStart(2, '0')}.000Z`,
      })),
    },
  }

  const compacted = compactWorkspaceSnapshot(state, { maxExecutionEventCharacters: 5_000 })
  assert.strictEqual(compacted.chats, state.chats)
  assert.strictEqual(compacted.tabs, state.tabs)
  assert.strictEqual(compacted.drafts, state.drafts)
  assert.strictEqual(compacted.splitLayout, state.splitLayout)
  assert.ok(compacted.chatExecutionEvents['chat-a'].length < 20)
  assert.equal(compacted.chatExecutionEvents['chat-a'][0].type, 'notice')
  assert.match(compacted.chatExecutionEvents['chat-a'].at(-1).text, /^19:/)
})

test('legacy snapshots remain readable while new commits omit the device-wide fallback ranking', () => {
  const storage = createStorage()
  const state = {
    chats: [{ id: 'chat-a', messages: [] }],
    fallbackProviderOrder: ['claude', 'codex'],
  }

  commitWorkspaceSnapshot(storage, state)
  assert.deepEqual(readWorkspaceSnapshot(storage)?.state, state)
  commitWorkspaceSnapshot(storage, compactWorkspaceSnapshot(state))

  assert.deepEqual(readWorkspaceSnapshot(storage)?.state, {
    chats: [{ id: 'chat-a', messages: [] }],
  })
  assert.deepEqual(state.fallbackProviderOrder, ['claude', 'codex'])
})

test('concurrent pending chats restore as interrupted reconciliation-required runs', () => {
  const state = {
    chats: [
      {
        id: 'chat-a', provider: 'codex', sizeTier: 'large', subtitle: 'Working now',
        messages: [{ id: 'a', role: 'user', content: 'A', turnId: 'turn-a', deliveryStatus: 'pending' }],
      },
      {
        id: 'chat-b', provider: 'claude', subtitle: 'Working now',
        messages: [{ id: 'b', role: 'user', content: 'B', turnId: 'turn-b', deliveryStatus: 'pending' }],
      },
      { id: 'chat-c', provider: 'codex', subtitle: 'Done', messages: [] },
    ],
    chatSessions: { 'chat-a': { sessionId: 'a' }, 'chat-b': { sessionId: 'b' }, 'chat-c': { sessionId: 'c' } },
    chatErrors: {},
    chatExecutionEvents: { 'chat-a': [], 'chat-b': [] },
    inFlightRuns: {
      'chat-a': {
        turnId: 'turn-a', provider: 'codex', sizeTier: 'large', executionTarget: 'local',
        attemptedProviders: ['codex'], fallbackReason: null, providerProcessStarted: true,
      },
      'chat-b': {
        turnId: 'turn-b', provider: 'claude', sizeTier: null, executionTarget: 'ssh:user@host',
        attemptedProviders: ['codex', 'claude'], fallbackReason: 'Codex unavailable', providerProcessStarted: false,
      },
    },
  }

  const restored = reconcileInterruptedWorkspaceState(state, { now: () => '2026-08-06T10:02:00.000Z' })
  assert.deepEqual(new Set(restored.interruptedChatIds), new Set(['chat-a', 'chat-b']))
  assert.equal(restored.state.inFlightRuns['chat-a'], undefined)
  assert.equal(restored.state.chats[0].messages[0].deliveryStatus, 'interrupted')
  assert.equal(restored.state.chats[0].continuation.status, 'reconciliation_required')
  assert.equal(restored.state.chats[0].continuation.termination, 'interrupted')
  assert.equal(restored.state.chats[0].continuation.sessionResumable, false)
  assert.equal(restored.state.chats[1].continuation.executionTarget, 'ssh:user@host')
  assert.deepEqual(restored.state.chats[1].continuation.attemptedProviders, ['codex', 'claude'])
  assert.equal(restored.state.chatSessions['chat-a'], undefined)
  assert.equal(restored.state.chatSessions['chat-b'], undefined)
  assert.equal(restored.state.chatSessions['chat-c'].sessionId, 'c')
  assert.equal(restored.state.chatExecutionEvents['chat-a'].at(-1).outcome, 'interrupted')
  assert.match(restored.state.chatErrors['chat-b'], /reconcile/i)
  assert.strictEqual(restored.state.chats[2], state.chats[2])
})

test('queued prompts survive relaunch but pause behind an interrupted predecessor', () => {
  const queued = {
    id: 'queue-turn-2', turnId: 'turn-2', messageId: 'u2', prompt: 'Second',
    enqueuedAt: '2026-08-06T10:00:01.000Z', predecessorTurnId: 'turn-1',
    preferences: {
      providerMode: 'fixed', provider: 'codex', sizeTier: 'large', automaticFallback: true,
      autoContextSkill: true, fallbackProviderOrder: ['codex', 'claude'],
      executionTargetKey: 'local', projectId: 'project-a', projectPath: '/project-a',
    },
  }
  const state = {
    chats: [{
      id: 'chat-a', provider: 'codex', subtitle: 'Working now',
      messages: [
        { id: 'u1', role: 'user', turnId: 'turn-1', deliveryStatus: 'pending', content: 'First' },
        { id: 'u2', role: 'user', turnId: 'turn-2', deliveryStatus: 'queued', content: 'Second' },
      ],
    }],
    promptQueues: { 'chat-a': [queued] },
    inFlightRuns: { 'chat-a': { turnId: 'turn-1', provider: 'codex', providerProcessStarted: true } },
  }
  const restored = reconcileInterruptedWorkspaceState(state, { now: () => '2026-08-06T10:02:00.000Z' })
  assert.deepEqual(restored.state.promptQueues, state.promptQueues)
  assert.equal(restored.state.chats[0].messages[1].deliveryStatus, 'queued')
  assert.equal(queuedPromptGate(restored.state.chats[0], restored.state.promptQueues['chat-a'][0]).state, 'paused')
})

test('renderer recovery preserves only runs backed by a reconnectable Host job', () => {
  const state = {
    chats: [
      {
        id: 'chat-job', provider: 'codex', subtitle: 'Working now',
        messages: [{ id: 'u1', role: 'user', turnId: 'turn-1', deliveryStatus: 'pending', content: 'First' }],
      },
      {
        id: 'chat-legacy', provider: 'claude', subtitle: 'Working now',
        messages: [{ id: 'u2', role: 'user', turnId: 'turn-2', deliveryStatus: 'pending', content: 'Second' }],
      },
    ],
    chatSessions: {
      'chat-job': { sessionId: 'job-session' },
      'chat-legacy': { sessionId: 'legacy-session' },
    },
    chatErrors: {},
    chatExecutionEvents: {},
    inFlightRuns: {
      'chat-job': {
        turnId: 'turn-1', provider: 'codex', jobId: 'job_1111111111111111',
        providerProcessStarted: true,
      },
      'chat-legacy': {
        turnId: 'turn-2', provider: 'claude', providerProcessStarted: true,
      },
    },
  }

  const restored = reconcileInterruptedWorkspaceState(state, {
    now: () => '2026-08-07T10:02:00.000Z',
    preserveHostJobs: true,
  })

  assert.deepEqual(restored.interruptedChatIds, ['chat-legacy'])
  assert.equal(restored.state.inFlightRuns['chat-job'].jobId, 'job_1111111111111111')
  assert.equal(restored.state.inFlightRuns['chat-legacy'], undefined)
  assert.equal(restored.state.chats[0].messages[0].deliveryStatus, 'pending')
  assert.equal(restored.state.chats[1].messages[0].deliveryStatus, 'interrupted')
  assert.equal(restored.state.chatSessions['chat-job'].sessionId, 'job-session')
  assert.equal(restored.state.chatSessions['chat-legacy'], undefined)
})

test('legacy PTY-truncated execution streams restore as interrupted, not malformed', () => {
  const state = {
    chats: [{
      id: 'chat-a', provider: 'codex', subtitle: 'Run failed',
      messages: [{
        id: 'u1', role: 'user', turnId: 'turn-1', deliveryStatus: 'failed', content: 'Continue',
      }],
    }],
    chatSessions: { 'chat-a': { provider: 'codex', sessionId: 'unsafe-to-resume' } },
    chatErrors: { 'chat-a': 'Ensync Host returned a malformed execution event.' },
    chatExecutionEvents: { 'chat-a': [{
      type: 'started', provider: 'codex', cwd: '/project', command: 'codex app-server',
      at: '2026-08-07T10:00:00.000Z',
    }] },
    inFlightRuns: {},
  }

  const restored = reconcileInterruptedWorkspaceState(state, {
    now: () => '2026-08-07T10:02:00.000Z',
    preserveHostJobs: true,
  })

  assert.deepEqual(restored.interruptedChatIds, ['chat-a'])
  assert.equal(restored.state.chats[0].subtitle, 'Interrupted by restart')
  assert.equal(restored.state.chats[0].messages[0].deliveryStatus, 'interrupted')
  assert.equal(restored.state.chats[0].continuation.status, 'reconciliation_required')
  assert.equal(restored.state.chats[0].continuation.termination, 'interrupted')
  assert.equal(restored.state.chatSessions['chat-a'], undefined)
  assert.equal(restored.state.chatErrors['chat-a'], INTERRUPTION_MESSAGE)
  assert.equal(restored.state.chatExecutionEvents['chat-a'].at(-1).code, 'run_interrupted')
})

test('a verified malformed provider-output failure is not rewritten as a transport interruption', () => {
  const state = {
    chats: [{
      id: 'chat-a', provider: 'codex', subtitle: 'Run failed',
      messages: [{ id: 'u1', role: 'user', turnId: 'turn-1', deliveryStatus: 'failed', content: 'Continue' }],
    }],
    chatErrors: { 'chat-a': 'Codex returned output Ensync Host could not verify as JSON events.' },
    inFlightRuns: {},
  }

  const restored = reconcileInterruptedWorkspaceState(state, { preserveHostJobs: true })

  assert.deepEqual(restored.interruptedChatIds, [])
  assert.strictEqual(restored.state.chats[0], state.chats[0])
  assert.equal(restored.state.chatErrors['chat-a'], state.chatErrors['chat-a'])
})
