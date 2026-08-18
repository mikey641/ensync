import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ChatJobJournal, ChatJobJournalInUseError } from './chat-job-journal.mjs'
import { ChatJobError, ChatJobService } from './chat-jobs.mjs'
import { createEnsyncHost } from './server.mjs'

const JOB_A = 'job_1111111111111111'
const JOB_B = 'job_2222222222222222'
const JOB_C = 'job_3333333333333333'

function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve()
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('Timed out waiting for chat job state.'))
      setTimeout(poll, 5)
    }
    poll()
  })
}

test('a detached subscriber can reconnect without cancelling the provider job', async () => {
  let release
  let receivedSignal
  const service = new ChatJobService({
    runLocal: async (_request, options) => {
      receivedSignal = options.signal
      options.onEvent({
        type: 'started', provider: 'codex', cwd: '/project', command: 'codex exec -', at: '2026-08-07T10:00:00.000Z',
      })
      await new Promise((resolve) => { release = resolve })
      return { provider: 'codex', response: 'done', completedAt: '2026-08-07T10:00:03.000Z' }
    },
    runRemote: async () => { throw new Error('not used') },
    now: (() => {
      const values = ['2026-08-07T10:00:00.000Z', '2026-08-07T10:00:03.000Z']
      return () => values.shift() ?? '2026-08-07T10:00:03.000Z'
    })(),
  })

  await service.start({ jobId: JOB_A, kind: 'local', request: { prompt: 'continue' } })
  const firstEvents = []
  const detach = service.subscribe(JOB_A, { onEvent: (event) => firstEvents.push(event), onEnd() {} })
  await waitFor(() => firstEvents.some((event) => event.type === 'started'))
  assert.equal(detach(), true)
  assert.equal(receivedSignal.aborted, false)

  release()
  await waitFor(() => service.get(JOB_A).state === 'completed')
  const recoveredEvents = []
  let ended = false
  service.subscribe(JOB_A, {
    afterSequence: 0,
    onEvent: (event) => recoveredEvents.push(event),
    onEnd: () => { ended = true },
  })

  assert.equal(ended, true)
  assert.deepEqual(recoveredEvents.map((event) => event.type), ['started', 'completed'])
  assert.deepEqual(recoveredEvents.map((event) => event.sequence), [1, 2])
  assert.equal(service.get(JOB_A).providerProcessStarted, true)
})

test('a repaired provider stream is reported as recovery instead of a chat error', async () => {
  const service = new ChatJobService({
    runLocal: async () => ({
      provider: 'codex',
      response: 'done',
      completedAt: '2026-08-07T10:00:03.000Z',
      outputRecovery: { applied: true, normalizedLineCount: 1, discardedLineCount: 1 },
    }),
    runRemote: async () => { throw new Error('not used') },
  })

  await service.start({ jobId: JOB_A, kind: 'local', request: { provider: 'codex', prompt: 'continue' } })
  await waitFor(() => service.get(JOB_A).state === 'completed')
  const events = []
  service.subscribe(JOB_A, { onEvent: (event) => events.push(event), onEnd() {} })

  assert.deepEqual(events.map((event) => event.type), ['notice', 'completed'])
  assert.match(events[0].message, /automatically repaired 2 malformed provider output lines/i)
})

test('only explicit cancellation aborts the exact retained job', async () => {
  let firstSignal
  let secondSignal
  const run = (capture) => async (_request, options) => {
    capture(options.signal)
    await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
    const error = new Error('stopped')
    error.code = 'run_cancelled'
    error.status = 499
    throw error
  }
  const service = new ChatJobService({
    runLocal: async (request, options) => request.which === 'first'
      ? run((signal) => { firstSignal = signal })(request, options)
      : run((signal) => { secondSignal = signal })(request, options),
    runRemote: async () => { throw new Error('not used') },
  })

  await service.start({ jobId: JOB_A, kind: 'local', request: { which: 'first' } })
  await service.start({ jobId: JOB_B, kind: 'local', request: { which: 'second' } })
  await waitFor(() => firstSignal && secondSignal)
  service.cancel(JOB_A)
  await waitFor(() => service.get(JOB_A).state === 'cancelled')

  assert.equal(firstSignal.aborted, true)
  assert.equal(secondSignal.aborted, false)
  assert.equal(service.get(JOB_B).state, 'running')
  service.cancel(JOB_B)
})

test('admission dispositions reconnect an identical job and refuse an occupied workspace', async () => {
  let releaseRun
  const localRuns = []
  const persisted = []
  const lease = {
    workspace: { projectPath: '/protected-project', branch: 'ensync/chat-a' },
    signal: new AbortController().signal,
    assertHeld() {},
    updateOwner() {},
    async release() {},
  }
  const service = new ChatJobService({
    admit: async (input, owner) => input.jobId === JOB_A
      ? { disposition: 'acquired', lease }
      : {
          disposition: 'occupied',
          owner: {
            jobId: JOB_A, provider: 'codex', targetKind: 'local',
            startedAt: owner.startedAt, providerProcessStarted: false,
            steerable: false, nativeWorkspaceId: null,
          },
        },
    journal: { load: () => [], save: (jobs) => persisted.push(jobs) },
    runLocal: async (_request, options) => {
      localRuns.push(options)
      await new Promise((resolve) => { releaseRun = resolve })
      return { provider: 'codex', response: 'done' }
    },
    runRemote: async () => { throw new Error('not used') },
  })
  const firstInput = {
    jobId: JOB_A,
    kind: 'local',
    request: { provider: 'codex', prompt: 'continue', projectPath: '/project', workspaceKey: 'workspace:chat-a' },
    navigation: { nativeWorkspaceId: null, projectId: 'project-a', chatId: 'chat-a' },
  }
  const secondInput = { ...firstInput, jobId: JOB_B }

  assert.equal((await service.start(firstInput)).disposition, 'started')
  assert.equal((await service.start(firstInput)).disposition, 'reconnected')
  const occupied = await service.start(secondInput)
  assert.equal(occupied.disposition, 'occupied')
  await waitFor(() => localRuns.length === 1)
  assert.equal(localRuns[0].preAcquiredWorkspaceLease, lease)
  assert.throws(() => service.get(JOB_B), { code: 'chat_job_not_found' })
  assert.equal(persisted[0].length, 1)
  assert.equal(persisted[0][0].id, JOB_A)

  releaseRun()
  await waitFor(() => service.get(JOB_A).state === 'completed')
})

test('turn navigation stays live-only and is returned only for an occupied job retained by this Host', async () => {
  let releaseRun
  let providerRequest
  let providerOptions
  const journalWrites = []
  const service = new ChatJobService({
    admit: async (input) => input.jobId === JOB_A
      ? { disposition: 'acquired', lease: null }
      : {
          disposition: 'occupied',
          owner: {
            jobId: input.jobId === JOB_B ? JOB_A : 'job_other_host_00000001',
            provider: 'codex',
            targetKind: 'local',
            startedAt: '2026-08-07T10:00:00.000Z',
            providerProcessStarted: true,
            steerable: true,
            nativeWorkspaceId: null,
            turnId: 'must-not-trust-cross-host-owner-data',
          },
        },
    journal: { load: () => [], save: (jobs) => journalWrites.push(structuredClone(jobs)) },
    runLocal: async (request, options) => {
      providerRequest = request
      providerOptions = options
      await new Promise((resolve) => { releaseRun = resolve })
      return { provider: 'codex', response: 'done' }
    },
    runRemote: async () => { throw new Error('not used') },
  })
  const input = {
    jobId: JOB_A,
    kind: 'local',
    request: { provider: 'codex', prompt: 'private provider request' },
    navigation: {
      nativeWorkspaceId: 'workspace-native-a',
      projectId: 'project-a',
      chatId: 'chat-a',
      turnId: 'turn-owner-a',
    },
  }

  assert.equal((await service.start(input)).disposition, 'started')
  assert.equal((await service.start({
    ...input,
    navigation: { ...input.navigation, turnId: 'presentation-data-does-not-change-the-request-hash' },
  })).disposition, 'reconnected')
  const sameHost = await service.start({ ...input, jobId: JOB_B })
  const crossHost = await service.start({ ...input, jobId: JOB_C })
  await waitFor(() => releaseRun)

  assert.equal(sameHost.disposition, 'occupied')
  assert.equal(sameHost.owner.turnId, 'turn-owner-a')
  assert.equal(crossHost.disposition, 'occupied')
  assert.equal(crossHost.owner.turnId, null)
  assert.deepEqual(providerRequest, input.request)
  assert.equal('navigation' in providerOptions, false)
  assert.equal(JSON.stringify(journalWrites).includes('turn-owner-a'), false)

  releaseRun()
  await waitFor(() => service.get(JOB_A).state === 'completed')
})

async function loadRelayHostModule() {
  const typescript = await import('typescript')
  const relayHostPath = new URL('../src/lib/relayHost.ts', import.meta.url)
  const source = await readFile(relayHostPath, 'utf8')
  let javascript = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ESNext,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
  for (const dependency of ['ndjsonStream.mjs', 'chatJobReconnect.mjs', 'jsonResponse.mjs']) {
    javascript = javascript.replace(
      `./${dependency}`,
      new URL(dependency, new URL('../src/lib/', import.meta.url)).href,
    )
  }
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

test('runChatJob serializes its optional navigation beside the provider request', async () => {
  const relayHost = await loadRelayHostModule()
  const originalFetch = globalThis.fetch
  let submitted
  globalThis.fetch = async (_url, init) => {
    submitted = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      disposition: 'occupied',
      owner: {
        jobId: JOB_A,
        provider: 'codex',
        targetKind: 'local',
        startedAt: '2026-08-07T10:00:00.000Z',
        providerProcessStarted: true,
        steerable: true,
        nativeWorkspaceId: 'workspace-native-a',
        turnId: 'turn-owner-a',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const navigation = {
      nativeWorkspaceId: 'workspace-native-a',
      projectId: 'project-a',
      chatId: 'chat-a',
      turnId: 'turn-owner-a',
    }
    const client = new relayHost.EnsyncHostClient('http://host.test/api')
    await assert.rejects(
      client.runChatJob(JOB_A, 'local', { prompt: 'provider-only' }, () => {}, undefined, navigation),
      relayHost.ChatJobOccupiedError,
    )
    assert.deepEqual(submitted, {
      jobId: JOB_A,
      kind: 'local',
      request: { prompt: 'provider-only' },
      navigation,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a verified quota failure ends the turn instead of reattaching the finished job forever', async () => {
  const relayHost = await loadRelayHostModule()
  const originalFetch = globalThis.fetch
  const failure = {
    type: 'error',
    error: 'Claude Code reported a quota, rate-limit, or capacity failure before any tool activity.',
    code: 'provider_quota',
    status: 429,
    safeToRetry: true,
    at: '2026-08-07T10:03:12.000Z',
    sequence: 2,
  }
  let streamAttempts = 0
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.endsWith('/chat/jobs')) {
      return new Response(JSON.stringify({ disposition: 'started', job: { id: JOB_A, state: 'running' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (!target.includes('/stream')) throw new Error(`Unexpected Host request: ${target}`)
    streamAttempts += 1
    if (streamAttempts === 1) {
      return new Response(`${JSON.stringify(failure)}\n`, {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      })
    }
    // Only a wedged client asks again. Refuse in a way it cannot loop on, so
    // the reattach bug fails this test instead of hanging it.
    return new Response(
      JSON.stringify({ error: 'That chat job is no longer available.', code: 'chat_job_not_found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )
  }
  try {
    const client = new relayHost.EnsyncHostClient('http://host.test/api')
    const events = []
    await assert.rejects(
      client.runChatJob(JOB_A, 'local', { provider: 'claude', prompt: 'continue' }, (event) => events.push(event)),
      (error) => error instanceof relayHost.EnsyncHostError
        && error.code === 'provider_quota'
        && error.safeToRetry === true
        && error.terminal === true,
    )
    assert.equal(streamAttempts, 1)
    assert.deepEqual(
      events.map((event) => [event.type, event.outcome, event.code]),
      [['finished', 'failed', 'provider_quota']],
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('job starts are idempotent only for the same request', async () => {
  const service = new ChatJobService({
    runLocal: async () => new Promise(() => {}),
    runRemote: async () => new Promise(() => {}),
  })
  const input = { jobId: JOB_A, kind: 'local', request: { prompt: 'same' } }

  assert.equal((await service.start(input)).job.id, JOB_A)
  assert.equal((await service.start(input)).job.id, JOB_A)
  await assert.rejects(
    service.start({ ...input, request: { prompt: 'different' } }),
    (error) => error instanceof ChatJobError && error.code === 'chat_job_conflict',
  )
})

test('a pending admission reserves capacity and reports the Host as busy', async () => {
  let resolveFirstAdmission
  let admissionCalls = 0
  let providerRuns = 0
  const service = new ChatJobService({
    maxJobs: 1,
    admit: async (input) => {
      admissionCalls += 1
      if (input.jobId === JOB_A) {
        return new Promise((resolve) => { resolveFirstAdmission = resolve })
      }
      return { disposition: 'acquired', lease: null }
    },
    runLocal: async (_request, options) => {
      providerRuns += 1
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
      return { provider: 'codex', response: 'stopped' }
    },
    runRemote: async () => { throw new Error('not used') },
  })
  const first = service.start({ jobId: JOB_A, kind: 'local', request: { prompt: 'first' } })
  await waitFor(() => resolveFirstAdmission)
  const busyWhilePending = service.hasRunningJobs()
  let capacityError = null
  try {
    await service.start({ jobId: JOB_B, kind: 'local', request: { prompt: 'second' } })
  } catch (error) {
    capacityError = error
  } finally {
    resolveFirstAdmission({
      disposition: 'occupied',
      owner: { jobId: 'job_other_host_00000001' },
    })
    await first
    try {
      if (service.get(JOB_B).state === 'running') service.cancel(JOB_B)
    } catch {
      // The capacity-safe path never registers JOB_B.
    }
  }

  assert.equal(busyWhilePending, true)
  assert.equal(capacityError?.code, 'chat_job_capacity')
  assert.equal(admissionCalls, 1)
  assert.equal(providerRuns, 0)
  assert.equal(service.hasRunningJobs(), false)
})

test('shutdown fences a pending admission, releases its acquired lease, and rejects later starts', async () => {
  let resolveAdmission
  let shutdownSettled = false
  let providerRuns = 0
  let releases = 0
  let admissions = 0
  const lease = { async release() { releases += 1 } }
  const service = new ChatJobService({
    admit: async () => {
      admissions += 1
      return admissions === 1
        ? new Promise((resolve) => { resolveAdmission = resolve })
        : { disposition: 'acquired', lease: null }
    },
    runLocal: async (_request, options) => {
      providerRuns += 1
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
      return { provider: 'codex', response: 'stopped' }
    },
    runRemote: async () => { throw new Error('not used') },
  })
  const starting = service.start({ jobId: JOB_A, kind: 'local', request: { prompt: 'pending' } })
  await waitFor(() => resolveAdmission)
  const busyWhilePending = service.hasRunningJobs()
  const shutdown = service.shutdown().then(() => { shutdownSettled = true })
  await new Promise((resolve) => setImmediate(resolve))
  const settledBeforeAdmission = shutdownSettled
  resolveAdmission({ disposition: 'acquired', lease })

  let startError = null
  try {
    await starting
  } catch (error) {
    startError = error
  }
  if (!startError) {
    try { service.cancel(JOB_A) } catch {
      // The shutdown-safe path never registers JOB_A.
    }
  }
  await shutdown

  let laterError = null
  try {
    await service.start({ jobId: JOB_B, kind: 'local', request: { prompt: 'too late' } })
  } catch (error) {
    laterError = error
  }
  if (!laterError) {
    try { service.cancel(JOB_B) } catch {
      // The shutdown fence rejects JOB_B before registration.
    }
  }

  assert.equal(busyWhilePending, true)
  assert.equal(settledBeforeAdmission, false)
  assert.equal(startError?.code, 'chat_job_shutting_down')
  assert.equal(laterError?.code, 'chat_job_shutting_down')
  assert.equal(providerRuns, 0)
  assert.equal(releases, 1)
  assert.equal(service.hasRunningJobs(), false)
})

test('a running local Codex job accepts steering while unsupported jobs reject it safely', async () => {
  let releaseCodex
  let codexStarted = false
  let codexSteerReady = false
  const steered = []
  const service = new ChatJobService({
    runLocal: async (_request, options) => {
      codexStarted = options.liveTurnId === JOB_A
      await new Promise((resolve) => { releaseCodex = resolve })
      return { provider: 'codex', response: 'done' }
    },
    runRemote: async () => new Promise(() => {}),
    steerLocal: async (jobId, input) => {
      steered.push({ jobId, input })
      return { turnId: 'provider-turn-1' }
    },
    canSteerLocal: (jobId) => codexSteerReady && jobId === JOB_A,
  })

  await service.start({ jobId: JOB_A, kind: 'local', request: { provider: 'codex', prompt: 'start' } })
  await service.start({ jobId: JOB_B, kind: 'ssh', request: { provider: 'codex', prompt: 'remote' } })
  await waitFor(() => codexStarted)

  assert.equal(service.get(JOB_A).steerable, false)
  await assert.rejects(
    service.steer(JOB_A, { idempotencyKey: 'entry_111111111111', prompt: 'too early' }),
    (error) => error instanceof ChatJobError && error.code === 'live_steer_unavailable' && error.safeToRetry,
  )
  codexSteerReady = true
  assert.equal(service.get(JOB_A).steerable, true)
  assert.equal(service.get(JOB_B).steerable, false)
  assert.deepEqual(await service.steer(JOB_A, { idempotencyKey: 'entry_222222222222', prompt: 'change direction' }), { turnId: 'provider-turn-1' })
  assert.deepEqual(steered, [{ jobId: JOB_A, input: { prompt: 'change direction' } }])
  await assert.rejects(
    service.steer(JOB_B, { idempotencyKey: 'entry_333333333333', prompt: 'cannot steer remote yet' }),
    (error) => error instanceof ChatJobError && error.code === 'live_steer_unavailable' && error.safeToRetry,
  )

  releaseCodex()
  service.cancel(JOB_B)
})

test('live steer ready and closed events update the retained lease owner immediately', async () => {
  let releaseRun
  let emittedClosed = false
  let releases = 0
  const ownerUpdates = []
  const lease = {
    updateOwner(patch) { ownerUpdates.push(structuredClone(patch)) },
    async release() { releases += 1 },
  }
  const service = new ChatJobService({
    admit: async () => ({ disposition: 'acquired', lease }),
    runLocal: async (_request, options) => {
      options.onEvent({ type: 'started', provider: 'codex', at: '2026-08-07T10:00:00.000Z' })
      options.onEvent({ type: 'notice', code: 'live_steer_ready', at: '2026-08-07T10:00:01.000Z' })
      options.onEvent({ type: 'notice', code: 'live_steer_closed', at: '2026-08-07T10:00:02.000Z' })
      emittedClosed = true
      await new Promise((resolve) => { releaseRun = resolve })
      return { provider: 'codex', response: 'done' }
    },
    runRemote: async () => { throw new Error('not used') },
    canSteerLocal: () => false,
  })

  await service.start({ jobId: JOB_A, kind: 'local', request: { provider: 'codex', prompt: 'continue' } })
  await waitFor(() => emittedClosed)
  assert.deepEqual(ownerUpdates, [
    { providerProcessStarted: false, steerable: false },
    { providerProcessStarted: true },
    { steerable: true },
    { steerable: false },
  ])

  releaseRun()
  await waitFor(() => releases === 1)
  assert.deepEqual(ownerUpdates.at(-1), { steerable: false })
})

test('steering idempotency joins and replays one retained delivery outcome', async () => {
  let releaseRun
  let resolveDelivery
  const deliveries = []
  const service = new ChatJobService({
    runLocal: async () => new Promise((resolve) => { releaseRun = resolve }),
    runRemote: async () => { throw new Error('not used') },
    canSteerLocal: () => true,
    steerLocal: async (jobId, input) => {
      deliveries.push({ jobId, input })
      return new Promise((resolve) => { resolveDelivery = resolve })
    },
  })
  await service.start({ jobId: JOB_A, kind: 'local', request: { provider: 'codex', prompt: 'start' } })
  await waitFor(() => releaseRun)
  const input = { idempotencyKey: 'entry_111111111111', prompt: 'change direction', attachments: ['/private/a.png'] }
  const first = service.steer(JOB_A, input)
  const second = service.steer(JOB_A, { ...input, attachments: ['/private/a.png'] })
  await waitFor(() => deliveries.length === 1)
  resolveDelivery({ turnId: 'provider-turn-1' })
  assert.deepEqual(await first, { turnId: 'provider-turn-1' })
  assert.deepEqual(await second, { turnId: 'provider-turn-1' })
  assert.deepEqual(await service.steer(JOB_A, input), { turnId: 'provider-turn-1' })
  assert.equal(deliveries.length, 1)
  await assert.rejects(
    service.steer(JOB_A, { ...input, prompt: 'different instruction' }),
    (error) => error instanceof ChatJobError && error.code === 'live_steer_conflict' && error.status === 409,
  )
  await assert.rejects(
    service.steer(JOB_A, { ...input, attachments: ['/private/other.png'] }),
    (error) => error instanceof ChatJobError && error.code === 'live_steer_conflict' && error.status === 409,
  )

  const ambiguous = { idempotencyKey: 'entry_222222222222', prompt: 'ambiguous delivery' }
  let rejectAmbiguous
  const ambiguousService = new ChatJobService({
    runLocal: async () => new Promise(() => {}),
    runRemote: async () => { throw new Error('not used') },
    canSteerLocal: () => true,
    steerLocal: async () => new Promise((_resolve, reject) => { rejectAmbiguous = reject }),
  })
  await ambiguousService.start({ jobId: JOB_B, kind: 'local', request: { provider: 'codex', prompt: 'start' } })
  const firstAmbiguous = ambiguousService.steer(JOB_B, ambiguous)
  await waitFor(() => rejectAmbiguous)
  const ambiguousError = new ChatJobError('live_steer_ambiguous', 'Delivery outcome is unknown.', 502, false)
  rejectAmbiguous(ambiguousError)
  await assert.rejects(firstAmbiguous, (error) => error === ambiguousError)
  await assert.rejects(
    ambiguousService.steer(JOB_B, ambiguous),
    (error) => error === ambiguousError,
  )
  releaseRun({ provider: 'codex', response: 'done' })
})

test('the HTTP stream can disconnect and later recover the same Host-owned job', async (context) => {
  let release
  let providerSignal
  const service = new ChatJobService({
    runLocal: async (_request, options) => {
      providerSignal = options.signal
      options.onEvent({
        type: 'started', provider: 'codex', cwd: '/project', command: 'codex exec -', at: '2026-08-07T10:00:00.000Z',
      })
      await new Promise((resolve) => { release = resolve })
      return {
        provider: 'codex', projectPath: '/project', response: 'recovered', sessionId: 'session-a',
        model: null, requestedModel: null, requestedEffort: null, usage: null, durationMs: 10,
        completedAt: '2026-08-07T10:00:03.000Z',
      }
    },
    runRemote: async () => { throw new Error('not used') },
  })
  const server = createEnsyncHost({ chatJobService: service })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`

  const start = await fetch(`${baseUrl}/api/chat/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: JOB_A, kind: 'local', request: { prompt: 'continue' } }),
  })
  assert.equal(start.status, 202)

  const detached = new AbortController()
  const firstStream = await fetch(`${baseUrl}/api/chat/jobs/${JOB_A}/stream`, { signal: detached.signal })
  const reader = firstStream.body.getReader()
  await reader.read()
  detached.abort()
  await reader.cancel().catch(() => {})
  await waitFor(() => providerSignal)
  assert.equal(providerSignal.aborted, false)

  release()
  await waitFor(() => service.get(JOB_A).state === 'completed')
  const recovered = await fetch(`${baseUrl}/api/chat/jobs/${JOB_A}/stream?after=0`)
  const events = (await recovered.text()).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(events.map((event) => event.type), ['started', 'completed'])
  assert.equal(events.at(-1).result.response, 'recovered')
})

test('the durable journal prevents duplicate execution and never stores prompts or raw secrets', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-chat-journal-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'jobs.json')
  let executions = 0
  const input = {
    jobId: JOB_A,
    kind: 'local',
    request: { prompt: 'private prompt must not be journaled', provider: 'codex' },
  }
  const first = new ChatJobService({
    journal: new ChatJobJournal({ filePath }),
    runLocal: async () => {
      executions += 1
      return {
        provider: 'codex', response: 'authorization=top-secret-value', sessionId: null,
        completedAt: '2026-08-07T10:00:03.000Z',
      }
    },
    runRemote: async () => { throw new Error('not used') },
  })
  await first.start(input)
  await waitFor(() => first.get(JOB_A).state === 'completed')

  const serialized = await readFile(filePath, 'utf8')
  assert.doesNotMatch(serialized, /private prompt|top-secret-value/)
  assert.match(serialized, /\[REDACTED\]/)

  const restored = new ChatJobService({
    journal: new ChatJobJournal({ filePath }),
    runLocal: async () => { executions += 1 },
    runRemote: async () => { throw new Error('not used') },
  })
  assert.equal((await restored.start(input)).job.state, 'completed')
  assert.equal(executions, 1)
  const events = []
  restored.subscribe(JOB_A, { onEvent: (event) => events.push(event), onEnd() {} })
  assert.equal(events.at(-1).type, 'completed')
  assert.equal(events.at(-1).result.response, 'authorization=[REDACTED]')
})

test('a Host restart reconciles a journaled running job instead of replaying it', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-chat-orphan-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'jobs.json')
  const journal = new ChatJobJournal({ filePath })
  journal.save([{
    id: JOB_A,
    kind: 'local',
    requestHash: '7bf3c781e21d7c80d1a3a4f3dadaf2b80cf8a5c124e40fb16a0c89b91f02d935',
    state: 'running',
    startedAt: '2026-08-07T10:00:00.000Z',
    finishedAt: null,
    providerProcessStarted: true,
    sequence: 1,
    events: [{ type: 'started', sequence: 1, at: '2026-08-07T10:00:00.000Z' }],
  }])
  let executions = 0
  const restored = new ChatJobService({
    journal: new ChatJobJournal({ filePath }),
    runLocal: async () => { executions += 1 },
    runRemote: async () => { throw new Error('not used') },
  })
  assert.equal(restored.get(JOB_A).state, 'failed')
  const events = []
  restored.subscribe(JOB_A, { onEvent: (event) => events.push(event), onEnd() {} })
  assert.equal(events.at(-1).code, 'host_job_orphaned')
  assert.equal(events.at(-1).safeToRetry, false)
  assert.equal(executions, 0)
})

test('a second live Host cannot reconcile or overwrite the first Host journal', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-chat-journal-fence-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'jobs.json')
  const first = new ChatJobJournal({
    filePath,
    writer: { instanceId: 'host-a', pid: process.pid },
  })
  first.save([])

  const competing = new ChatJobJournal({
    filePath,
    writer: { instanceId: 'host-b', pid: process.pid },
  })
  assert.throws(() => competing.load(), ChatJobJournalInUseError)
  assert.throws(() => competing.save([]), ChatJobJournalInUseError)
})

test('frequent live output checkpoints are batched while terminal events remain durable', async () => {
  let release
  let saves = 0
  const journal = {
    load: () => [],
    save: () => { saves += 1 },
  }
  const service = new ChatJobService({
    journal,
    runLocal: async (_request, options) => {
      options.onEvent({ type: 'started', at: new Date().toISOString() })
      for (let index = 0; index < 100; index += 1) {
        options.onEvent({ type: 'output', text: `chunk-${index}`, at: new Date().toISOString() })
      }
      await new Promise((resolve) => { release = resolve })
      return { provider: 'codex', response: 'done' }
    },
    runRemote: async () => { throw new Error('not used') },
  })

  await service.start({ jobId: JOB_A, kind: 'local', request: { provider: 'codex', prompt: 'continue' } })
  await waitFor(() => release)
  assert.equal(saves, 2)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(saves, 3)
  release()
  await waitFor(() => service.get(JOB_A).state === 'completed')
  assert.equal(saves, 4)
})
