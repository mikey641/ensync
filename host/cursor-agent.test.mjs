import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  CURSOR_OUTPUT_FORMAT,
  CURSOR_SANDBOX_MODE,
  CursorAgentRunner,
  cursorAgentArguments,
  cursorMessageText,
  cursorStartupFailure,
  cursorToolName,
  cursorUsage,
  parseCursorEventLine,
} from './cursor-agent.mjs'

// A real chat id from the CLI's own `create-chat` output shape.
const SESSION_ID = '0f3b1d94-6a4e-4c2f-9a7d-2b8c5e1f0a63'

/**
 * Speaks the stdout contract verified against cursor-agent 2026.08.04-aaa8809:
 * newline-delimited JSON, one object per line, ending in a single
 * `{"type":"result","subtype":"success"}` event. Failure paths write nothing to
 * stdout and print to stderr instead, which is what `stderr` + `exitCode` model.
 */
function fakeCursorAgent(options = {}) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.killed = []
  child.kill = (signal) => {
    child.killed.push(signal)
    child.exitCode = 0
    queueMicrotask(() => child.emit('close', child.exitCode, null))
    return true
  }

  const stdinChunks = []
  child.stdin.on('data', (chunk) => stdinChunks.push(chunk.toString('utf8')))

  const emit = (event) => child.stdout.write(`${JSON.stringify(event)}\n`)
  const finish = () => {
    if (options.stderr) child.stderr.write(options.stderr)
    child.exitCode = options.exitCode ?? 0
    child.emit('close', child.exitCode, null)
  }

  // The CLI only starts a turn once stdin reaches `end`, so the fake mirrors
  // that: nothing is emitted until Ensync closes stdin.
  child.stdin.on('end', () => {
    queueMicrotask(() => {
      for (const event of options.script ?? []) emit(event)
      if (options.hang !== true) finish()
    })
  })

  return { child, stdinChunks, emit, finish }
}

function systemInit(overrides = {}) {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'login',
    cwd: '/tmp/project',
    session_id: SESSION_ID,
    model: 'claude-opus-5',
    permissionMode: 'default',
    ...overrides,
  }
}

function assistantText(text) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    session_id: SESSION_ID,
  }
}

function resultSuccess(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1200,
    duration_api_ms: 1200,
    result: 'pong',
    session_id: SESSION_ID,
    request_id: 'req-1',
    ...overrides,
  }
}

function runCursor(server, input = {}, options = {}) {
  const runner = new CursorAgentRunner({ spawnProcess: () => server.child, ...(options.runner ?? {}) })
  return runner.run({
    executable: '/Users/tester/.local/bin/cursor-agent',
    projectPath: '/tmp/project',
    prompt: 'Reply with exactly the word: pong',
    sessionId: null,
    model: null,
    effort: null,
    env: {},
    ...input,
  }, options)
}

test('cursor argv pins headless print mode, the machine-readable stream, the sandbox, and the workspace root', () => {
  assert.deepEqual(
    cursorAgentArguments({ projectPath: '/tmp/project' }),
    [
      '--print',
      '--output-format', CURSOR_OUTPUT_FORMAT,
      '--sandbox', CURSOR_SANDBOX_MODE,
      '--force',
      '--workspace', '/tmp/project',
    ],
  )
  assert.equal(CURSOR_OUTPUT_FORMAT, 'stream-json')
  assert.equal(CURSOR_SANDBOX_MODE, 'enabled')
})

test('cursor argv never carries the prompt, because Ensync keeps prompts out of argv', () => {
  const args = cursorAgentArguments({ projectPath: '/tmp/project', sessionId: SESSION_ID, model: 'gpt-5.6-sol' })
  assert.equal(args.includes('Reply with exactly the word: pong'), false)
  // Every remaining member is a flag or a flag's value; nothing is positional.
  assert.equal(args.at(0), '--print')
})

test('cursor resume uses the = spelling so an optional-value flag cannot swallow the next flag', () => {
  const args = cursorAgentArguments({ projectPath: '/tmp/project', sessionId: SESSION_ID, model: 'gpt-5.6-sol' })
  assert.equal(args.includes(`--resume=${SESSION_ID}`), true)
  assert.equal(args.includes('--resume'), false)
  assert.deepEqual(args.slice(-2), ['--model', 'gpt-5.6-sol'])
})

test('a blank session id or model adds no flag rather than an empty one', () => {
  const args = cursorAgentArguments({ projectPath: '/tmp/project', sessionId: '   ', model: '' })
  assert.equal(args.some((arg) => arg.startsWith('--resume')), false)
  assert.equal(args.includes('--model'), false)
})

test('the prompt is delivered on stdin and stdin is closed so the CLI can start the turn', async () => {
  const server = fakeCursorAgent({ script: [systemInit(), resultSuccess()] })
  await runCursor(server, { prompt: 'Reply with exactly the word: pong' })
  assert.equal(server.stdinChunks.join(''), 'Reply with exactly the word: pong')
})

test('a completed turn is reported from the verified terminal result event', async () => {
  const server = fakeCursorAgent({
    script: [
      systemInit(),
      assistantText('working on it'),
      resultSuccess({ result: 'pong', usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 64, cacheWriteTokens: 0 } }),
    ],
  })
  const result = await runCursor(server, { model: 'claude-opus-5', effort: 'high' })
  assert.equal(result.provider, 'cursor')
  assert.equal(result.response, 'pong')
  assert.equal(result.sessionId, SESSION_ID)
  assert.equal(result.model, 'claude-opus-5')
  assert.equal(result.requestedModel, 'claude-opus-5')
  assert.equal(result.requestedEffort, 'high')
  assert.deepEqual(result.usage, { source: 'cli', inputTokens: 120, outputTokens: 8, cachedInputTokens: 64 })
  assert.equal(result.outputRecovery, null)
})

test('a stream that ends without a terminal result event is never treated as a completed turn', async () => {
  const server = fakeCursorAgent({ script: [systemInit(), assistantText('half an answer')], exitCode: 0 })
  await assert.rejects(runCursor(server), (error) => {
    assert.equal(error.code, 'cursor_agent_disconnected')
    assert.equal(error.status, 502)
    assert.equal(error.safeToRetry, false)
    return true
  })
})

test('a non-success result subtype fails the run instead of returning its text', async () => {
  const server = fakeCursorAgent({ script: [systemInit(), resultSuccess({ subtype: 'error_max_turns', is_error: true, result: 'partial' })] })
  await assert.rejects(runCursor(server), (error) => {
    assert.equal(error.code, 'cli_failed')
    assert.equal(error.status, 502)
    assert.match(error.message, /error_max_turns/)
    return true
  })
})

test('a completed turn carrying no text is reported as an empty response, not as success', async () => {
  const server = fakeCursorAgent({ script: [systemInit(), resultSuccess({ result: '' })] })
  await assert.rejects(runCursor(server), (error) => {
    assert.equal(error.code, 'empty_cli_response')
    assert.equal(error.status, 502)
    return true
  })
})

test('assistant text that precedes tool work is released as a note and the tool is announced', async () => {
  const server = fakeCursorAgent({
    script: [
      systemInit(),
      assistantText('let me look at the repo'),
      {
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call-1',
        tool_call: { tool: { case: 'shellToolCall', value: { command: 'ls' } } },
        session_id: SESSION_ID,
      },
      resultSuccess(),
    ],
  })
  const events = []
  await runCursor(server, {}, { onEvent: (event) => events.push(event) })
  const note = events.find((event) => event.type === 'note')
  assert.equal(note.provider, 'cursor')
  assert.equal(note.text, 'let me look at the repo')
  const output = events.find((event) => event.type === 'output')
  assert.equal(output.text, '\n> shellToolCall\n')
})

test('an interactive request is surfaced as a notice because a headless run answers it without a person', async () => {
  const server = fakeCursorAgent({
    script: [
      systemInit(),
      { type: 'interaction_query', subtype: 'request', query_type: 'askQuestionInteractionQuery', session_id: SESSION_ID },
      resultSuccess(),
    ],
  })
  const events = []
  await runCursor(server, {}, { onEvent: (event) => events.push(event) })
  const notice = events.find((event) => event.type === 'notice')
  assert.equal(notice.code, 'provider_request_declined')
  assert.match(notice.message, /askQuestionInteractionQuery/)
})

test('a started event records the contained cwd and the exact command Ensync ran', async () => {
  const server = fakeCursorAgent({ script: [systemInit(), resultSuccess()] })
  const events = []
  await runCursor(server, {}, { onEvent: (event) => events.push(event) })
  const started = events.find((event) => event.type === 'started')
  assert.equal(started.provider, 'cursor')
  assert.equal(started.cwd, '/tmp/project')
  assert.match(started.command, /--sandbox enabled/)
  assert.match(started.command, /--output-format stream-json/)
})

test('an unsigned-in CLI is reported as an authentication failure that is safe to retry', async () => {
  const server = fakeCursorAgent({
    exitCode: 1,
    stderr: "Error: Authentication required. Please run 'cursor-agent login' first, or set CURSOR_API_KEY environment variable.\n",
  })
  await assert.rejects(runCursor(server), (error) => {
    assert.equal(error.code, 'provider_not_authenticated')
    assert.equal(error.status, 409)
    assert.equal(error.safeToRetry, true)
    return true
  })
})

test('a host that cannot apply the pinned sandbox fails closed before any prompt is answered', async () => {
  const server = fakeCursorAgent({
    exitCode: 1,
    stderr: 'Error: Sandbox mode is enabled but not available on this system. Install it.\n',
  })
  await assert.rejects(runCursor(server), (error) => {
    assert.equal(error.code, 'provider_containment_unverified')
    assert.equal(error.status, 409)
    assert.equal(error.safeToRetry, false)
    return true
  })
})

test('a team policy that forbids the pinned autorun mode is reported as a declined permission', async () => {
  const server = fakeCursorAgent({
    exitCode: 1,
    stderr: "Error: Your team administrator has disabled the 'Run Everything' option.\n",
  })
  await assert.rejects(runCursor(server), (error) => {
    assert.equal(error.code, 'provider_permission_declined')
    assert.equal(error.status, 409)
    return true
  })
})

test('cancelling a run stops the process and reports the cancellation', async () => {
  const server = fakeCursorAgent({ script: [systemInit()], hang: true })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(runCursor(server, {}, { signal: controller.signal }), (error) => {
    assert.equal(error.code, 'run_cancelled')
    assert.equal(error.status, 499)
    assert.equal(error.safeToRetry, false)
    return true
  })
  assert.equal(server.child.killed.includes('SIGINT'), true)
})

test('cancellation waits for the Cursor process close event', async () => {
  const server = fakeCursorAgent({ script: [systemInit()], hang: true })
  let releaseClose
  server.child.kill = (signal) => {
    server.child.killed.push(signal)
    releaseClose = () => {
      server.child.exitCode = 0
      server.child.emit('close', 0, null)
    }
    return true
  }
  const controller = new AbortController()
  let settled = false
  const pending = runCursor(server, {}, { signal: controller.signal })
    .catch(() => { settled = true })
  controller.abort()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false)
  releaseClose()
  await pending
  assert.equal(settled, true)
})

test('a terminal Cursor result force-closes a provider process that does not exit', async () => {
  const server = fakeCursorAgent({ script: [systemInit(), resultSuccess()], hang: true })
  const keepAlive = setInterval(() => {}, 10)
  try {
    const result = await runCursor(server)
    assert.equal(result.response, 'pong')
    assert.deepEqual(server.child.killed, ['SIGKILL'])
  } finally {
    clearInterval(keepAlive)
  }
})

test('a silent CLI is stopped at the inactivity limit rather than left working forever', async () => {
  const server = fakeCursorAgent({ script: [systemInit()], hang: true })
  // The runner unrefs its own watchdogs so a pending run never holds the Host
  // process open. That means the test must supply the only ref'd handle, or the
  // event loop drains before the watchdog it is asserting on can fire.
  const keepAlive = setInterval(() => {}, 5)
  try {
    await assert.rejects(
      runCursor(server, {}, { runner: { inactivityTimeoutMs: 25 } }),
      (error) => {
        assert.equal(error.code, 'run_timed_out')
        assert.equal(error.status, 504)
        assert.equal(error.safeToRetry, false)
        return true
      },
    )
  } finally {
    clearInterval(keepAlive)
  }
})

test('a run that outlives the hard limit is stopped even while the CLI keeps talking', async () => {
  const server = fakeCursorAgent({ script: [systemInit()], hang: true })
  const chatter = setInterval(() => server.emit(assistantText('still going')), 5)
  try {
    await assert.rejects(
      runCursor(server, {}, { runner: { hardTimeoutMs: 40 } }),
      (error) => {
        assert.equal(error.code, 'run_timed_out')
        assert.equal(error.status, 504)
        return true
      },
    )
  } finally {
    clearInterval(chatter)
  }
})

test('a stray non-JSON line does not fail a run that still reports a completed turn', async () => {
  const server = fakeCursorAgent({ script: [systemInit(), resultSuccess()] })
  server.child.stdout.write('a plugin printed this\n')
  const result = await runCursor(server)
  assert.equal(result.response, 'pong')
})

test('parseCursorEventLine accepts only framed JSON objects that name their type', () => {
  assert.equal(parseCursorEventLine(''), null)
  assert.equal(parseCursorEventLine('not json'), null)
  assert.equal(parseCursorEventLine('"a string"'), null)
  assert.equal(parseCursorEventLine('{"no":"type"}'), null)
  assert.deepEqual(parseCursorEventLine('{"type":"result"}'), { type: 'result' })
})

test('cursorToolName reads the protobuf oneof shape and tolerates a plain one', () => {
  assert.equal(cursorToolName({ tool_call: { tool: { case: 'shellToolCall', value: {} } } }), 'shellToolCall')
  assert.equal(cursorToolName({ tool_call: { tool: { readToolCall: {} } } }), 'readToolCall')
  assert.equal(cursorToolName({ tool_call: {} }), null)
  assert.equal(cursorToolName({}), null)
})

test('cursorMessageText joins only the text blocks of an assistant message', () => {
  assert.equal(
    cursorMessageText({ content: [{ type: 'text', text: ' one ' }, { type: 'image' }, { type: 'text', text: 'two' }] }),
    'one\n\ntwo',
  )
  assert.equal(cursorMessageText({ content: [] }), '')
  assert.equal(cursorMessageText(null), '')
})

test('cursorUsage keeps only counts the CLI actually reported as safe integers', () => {
  assert.deepEqual(
    cursorUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 }),
    { source: 'cli', inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
  )
  assert.deepEqual(
    cursorUsage({ inputTokens: 10, outputTokens: -1, cacheReadTokens: 1.5 }),
    { source: 'cli', inputTokens: 10, outputTokens: null, cachedInputTokens: null },
  )
  assert.equal(cursorUsage({}), null)
  assert.equal(cursorUsage(null), null)
})

test('cursorStartupFailure recognises only the CLI refusals Ensync has verified', () => {
  assert.equal(cursorStartupFailure(''), null)
  assert.equal(cursorStartupFailure('some unrelated warning'), null)
  assert.equal(cursorStartupFailure('Error: Authentication required.').code, 'provider_not_authenticated')
})
