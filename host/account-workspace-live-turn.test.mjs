import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeLiveTurn,
  buildLiveTurn,
  LIVE_TURN_NOTE_LIMIT,
  LIVE_TURN_STALE_MS,
  liveTurnSettled,
  mergeAccountWorkspace,
  portableLiveTurn,
  prepareAccountWorkspace,
  withLiveTurns,
} from './account-workspace.mjs'
import { ChatJobError } from './chat-jobs.mjs'
import { applyBrokeredProgress, applyBrokeredTurn, ConversationReplyWriter } from './conversation-reply-writer.mjs'
import { SyncBrokerHostWorker } from './sync-broker-host.mjs'

const STARTED = '2026-11-09T10:00:00.000Z'

function note(text, at, extra = {}) {
  return { type: 'note', provider: 'claude', text, redacted: false, at, ...extra }
}

function chat(messages, extra = {}) {
  return { id: 'chat-1', projectId: 'p1', title: 'T', provider: 'claude', messages, ...extra }
}

function doc(chats) {
  return { format: 'ensync-account-conversations', version: 1, projects: [], chats }
}

const prompt = { id: 'u1', role: 'user', turnId: 'turn-1', content: 'find the post composer', time: '10:00' }

test('a desktop run publishes provider, start time and its latest notes, and nothing else', () => {
  const events = [
    { type: 'started', provider: 'claude', cwd: '/Users/me/secret', command: 'claude -p', at: STARTED },
    { type: 'output', stream: 'stdout', text: 'TOKEN=abc', redacted: false, at: STARTED },
    ...Array.from({ length: 9 }, (_, index) => note(`note ${index}`, `2026-11-09T10:00:0${index}.000Z`)),
  ]
  const live = buildLiveTurn({ turnId: 'turn-1', provider: 'claude', startedAt: STARTED, events })
  assert.equal(live.status, 'running')
  assert.equal(live.provider, 'claude')
  assert.equal(live.startedAt, STARTED)
  assert.equal(live.origin, 'desktop')
  assert.equal(live.updatedAt, '2026-11-09T10:00:08.000Z')
  assert.equal(live.notes.length, LIVE_TURN_NOTE_LIMIT)
  assert.deepEqual(live.notes.map((item) => item.text), ['note 3', 'note 4', 'note 5', 'note 6', 'note 7', 'note 8'])
  const serialized = JSON.stringify(live)
  assert.doesNotMatch(serialized, /TOKEN|secret|claude -p/)

  const workspace = prepareAccountWorkspace({ chats: withLiveTurns([chat([prompt])], { 'chat-1': live }), projects: [] })
  assert.deepEqual(workspace.chats[0].liveTurn, live)
  // Progress is never a message, so it cannot duplicate one.
  assert.deepEqual(workspace.chats[0].messages.map((message) => message.id), ['u1'])
})

test('the live turn is whitelisted: unknown or unsafe fields are dropped', () => {
  const live = portableLiveTurn({
    turnId: 'turn-1', status: 'running', provider: 'claude', startedAt: STARTED, updatedAt: STARTED,
    output: 'raw terminal', cwd: '/tmp', attachments: [{ path: '/x' }],
    notes: [{ text: 'hello', provider: 'claude', redacted: true, at: STARTED, command: 'rm -rf' }, { text: '   ' }, 'bad'],
  })
  assert.deepEqual(Object.keys(live).sort(), ['notes', 'origin', 'provider', 'startedAt', 'status', 'turnId', 'updatedAt'])
  assert.deepEqual(live.notes, [{ provider: 'claude', text: 'hello', redacted: true, at: STARTED }])
  assert.equal(portableLiveTurn({ turnId: 't', status: 'finished', startedAt: STARTED }), undefined)
  assert.equal(portableLiveTurn({ turnId: 't', status: 'running', startedAt: 'nope' }), undefined)
})

test('a finished turn drops its live progress on every device, even when a stale copy merges back', () => {
  const live = buildLiveTurn({ turnId: 'turn-1', provider: 'claude', startedAt: STARTED, events: [note('working', STARTED)] })
  const running = doc([chat([prompt], { liveTurn: live })])
  // The desktop finished: prompt completed, reply appended, no live turn locally.
  const finishedLocal = {
    chats: [chat([
      { ...prompt, deliveryStatus: 'completed' },
      { id: 'msg-turn-1-agent', role: 'agent', turnId: 'turn-1', content: 'done', time: '10:02' },
    ])],
    projects: [],
  }
  const merged = mergeAccountWorkspace(finishedLocal, running)
  assert.equal(merged.state.chats[0].liveTurn, undefined)
  assert.equal(prepareAccountWorkspace(merged.state).chats[0].liveTurn, undefined)
  assert.deepEqual(merged.state.chats[0].messages.map((message) => message.id), ['u1', 'msg-turn-1-agent'])

  // A phone that still holds the running copy merges the finished document.
  const phoneMerge = mergeAccountWorkspace(running, prepareAccountWorkspace(finishedLocal))
  assert.equal(phoneMerge.state.chats[0].liveTurn, undefined)

  // A failed or stopped prompt also settles it.
  assert.equal(liveTurnSettled([{ ...prompt, deliveryStatus: 'failed' }], live), true)
  assert.equal(liveTurnSettled([{ ...prompt, deliveryStatus: 'cancelled' }], live), true)
  assert.equal(liveTurnSettled([prompt], live), false)
})

test('concurrent progress never conflicts: the freshest copy wins and messages merge as before', () => {
  const older = buildLiveTurn({ turnId: 'turn-1', provider: 'claude', startedAt: STARTED, events: [note('one', '2026-11-09T10:00:05.000Z')] })
  const newer = buildLiveTurn({ turnId: 'turn-1', provider: 'claude', startedAt: STARTED, events: [note('one', '2026-11-09T10:00:05.000Z'), note('two', '2026-11-09T10:00:09.000Z')] })
  const phoneMessage = { id: 'u2', role: 'user', content: 'also', time: '10:01', origin: 'phone' }
  const local = { chats: [chat([prompt], { liveTurn: older })], projects: [] }
  const remote = doc([chat([prompt, phoneMessage], { liveTurn: newer })])
  const merged = mergeAccountWorkspace(local, remote).state.chats[0]
  assert.deepEqual(merged.liveTurn.notes.map((item) => item.text), ['one', 'two'])
  assert.deepEqual(merged.messages.map((message) => message.id), ['u1', 'u2'])

  const reverse = mergeAccountWorkspace({ chats: [chat([prompt], { liveTurn: newer })], projects: [] }, doc([chat([prompt], { liveTurn: older })]))
  assert.deepEqual(reverse.state.chats[0].liveTurn, newer)

  // A document written by a client that predates live turns has none; the
  // merge keeps the newer client's progress instead of failing.
  const legacy = mergeAccountWorkspace({ chats: [chat([prompt], { liveTurn: newer })], projects: [] }, doc([chat([prompt])]))
  assert.deepEqual(legacy.state.chats[0].liveTurn, newer)
})

test('readers hide a live turn whose writer stopped refreshing it', () => {
  const live = buildLiveTurn({ turnId: 'turn-1', provider: 'claude', startedAt: STARTED, heartbeatAt: '2026-11-09T10:05:00.000Z' })
  const conversation = chat([prompt], { liveTurn: live })
  assert.ok(activeLiveTurn(conversation, Date.parse('2026-11-09T10:06:00.000Z')))
  assert.equal(activeLiveTurn(conversation, Date.parse('2026-11-09T10:05:00.000Z') + LIVE_TURN_STALE_MS + 1), null)
})

test('the Host mirrors a brokered turn\'s notes, then the reply replaces them', () => {
  const phonePrompt = { id: 'msg-1-phone', role: 'user', content: 'fix it', time: '10:00', origin: 'phone' }
  const document = doc([chat([phonePrompt])])
  const progress = {
    jobId: 'job_1', conversationId: 'chat-1', messageId: 'msg-1-phone', provider: 'claude', startedAt: STARTED,
    notes: [note('Searching for the composer.', '2026-11-09T10:00:03.000Z')],
  }
  const withProgress = applyBrokeredProgress(document, progress)
  assert.equal(withProgress.liveTurn.origin, 'host')
  assert.equal(withProgress.liveTurn.turnId, 'msg-1-phone')
  assert.equal(withProgress.liveTurn.jobId, 'job_1')
  assert.deepEqual(withProgress.liveTurn.notes.map((item) => item.text), ['Searching for the composer.'])
  assert.equal(applyBrokeredProgress(doc([withProgress]), progress), 'unchanged')

  const replied = applyBrokeredTurn(doc([withProgress]), {
    jobId: 'job_1', conversationId: 'chat-1', messageId: 'msg-1-phone', request: { provider: 'claude' },
    notes: progress.notes,
    outcome: { type: 'completed', result: { provider: 'claude', response: 'Done.' } },
  })
  assert.equal(replied.liveTurn, undefined)
  assert.deepEqual(replied.messages.at(-1).notes, [{ provider: 'claude', text: 'Searching for the composer.', redacted: false }])
  // Progress arriving after the reply cannot resurrect the live turn.
  assert.equal(applyBrokeredProgress(doc([replied]), progress), 'unchanged')
})

test('the reply writer throttles progress to the newest snapshot and stops once the reply is enqueued', async () => {
  let remote = doc([chat([{ id: 'm1', role: 'user', content: 'go', time: '' }])])
  let revision = 1
  const pushes = []
  const accountSync = {
    status: () => ({ authenticated: true }),
    pull: async () => ({ state: structuredClone(remote), revision }),
    push: async (document) => {
      pushes.push(structuredClone(document))
      remote = document
      revision += 1
      return { status: 'saved', revision }
    },
  }
  const writer = new ConversationReplyWriter({ accountSyncService: accountSync, progressIntervalMs: 60_000 })
  const base = { jobId: 'job_9', conversationId: 'chat-1', messageId: 'm1', provider: 'codex', startedAt: STARTED }
  writer.publishProgress({ ...base, notes: [note('a', '2026-11-09T10:00:01.000Z')] })
  writer.publishProgress({ ...base, notes: [note('a', '2026-11-09T10:00:01.000Z'), note('b', '2026-11-09T10:00:02.000Z')] })
  await writer.flushProgress()
  assert.equal(pushes.length, 1)
  assert.deepEqual(pushes[0].chats[0].liveTurn.notes.map((item) => item.text), ['a', 'b'])

  await writer.enqueue({ ...base, request: { provider: 'codex' }, outcome: { type: 'completed', result: { provider: 'codex', response: 'ok' } } })
  writer.publishProgress({ ...base, notes: [note('late', '2026-11-09T10:00:09.000Z')] })
  await writer.flushProgress()
  writer.stop()
  assert.equal(pushes.length, 2)
  assert.equal(pushes[1].chats[0].liveTurn, undefined)
  assert.deepEqual(pushes[1].chats[0].messages.map((message) => message.id), ['m1', 'msg-job_9-agent'])
})

test('the broker worker reports notes (never output) for a conversation job while it runs', async () => {
  const listeners = {}
  const chatJobs = {
    get: () => { throw new ChatJobError('chat_job_not_found', 'missing', 404, false) },
    start: async () => ({ disposition: 'started', job: { id: 'job_1', state: 'running', startedAt: STARTED } }),
    subscribe: (_id, handlers) => { Object.assign(listeners, handlers); return () => {} },
  }
  const progress = []
  const account = {
    registerBrokerDevice: async () => ({ id: 'host-1' }),
    pollBrokerHostJobs: async () => [{ id: 'job_1', kind: 'chat', request: { provider: 'claude', prompt: 'x', conversationId: 'chat-1', messageId: 'm1' } }],
    claimBrokerJob: async (job) => ({ ...job, newlyClaimed: true }),
    publishBrokerEvent: async () => ({ state: 'running', lastEventSequence: 1 }),
    pollBrokerCommands: async () => [],
  }
  const worker = new SyncBrokerHostWorker({
    accountSyncService: account,
    chatJobService: chatJobs,
    pollIntervalMs: 60_000,
    onConversationJobProgress: (input) => { progress.push(structuredClone(input)) },
  })
  worker.running = true
  await worker.pollOnce()
  assert.equal(progress.length, 1)
  assert.equal(progress[0].startedAt, STARTED)
  assert.deepEqual(progress[0].notes, [])
  listeners.onEvent({ type: 'output', stream: 'stdout', text: 'secret output', sequence: 1, at: STARTED })
  listeners.onEvent({ type: 'note', provider: 'claude', text: 'Reading files.', redacted: false, sequence: 2, at: STARTED })
  assert.equal(progress.length, 2)
  assert.deepEqual(progress[1].notes.map((item) => item.text), ['Reading files.'])
  assert.equal(progress[1].conversationId, 'chat-1')
  assert.doesNotMatch(JSON.stringify(progress), /secret output/)
  await worker.stop()
})
