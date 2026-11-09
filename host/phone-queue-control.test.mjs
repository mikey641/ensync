import assert from 'node:assert/strict'
import test from 'node:test'

import { activeQueuedTurns, mergeAccountWorkspace, prepareAccountWorkspace } from './account-workspace.mjs'
import { ChatJobError } from './chat-jobs.mjs'
import { applyBrokeredTurn, applyHostQueue } from './conversation-reply-writer.mjs'
import { conversationBranchName } from './project-isolation.mjs'
import { summarizeDelivery, SyncBrokerHostWorker } from './sync-broker-host.mjs'

const STARTED = '2026-11-09T10:00:00.000Z'

function fakeChatJobs({ busy = () => false } = {}) {
  const jobs = new Map()
  const listeners = new Map()
  const calls = { start: [], cancel: [], steer: [] }
  return {
    calls,
    jobs,
    listeners,
    get(jobId) {
      const job = jobs.get(jobId)
      if (!job) throw new ChatJobError('chat_job_not_found', 'missing', 404, false)
      return { ...job }
    },
    async start(input) {
      calls.start.push(input.jobId)
      if (busy(input)) return { disposition: 'occupied', owner: { jobId: 'job_desktop_1' } }
      const job = { id: input.jobId, state: 'running', startedAt: STARTED, request: input.request }
      jobs.set(input.jobId, job)
      return { disposition: 'started', job: { ...job } }
    },
    subscribe(jobId, handlers) {
      listeners.set(jobId, handlers)
      return () => listeners.delete(jobId)
    },
    cancel(jobId) {
      calls.cancel.push(jobId)
      const job = jobs.get(jobId)
      if (!job) throw new ChatJobError('chat_job_not_found', 'missing', 404, false)
      job.state = 'cancelled'
      return { ...job }
    },
    async steer(jobId, input) {
      calls.steer.push({ jobId, input })
      return { status: 'delivered' }
    },
    runningForWorkspace(projectPath, workspaceKey) {
      return [...jobs.values()].find((job) => job.state === 'running'
        && job.request?.projectPath === projectPath && job.request?.workspaceKey === workspaceKey) ?? null
    },
  }
}

function fakeAccount(brokerJobs) {
  const events = []
  const acks = []
  const commands = new Map()
  return {
    events,
    acks,
    commands,
    registerBrokerDevice: async () => ({ id: 'host-1' }),
    pollBrokerHostJobs: async () => brokerJobs.splice(0),
    claimBrokerJob: async (job) => ({ ...job, newlyClaimed: true }),
    publishBrokerEvent: async (job, event) => {
      events.push({ jobId: job.id, event })
      return { state: event.type === 'completed' ? 'completed' : event.type === 'cancelled' ? 'cancelled' : event.type === 'error' ? 'failed' : 'running', lastEventSequence: event.sequence }
    },
    pollBrokerCommands: async (job) => commands.get(job.id)?.splice(0) ?? [],
    claimBrokerCommand: async () => ({ newlyClaimed: true }),
    acknowledgeBrokerCommand: async (job, command, acknowledgement) => { acks.push({ jobId: job.id, command, acknowledgement }) },
  }
}

const desktopRequest = { provider: 'claude', projectPath: '/p', prompt: 'desktop', workspaceKey: 'chat:chat-1' }

function phoneJob(id, extra = {}) {
  return {
    id,
    kind: 'local',
    request: { provider: 'claude', projectPath: '/p', prompt: 'from phone', workspaceKey: 'chat:chat-1', conversationId: 'chat-1', messageId: `m-${id}`, ...extra },
  }
}

test('a phone turn for a busy conversation is queued, mirrored, and starts when the running turn ends', async () => {
  let desktopRunning = true
  const chatJobs = fakeChatJobs({ busy: () => desktopRunning })
  chatJobs.jobs.set('job_desktop_1', { id: 'job_desktop_1', state: 'running', startedAt: STARTED, request: desktopRequest })
  const brokerJobs = [phoneJob('job_phone_1')]
  const account = fakeAccount(brokerJobs)
  const queues = []
  const finished = []
  const worker = new SyncBrokerHostWorker({
    accountSyncService: account,
    chatJobService: chatJobs,
    pollIntervalMs: 60_000,
    onConversationQueueChanged: (queue) => { queues.push(structuredClone(queue)) },
    onConversationJobFinished: (input) => { finished.push(input) },
  })
  worker.running = true
  await worker.pollOnce()
  // Queued, not rejected: nothing failed and nothing was reported finished.
  assert.equal(finished.length, 0)
  assert.equal(account.events.length, 0)
  assert.deepEqual(queues.at(-1).items.map((item) => item.messageId), ['m-job_phone_1'])
  assert.deepEqual(worker.queuedTurns('chat-1').map((item) => item.jobId), ['job_phone_1'])

  await worker.pollOnce()
  assert.equal(chatJobs.jobs.has('job_phone_1'), false)

  desktopRunning = false
  await worker.pollOnce()
  assert.equal(chatJobs.jobs.get('job_phone_1').state, 'running')
  assert.deepEqual(queues.at(-1).items, [])
  assert.ok(chatJobs.listeners.has('job_phone_1'))
  await worker.stop()
})

test('stopping a queued phone turn ends it without touching the running turn or the chat continuation', async () => {
  const chatJobs = fakeChatJobs({ busy: () => true })
  const brokerJobs = [phoneJob('job_phone_2')]
  const account = fakeAccount(brokerJobs)
  const finished = []
  const worker = new SyncBrokerHostWorker({
    accountSyncService: account,
    chatJobService: chatJobs,
    pollIntervalMs: 60_000,
    onConversationJobFinished: (input) => { finished.push(input) },
  })
  worker.running = true
  await worker.pollOnce()
  account.commands.set('job_phone_2', [{ id: 'cmd_0123456789', type: 'cancel', sequence: 1, payload: {} }])
  await worker.pollOnce()
  assert.equal(account.acks[0].acknowledgement.accepted, true)
  assert.equal(chatJobs.calls.cancel.length, 0)
  assert.equal(finished.length, 1)
  assert.equal(finished[0].neverStarted, true)
  assert.equal(finished[0].terminalEvent.type, 'cancelled')
  assert.equal(account.events.at(-1).event.type, 'cancelled')

  const running = { turnId: 'turn-d', status: 'running', provider: 'claude' }
  const document = {
    format: 'ensync-account-conversations', version: 1, projects: [],
    chats: [{ id: 'chat-1', projectId: 'p', subtitle: 'Working', continuation: running, messages: [{ id: 'm-job_phone_2', role: 'user', content: 'x', time: '' }] }],
  }
  const chat = applyBrokeredTurn(document, {
    jobId: 'job_phone_2', conversationId: 'chat-1', messageId: 'm-job_phone_2', neverStarted: true,
    outcome: { type: 'cancelled', message: 'Stopped before it started.' },
  })
  assert.equal(chat.messages[0].deliveryStatus, 'cancelled')
  assert.equal(chat.continuation.turnId, 'turn-d')
  assert.equal(chat.subtitle, 'Working')
  await worker.stop()
})

test('the phone can stop or steer a turn a desktop window started, by job or by workspace', async () => {
  const chatJobs = fakeChatJobs()
  chatJobs.jobs.set('job_desktop_1', { id: 'job_desktop_1', state: 'running', startedAt: STARTED, request: desktopRequest })
  const brokerJobs = [
    { id: 'job_ctl_steer', kind: 'local', request: { control: 'steer', targetJobId: 'job_desktop_1', prompt: 'also update tests', conversationId: 'chat-1' } },
    { id: 'job_ctl_stop', kind: 'local', request: { control: 'cancel', projectPath: '/p', workspaceKey: 'chat:chat-1', conversationId: 'chat-1' } },
  ]
  const account = fakeAccount(brokerJobs)
  const worker = new SyncBrokerHostWorker({ accountSyncService: account, chatJobService: chatJobs, pollIntervalMs: 60_000 })
  worker.running = true
  await worker.pollOnce()
  // Control requests never start a provider run.
  assert.deepEqual(chatJobs.calls.start, [])
  assert.deepEqual(chatJobs.calls.steer, [{ jobId: 'job_desktop_1', input: { idempotencyKey: 'job_ctl_steer', prompt: 'also update tests' } }])
  assert.deepEqual(chatJobs.calls.cancel, ['job_desktop_1'])
  const results = Object.fromEntries(account.events.map((item) => [item.jobId, item.event]))
  assert.equal(results.job_ctl_steer.type, 'completed')
  assert.equal(results.job_ctl_steer.result.steered, true)
  assert.equal(results.job_ctl_stop.result.stopped, true)
  await worker.stop()
})

test('Push now delivers a queued phone message into the running turn instead of waiting', async () => {
  const chatJobs = fakeChatJobs({ busy: () => true })
  chatJobs.jobs.set('job_desktop_1', { id: 'job_desktop_1', state: 'running', startedAt: STARTED, request: desktopRequest })
  const brokerJobs = [phoneJob('job_phone_4')]
  const account = fakeAccount(brokerJobs)
  const finished = []
  const worker = new SyncBrokerHostWorker({
    accountSyncService: account,
    chatJobService: chatJobs,
    pollIntervalMs: 60_000,
    onConversationJobFinished: (input) => { finished.push(input) },
  })
  worker.running = true
  await worker.pollOnce()
  brokerJobs.push({ id: 'job_ctl_push', kind: 'local', request: { control: 'push_queued', targetJobId: 'job_phone_4', conversationId: 'chat-1' } })
  await worker.pollOnce()
  assert.deepEqual(chatJobs.calls.steer, [{ jobId: 'job_desktop_1', input: { idempotencyKey: 'job_phone_4', prompt: 'from phone' } }])
  assert.deepEqual(worker.queuedTurns('chat-1'), [])
  assert.equal(finished[0].transferredTo, 'job_desktop_1')
  const document = {
    format: 'ensync-account-conversations', version: 1, projects: [],
    chats: [{ id: 'chat-1', projectId: 'p', messages: [{ id: 'm-job_phone_4', role: 'user', content: 'from phone', time: '' }] }],
  }
  const chat = applyBrokeredTurn(document, { ...finished[0], outcome: { type: 'completed', result: { response: '' } } })
  assert.equal(chat.messages.length, 1)
  assert.equal(chat.messages[0].steeredInto, 'job_desktop_1')
  assert.equal(chat.messages[0].deliveryStatus, undefined)
  await worker.stop()
})

test('a phone steer of its own running job gets a stable idempotency key', async () => {
  const chatJobs = fakeChatJobs()
  const account = fakeAccount([phoneJob('job_phone_3')])
  const worker = new SyncBrokerHostWorker({ accountSyncService: account, chatJobService: chatJobs, pollIntervalMs: 60_000 })
  worker.running = true
  await worker.pollOnce()
  account.commands.set('job_phone_3', [{ id: 'cmd_abcdef0123', type: 'steer', sequence: 1, payload: { prompt: 'faster' } }])
  await worker.pollOnce()
  assert.deepEqual(chatJobs.calls.steer, [{ jobId: 'job_phone_3', input: { idempotencyKey: 'cmd_abcdef0123', prompt: 'faster' } }])
  await worker.stop()
})

test('delivery status for a conversation is scoped to its branch and bounded', async () => {
  const branch = conversationBranchName('chat:chat-1')
  const status = {
    current: null, production: null, pending: null,
    records: [
      { id: 'd1', state: 'building', landingState: 'landed', deliveryTarget: 'production', sourceBranches: [branch], savedSha: 'a'.repeat(40), description: 'Fix composer', updatedAt: STARTED, deploymentUrl: 'https://x.vercel.app', failureLogAvailable: true, projectPath: '/secret/path' },
      { id: 'd2', state: 'production', sourceBranches: ['ensync/chat-other'], savedSha: 'b'.repeat(40) },
    ],
  }
  const seen = []
  const account = fakeAccount([{ id: 'job_ctl_delivery', kind: 'local', request: { control: 'delivery_status', projectPath: '/p', workspaceKey: 'chat:chat-1' } }])
  const worker = new SyncBrokerHostWorker({
    accountSyncService: account,
    chatJobService: fakeChatJobs(),
    pollIntervalMs: 60_000,
    deliveryStatus: async (projectPath, sourceBranch) => { seen.push([projectPath, sourceBranch]); return status },
  })
  worker.running = true
  await worker.pollOnce()
  assert.deepEqual(seen, [['/p', branch]])
  const delivery = account.events[0].event.result.delivery
  assert.equal(delivery.records.length, 1)
  assert.equal(delivery.records[0].state, 'building')
  assert.equal(delivery.records[0].savedSha, 'aaaaaaaaaaaa')
  assert.doesNotMatch(JSON.stringify(delivery), /secret/)
  assert.equal(summarizeDelivery(null, branch), null)
  await worker.stop()
})

test('the queue mirror is per writer, settles with the transcript, and never conflicts', () => {
  const now = Date.parse('2026-11-09T10:01:00.000Z')
  const base = {
    format: 'ensync-account-conversations', version: 1, projects: [],
    chats: [{ id: 'chat-1', projectId: 'p', messages: [{ id: 'm1', role: 'user', content: 'queued one', time: '' }] }],
  }
  const queued = applyHostQueue(base, { conversationId: 'chat-1', items: [{ messageId: 'm1', jobId: 'job_1', queuedAt: STARTED }], heartbeatAt: '2026-11-09T10:00:30.000Z' })
  assert.deepEqual(activeQueuedTurns(queued, now).map((item) => [item.messageId, item.origin]), [['m1', 'host']])
  // A desktop window that knows nothing of the Host queue merges without dropping it.
  const merged = mergeAccountWorkspace({ chats: [{ ...base.chats[0] }], projects: [] }, prepareAccountWorkspace({ ...base, chats: [queued] }))
  assert.deepEqual(activeQueuedTurns(merged.state.chats[0], now).map((item) => item.messageId), ['m1'])
  // Once the turn ran, the entry is gone everywhere.
  const ran = { ...queued, messages: [...queued.messages, { id: 'a1', role: 'agent', turnId: 'm1', content: 'ok', time: '' }] }
  assert.deepEqual(activeQueuedTurns(prepareAccountWorkspace({ chats: [ran], projects: [] }).chats[0], now), [])
  // A stale block (writer stopped refreshing) is ignored.
  assert.deepEqual(activeQueuedTurns(queued, now + 10 * 60_000), [])
})

test('merging the document back never marks the desktop\'s running prompt interrupted', () => {
  const running = { id: 'u1', role: 'user', turnId: 't1', content: 'go', time: '', deliveryStatus: 'pending' }
  const queuedLocal = { id: 'u2', role: 'user', turnId: 't2', content: 'next', time: '', deliveryStatus: 'queued' }
  const local = { chats: [{ id: 'chat-1', projectId: 'p', messages: [running, queuedLocal] }], projects: [] }
  const remote = prepareAccountWorkspace(local)
  assert.equal(remote.chats[0].messages[0].deliveryStatus, 'interrupted')
  const merged = mergeAccountWorkspace(local, remote).state.chats[0]
  assert.equal(merged.messages[0].deliveryStatus, 'pending')
  assert.equal(merged.messages[1].deliveryStatus, 'queued')
  // A real terminal state from elsewhere still wins.
  const completed = { ...remote, chats: [{ ...remote.chats[0], messages: [{ ...remote.chats[0].messages[0], deliveryStatus: 'completed' }, remote.chats[0].messages[1]] }] }
  assert.equal(mergeAccountWorkspace(local, completed).state.chats[0].messages[0].deliveryStatus, 'completed')
})
