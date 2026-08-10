import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { CodexLiveTurnRunner } from './codex-live-turn.mjs'

function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve()
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('Timed out waiting for Codex protocol state.'))
      setTimeout(poll, 5)
    }
    poll()
  })
}

function fakeCodexAppServer(options = {}) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  const requests = []
  let inputBuffer = ''
  let turnActivated = false
  const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`)
  const activateTurn = () => {
    if (turnActivated) return
    turnActivated = true
    const turn = { id: '01900000-0000-7000-8000-000000000002', items: [], status: 'inProgress' }
    send({ method: 'turn/started', params: { threadId: '01900000-0000-7000-8000-000000000001', turn } })
  }

  child.stdin.on('data', (chunk) => {
    inputBuffer += chunk.toString('utf8')
    const lines = inputBuffer.split('\n')
    inputBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      requests.push(message)
      if (message.method === 'initialize') {
        send({ id: message.id, result: { userAgent: 'codex-test', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' } })
      } else if (message.method === 'thread/start') {
        send({ id: message.id, result: { thread: { id: '01900000-0000-7000-8000-000000000001' }, model: 'gpt-test' } })
      } else if (message.method === 'turn/start') {
        if (options.activateForeignTurnBeforeResponse) {
          turnActivated = true
          send({
            method: 'turn/started',
            params: {
              threadId: '01900000-0000-7000-8000-000000000001',
              turn: { id: '01900000-0000-7000-8000-0000000000aa', items: [], status: 'inProgress' },
            },
          })
        }
        const turn = { id: '01900000-0000-7000-8000-000000000002', items: [], status: 'inProgress' }
        send({ id: message.id, result: { turn } })
        if (!options.deferTurnStarted) activateTurn()
      } else if (message.method === 'turn/steer') {
        if (!turnActivated) {
          send({ id: message.id, error: { code: -32602, message: 'no active turn to steer' } })
          continue
        }
        send({ id: message.id, result: { turnId: '01900000-0000-7000-8000-000000000002' } })
        send({
          method: 'item/started',
          params: {
            threadId: '01900000-0000-7000-8000-000000000001',
            turnId: '01900000-0000-7000-8000-000000000002',
            item: { type: 'agentMessage', id: 'note-1', text: '', phase: 'commentary' },
          },
        })
        send({
          method: 'item/completed',
          params: {
            threadId: '01900000-0000-7000-8000-000000000001',
            turnId: '01900000-0000-7000-8000-000000000002',
            item: { type: 'agentMessage', id: 'note-1', text: 'Checking the compact layout.', phase: null },
          },
        })
        send({
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: '01900000-0000-7000-8000-000000000001',
            turnId: '01900000-0000-7000-8000-000000000002',
            tokenUsage: { last: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 } },
          },
        })
        send({
          method: 'item/completed',
          params: {
            threadId: '01900000-0000-7000-8000-000000000001',
            turnId: '01900000-0000-7000-8000-000000000002',
            item: { type: 'agentMessage', id: 'agent-1', text: 'Applied the correction.', phase: 'final_answer' },
          },
        })
        if (options.emitChildNotificationsDuringSteer) {
          send({
            method: 'item/completed',
            params: {
              threadId: '01900000-0000-7000-8000-000000000003',
              turnId: '01900000-0000-7000-8000-000000000004',
              item: { type: 'agentMessage', id: 'child-final', text: 'Child-only final answer.', phase: 'final_answer' },
            },
          })
          send({
            method: 'thread/tokenUsage/updated',
            params: {
              threadId: '01900000-0000-7000-8000-000000000003',
              turnId: '01900000-0000-7000-8000-000000000004',
              tokenUsage: { last: { inputTokens: 900, outputTokens: 800, cachedInputTokens: 700 } },
            },
          })
        }
        send({
          method: 'turn/completed',
          params: {
            threadId: '01900000-0000-7000-8000-000000000001',
            turn: {
              id: '01900000-0000-7000-8000-000000000002',
              items: [],
              status: 'completed',
              error: null,
            },
          },
        })
      }
    }
  })
  child.stdin.on('finish', () => {
    child.exitCode = 0
    queueMicrotask(() => child.emit('close', 0, null))
  })
  child.kill = (signal = 'SIGTERM') => {
    child.signalCode = signal
    queueMicrotask(() => child.emit('close', null, signal))
    return true
  }
  queueMicrotask(() => child.emit('spawn'))
  return { child, requests, send }
}

test('Codex live turns accept a steering instruction before one verified completion', async () => {
  const fake = fakeCodexAppServer()
  const events = []
  const runner = new CodexLiveTurnRunner({
    spawnProcess: () => fake.child,
    inactivityTimeoutMs: 5_000,
    hardTimeoutMs: 5_000,
  })
  const run = runner.run({
    id: 'job_1111111111111111',
    executable: '/usr/local/bin/codex',
    projectPath: '/project',
    prompt: 'Build the feature',
    attachmentPaths: [],
    sessionId: null,
    model: null,
    effort: 'high',
    env: { PATH: '/usr/bin' },
  }, { onEvent: (event) => events.push(event) })

  fake.child.stdout.write('Codex app-server startup diagnostic\n')

  await waitFor(() => fake.requests.some((request) => request.method === 'turn/start'))
  const delivery = await runner.steer('job_1111111111111111', 'Use the compact layout', [])
  const result = await run

  assert.equal(delivery.turnId, '01900000-0000-7000-8000-000000000002')
  assert.equal(result.response, 'Applied the correction.')
  assert.equal(result.sessionId, '01900000-0000-7000-8000-000000000001')
  assert.equal(result.model, 'gpt-test')
  assert.deepEqual(result.usage, {
    source: 'cli', inputTokens: 12, outputTokens: 4, cachedInputTokens: 3,
  })
  assert.deepEqual(result.outputRecovery, {
    applied: true, normalizedLineCount: 0, discardedLineCount: 1,
  })
  assert.equal(
    fake.requests.find((request) => request.method === 'turn/steer').params.input[0].text,
    'Use the compact layout',
  )
  assert.ok(events.some((event) => event.type === 'notice' && event.message.includes('delivered')))
  assert.deepEqual(
    events.find((event) => event.type === 'note'),
    {
      type: 'note',
      provider: 'codex',
      text: 'Checking the compact layout.',
      redacted: false,
      at: events.find((event) => event.type === 'note').at,
    },
  )
})

test('steering a missing live turn is explicitly safe to fall back to FIFO', async () => {
  const runner = new CodexLiveTurnRunner()
  await assert.rejects(
    runner.steer('job_2222222222222222', 'Follow up', []),
    (error) => error.code === 'live_steer_unavailable' && error.safeToRetry === true,
  )
})

test('an app-server stream beyond the repair bound is never replayable', async () => {
  const fake = fakeCodexAppServer()
  const runner = new CodexLiveTurnRunner({
    spawnProcess: () => fake.child,
    inactivityTimeoutMs: 5_000,
    hardTimeoutMs: 5_000,
  })
  const run = runner.run({
    id: 'job_3333333333333333',
    executable: '/usr/local/bin/codex',
    projectPath: '/project',
    prompt: 'Build the feature',
    attachmentPaths: [],
    sessionId: null,
    model: null,
    effort: null,
    env: { PATH: '/usr/bin' },
  })

  await waitFor(() => fake.requests.some((request) => request.method === 'turn/start'))
  for (let index = 0; index < 33; index += 1) {
    fake.child.stdout.write(`unverified diagnostic ${index}\n`)
  }

  await assert.rejects(
    run,
    (error) => error.code === 'invalid_cli_output' && error.safeToRetry === false,
  )
})
