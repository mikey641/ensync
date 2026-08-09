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

  service.start({ jobId: JOB_A, kind: 'local', request: { prompt: 'continue' } })
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

  service.start({ jobId: JOB_A, kind: 'local', request: { provider: 'codex', prompt: 'continue' } })
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

  service.start({ jobId: JOB_A, kind: 'local', request: { which: 'first' } })
  service.start({ jobId: JOB_B, kind: 'local', request: { which: 'second' } })
  await waitFor(() => firstSignal && secondSignal)
  service.cancel(JOB_A)
  await waitFor(() => service.get(JOB_A).state === 'cancelled')

  assert.equal(firstSignal.aborted, true)
  assert.equal(secondSignal.aborted, false)
  assert.equal(service.get(JOB_B).state, 'running')
  service.cancel(JOB_B)
})

test('job starts are idempotent only for the same request', () => {
  const service = new ChatJobService({
    runLocal: async () => new Promise(() => {}),
    runRemote: async () => new Promise(() => {}),
  })
  const input = { jobId: JOB_A, kind: 'local', request: { prompt: 'same' } }

  assert.equal(service.start(input).id, JOB_A)
  assert.equal(service.start(input).id, JOB_A)
  assert.throws(
    () => service.start({ ...input, request: { prompt: 'different' } }),
    (error) => error instanceof ChatJobError && error.code === 'chat_job_conflict',
  )
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

  service.start({ jobId: JOB_A, kind: 'local', request: { provider: 'codex', prompt: 'start' } })
  service.start({ jobId: JOB_B, kind: 'ssh', request: { provider: 'codex', prompt: 'remote' } })
  await waitFor(() => codexStarted)

  assert.equal(service.get(JOB_A).steerable, false)
  await assert.rejects(
    service.steer(JOB_A, { prompt: 'too early' }),
    (error) => error instanceof ChatJobError && error.code === 'live_steer_unavailable' && error.safeToRetry,
  )
  codexSteerReady = true
  assert.equal(service.get(JOB_A).steerable, true)
  assert.equal(service.get(JOB_B).steerable, false)
  assert.deepEqual(await service.steer(JOB_A, { prompt: 'change direction' }), { turnId: 'provider-turn-1' })
  assert.deepEqual(steered, [{ jobId: JOB_A, input: { prompt: 'change direction' } }])
  await assert.rejects(
    service.steer(JOB_B, { prompt: 'cannot steer remote yet' }),
    (error) => error instanceof ChatJobError && error.code === 'live_steer_unavailable' && error.safeToRetry,
  )

  releaseCodex()
  service.cancel(JOB_B)
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
  first.start(input)
  await waitFor(() => first.get(JOB_A).state === 'completed')

  const serialized = await readFile(filePath, 'utf8')
  assert.doesNotMatch(serialized, /private prompt|top-secret-value/)
  assert.match(serialized, /\[REDACTED\]/)

  const restored = new ChatJobService({
    journal: new ChatJobJournal({ filePath }),
    runLocal: async () => { executions += 1 },
    runRemote: async () => { throw new Error('not used') },
  })
  assert.equal(restored.start(input).state, 'completed')
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

  service.start({ jobId: JOB_A, kind: 'local', request: { provider: 'codex', prompt: 'continue' } })
  await waitFor(() => release)
  assert.equal(saves, 2)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(saves, 3)
  release()
  await waitFor(() => service.get(JOB_A).state === 'completed')
  assert.equal(saves, 4)
})
