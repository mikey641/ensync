import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  DROID_AUTONOMY_LEVEL,
  DroidExecRunner,
  droidRequestEnvelope,
  droidSessionArguments,
  droidTurnProvesNoActivity,
} from './droid-exec.mjs'

const SESSION_ID = '05fff43e-686d-4c7c-9932-705556882455'

function notification(notificationBody, sessionId = SESSION_ID) {
  return {
    jsonrpc: '2.0',
    type: 'notification',
    factoryApiVersion: '1.0.0',
    factoryProtocolVersion: '1.154.0',
    method: 'droid.session_notification',
    params: { sessionId, notification: notificationBody },
  }
}

function assistantMessage(text, id = 'assistant-1') {
  return {
    type: 'create_message',
    message: {
      id,
      role: 'assistant',
      content: [{ type: 'text', text }],
      modelId: 'claude-opus-5',
      reasoningEffort: 'high',
      createdAt: 1,
      updatedAt: 1,
    },
  }
}

function turnCompleted(reason = 'completed') {
  return {
    type: 'agent_turn_completed',
    reason,
    turnId: 'turn-1',
    tokenUsage: {
      inputTokens: 2,
      outputTokens: 4,
      cacheCreationTokens: 3202,
      cacheReadTokens: 14007,
      thinkingTokens: 0,
      factoryCredits: 10851,
    },
    durationMs: 2445,
  }
}

/**
 * Speaks the wire protocol verified against droid 0.190.0: a line-delimited
 * JSON-RPC stream whose requests carry `type: "request"`, a string `id`, and a
 * `factoryApiVersion` of "1.0.0".
 */
function fakeDroidExec(options = {}) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    child.exitCode = 0
    return true
  }

  const requests = []
  const appliedAutonomy = options.appliedAutonomyLevel ?? DROID_AUTONOMY_LEVEL
  const settings = {
    modelId: 'claude-opus-5',
    reasoningEffort: 'high',
    autonomyMode: 'normal',
    interactionMode: 'auto',
    autonomyLevel: appliedAutonomy,
  }
  const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`)
  const respond = (id, result) => send({
    jsonrpc: '2.0',
    type: 'response',
    factoryApiVersion: '1.0.0',
    id,
    result,
  })

  let buffer = ''
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      requests.push(message)
      if (message.type !== 'request') continue

      if (message.method === 'droid.initialize_session' || message.method === 'droid.load_session') {
        send(notification({ type: 'settings_updated', settings }))
        respond(message.id, { sessionId: SESSION_ID, hostId: 'host-1', session: { messages: [] }, settings })
      } else if (message.method === 'droid.update_session_settings') {
        send(notification({ type: 'settings_updated', settings }))
        respond(message.id, {})
      } else if (message.method === 'droid.add_user_message') {
        respond(message.id, {})
        if (options.askPermission) {
          send({
            jsonrpc: '2.0',
            type: 'request',
            factoryApiVersion: '1.0.0',
            id: 'server-1',
            method: 'droid.request_permission',
            params: {
              toolUses: [{
                toolUse: { type: 'tool_use', id: 'tool-1', name: 'Execute', input: { command: 'git push' } },
                confirmationType: 'exec',
                details: {},
              }],
              options: [{ label: 'Cancel', value: 'cancel' }],
            },
          })
        }
        for (const event of options.script ?? [assistantMessage('pong'), turnCompleted()]) {
          send(notification(event))
        }
      } else if (message.method === 'droid.interrupt_session') {
        respond(message.id, {})
      }
    }
  })

  return { child, requests }
}

function runDroid(server, input = {}, options = {}) {
  const runner = new DroidExecRunner({ spawnProcess: () => server.child })
  return runner.run({
    executable: '/usr/local/bin/droid',
    projectPath: '/tmp/project',
    prompt: 'Reply with exactly the word: pong',
    attachmentPaths: [],
    sessionId: null,
    model: null,
    effort: null,
    env: {},
    ...input,
  }, options)
}

test('droid exec session arguments select the verified stream-jsonrpc transport', () => {
  assert.deepEqual(
    droidSessionArguments(),
    ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc'],
  )
})

test('droid request envelope carries the literals the CLI validates before dispatch', () => {
  const envelope = droidRequestEnvelope('7', 'droid.add_user_message', { text: 'hi' })
  assert.equal(envelope.jsonrpc, '2.0')
  assert.equal(envelope.factoryApiVersion, '1.0.0')
  assert.equal(envelope.type, 'request')
  assert.equal(typeof envelope.id, 'string')
})

test('a completed turn returns the final assistant text, session, model, and usage', async () => {
  const server = fakeDroidExec()
  const events = []
  const result = await runDroid(server, {}, { onEvent: (event) => events.push(event) })

  assert.equal(result.provider, 'droid')
  assert.equal(result.response, 'pong')
  assert.equal(result.sessionId, SESSION_ID)
  assert.equal(result.model, 'claude-opus-5')
  assert.deepEqual(result.usage, {
    source: 'cli',
    inputTokens: 2,
    outputTokens: 4,
    cachedInputTokens: 14007,
  })
  assert.equal(events.at(0)?.type, 'started')

  const methods = server.requests.map((request) => request.method)
  assert.deepEqual(methods, ['droid.initialize_session', 'droid.add_user_message'])
  assert.ok(server.requests.every((request) => typeof request.id === 'string'))
  assert.ok(server.requests.every((request) => request.factoryApiVersion === '1.0.0'))
})

test('the pinned autonomy level and interaction mode are sent on a new session', async () => {
  const server = fakeDroidExec()
  await runDroid(server, { effort: 'high', model: 'claude-opus-5' })

  const initialize = server.requests.find((request) => request.method === 'droid.initialize_session')
  assert.equal(initialize.params.autonomyLevel, DROID_AUTONOMY_LEVEL)
  assert.equal(initialize.params.interactionMode, 'auto')
  assert.equal(initialize.params.reasoningEffort, 'high')
  assert.equal(initialize.params.modelId, 'claude-opus-5')
  assert.equal(initialize.params.cwd, '/tmp/project')
  assert.equal(typeof initialize.params.machineId, 'string')
})

test('an effort outside the Ensync size tiers is never forwarded as a Droid reasoning effort', async () => {
  const server = fakeDroidExec()
  await runDroid(server, { effort: 'xhigh' })

  const initialize = server.requests.find((request) => request.method === 'droid.initialize_session')
  assert.equal(initialize.params.reasoningEffort, undefined)
})

test('a session ID resumes through load_session instead of starting a new session', async () => {
  const server = fakeDroidExec()
  const result = await runDroid(server, { sessionId: SESSION_ID })

  const methods = server.requests.map((request) => request.method)
  assert.deepEqual(methods, [
    'droid.load_session',
    'droid.update_session_settings',
    'droid.add_user_message',
  ])
  assert.equal(server.requests[0].params.sessionId, SESSION_ID)
  assert.equal(server.requests[1].params.autonomyLevel, DROID_AUTONOMY_LEVEL)
  assert.equal(result.sessionId, SESSION_ID)
})

test('a run fails closed when Droid does not echo the pinned autonomy level', async () => {
  // droid 0.190.0 declares autonomyLevel as `.optional().catch(void 0)`, so an
  // unrecognised value is dropped silently instead of rejected.
  const server = fakeDroidExec({ appliedAutonomyLevel: 'high' })
  await assert.rejects(runDroid(server), (error) => {
    assert.equal(error.code, 'provider_containment_unverified')
    assert.equal(error.status, 409)
    assert.equal(error.safeToRetry, true)
    return true
  })

  const methods = server.requests.map((request) => request.method)
  assert.ok(!methods.includes('droid.add_user_message'), 'no prompt may be sent without verified containment')
})

test('text that precedes tool work becomes a note and the closing text is the final answer', async () => {
  const server = fakeDroidExec({
    script: [
      assistantMessage('Checking the failing test first.', 'assistant-1'),
      { type: 'tool_call', toolUse: { id: 'tool-1', name: 'Read' } },
      { type: 'tool_result', toolUseId: 'tool-1', content: 'ok' },
      assistantMessage('The assertion was inverted.', 'assistant-2'),
      turnCompleted(),
    ],
  })
  const events = []
  const result = await runDroid(server, {}, { onEvent: (event) => events.push(event) })

  const notes = events.filter((event) => event.type === 'note').map((event) => event.text)
  assert.deepEqual(notes, ['Checking the failing test first.'])
  assert.equal(result.response, 'The assertion was inverted.')
})

test('a turn that ends with no assistant text is an explicit empty response', async () => {
  const server = fakeDroidExec({
    script: [
      assistantMessage('Working on it.', 'assistant-1'),
      { type: 'tool_call', toolUse: { id: 'tool-1', name: 'Edit' } },
      turnCompleted(),
    ],
  })
  await assert.rejects(runDroid(server), (error) => {
    assert.equal(error.code, 'empty_cli_response')
    return true
  })
})

test('exhausted model usage before any activity is a safe quota failure', async () => {
  const server = fakeDroidExec({
    script: [
      { type: 'droid_working_state_changed', newState: 'thinking' },
      { type: 'llm_retry', attempt: 1, reason: 'rate_limited' },
      turnCompleted('model_usage_exhausted'),
    ],
  })
  await assert.rejects(runDroid(server), (error) => {
    assert.equal(error.code, 'provider_quota')
    assert.equal(error.status, 429)
    assert.equal(error.safeToRetry, true)
    return true
  })
})

test('exhausted model usage after tool activity is never safe to replay', async () => {
  const server = fakeDroidExec({
    script: [
      { type: 'tool_call', toolUse: { id: 'tool-1', name: 'Edit' } },
      { type: 'tool_result', toolUseId: 'tool-1', content: 'written' },
      turnCompleted('model_usage_exhausted'),
    ],
  })
  await assert.rejects(runDroid(server), (error) => {
    assert.equal(error.code, 'provider_quota')
    assert.equal(error.safeToRetry, false)
    return true
  })
})

test('a non-quota terminal reason is reported as a failed run that is not replayed', async () => {
  const server = fakeDroidExec({ script: [turnCompleted('permission_rejected')] })
  await assert.rejects(runDroid(server), (error) => {
    assert.equal(error.code, 'cli_failed')
    assert.equal(error.safeToRetry, false)
    assert.match(error.message, /permission_rejected/)
    return true
  })
})

test('an interactive permission request is declined with the provider\u2019s own cancel outcome', async () => {
  const server = fakeDroidExec({ askPermission: true })
  const events = []
  const result = await runDroid(server, {}, { onEvent: (event) => events.push(event) })

  const declined = server.requests.find((request) => request.type === 'response' && request.id === 'server-1')
  assert.equal(declined.result.selectedOption, 'cancel')
  // A decline names the refused tool, and never fails a turn that still answered.
  const notice = events.find((event) => event.code === 'provider_request_declined')
  assert.match(notice.message, /Execute/)
  assert.equal(result.response, 'pong')
})

test('a turn left empty by a declined permission is reported as the declined permission', async () => {
  // Verified against the droid CLI: a cancelled tool batch breaks the agent
  // loop, and in stream-jsonrpc mode Droid appends no closing message yet still
  // reports `agent_turn_completed` with reason `completed`.
  const server = fakeDroidExec({
    askPermission: true,
    script: [
      assistantMessage('The diff is correct. Let me commit and push.', 'assistant-1'),
      { type: 'tool_call', toolUse: { id: 'tool-1', name: 'Execute' } },
      turnCompleted(),
    ],
  })
  await assert.rejects(runDroid(server), (error) => {
    assert.equal(error.code, 'provider_permission_declined')
    assert.equal(error.status, 409)
    assert.equal(error.safeToRetry, false)
    assert.match(error.message, /Execute/)
    assert.match(error.message, new RegExp(DROID_AUTONOMY_LEVEL))
    return true
  })
})

test('a user stop cancels the run without claiming a provider failure', async () => {
  const controller = new AbortController()
  const server = fakeDroidExec({ script: [] })
  const pending = runDroid(server, {}, { signal: controller.signal })
  setTimeout(() => controller.abort(), 20)

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'run_cancelled')
    assert.equal(error.status, 499)
    assert.equal(error.safeToRetry, false)
    return true
  })
})

test('droidTurnProvesNoActivity rejects unknown notification types', () => {
  assert.equal(droidTurnProvesNoActivity([
    { type: 'droid_working_state_changed', newState: 'thinking' },
    turnCompleted('model_usage_exhausted'),
  ]), true)

  assert.equal(droidTurnProvesNoActivity([
    { type: 'some_future_notification' },
    turnCompleted('model_usage_exhausted'),
  ]), false)

  assert.equal(droidTurnProvesNoActivity([
    { type: 'hook_execution_started', hookId: 'h1', hookEventName: 'PreToolUse', hookCommands: [] },
    turnCompleted('model_usage_exhausted'),
  ]), false)

  assert.equal(droidTurnProvesNoActivity([turnCompleted('completed')]), false)
})

test('droidTurnProvesNoActivity treats a tool block inside a message as activity', () => {
  const toolMessage = {
    type: 'create_message',
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Editing' }, { type: 'tool_use', id: 't1', name: 'Edit' }],
    },
  }
  assert.equal(droidTurnProvesNoActivity([toolMessage, turnCompleted('model_usage_exhausted')]), false)
  assert.equal(
    droidTurnProvesNoActivity([assistantMessage('Just text'), turnCompleted('model_usage_exhausted')]),
    true,
  )
})
