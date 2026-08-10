import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  CODEBUDDY_PERMISSION_MODE,
  CodebuddyExecRunner,
  codebuddyArguments,
  codebuddyContainmentArguments,
  codebuddyContainmentMismatch,
  codebuddyTerminalResult,
} from './codebuddy-exec.mjs'

const SESSION_ID = '8d356972-fdd6-43a3-b93e-ce09dde91b30'
const PROJECT_PATH = '/tmp/project'
const CANONICAL_PATH = '/tmp/canonical'

/**
 * Fixture copied from a real capture against codebuddy 2.133.1. Taken with an
 * EMPTY prompt, which the CLI bills as duration_api_ms 0 / total_cost_usd 0 —
 * no model turn was spent to obtain it.
 */
function initEvent(overrides = {}) {
  return {
    type: 'system',
    subtype: 'init',
    uuid: SESSION_ID,
    session_id: SESSION_ID,
    apiKeySource: 'www.codebuddy.ai',
    cwd: PROJECT_PATH,
    tools: [],
    mcp_servers: [],
    model: 'unknown',
    permissionMode: CODEBUDDY_PERMISSION_MODE,
    slash_commands: [],
    output_style: 'default',
    ...overrides,
  }
}

function resultEvent(overrides = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'pong',
    uuid: 'fd778c06-dcb8-4b58-9dd0-122401aeb5eb',
    session_id: SESSION_ID,
    duration_ms: 61,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 11,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 7,
    },
    permission_denials: [],
    ...overrides,
  }
}

/**
 * Speaks the verified CodeBuddy headless contract: NDJSON on stdout, the prompt
 * arriving on stdin, `system.init` emitted BEFORE any prompt is read, and a
 * single `result` line as the terminal event.
 */
function fakeCodebuddy(options = {}) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    child.exitCode = 0
    child.emit('close', 0, null)
    return true
  }

  const state = { promptReceived: null }
  const send = (event) => child.stdout.write(`${typeof event === 'string' ? event : JSON.stringify(event)}\n`)

  // init is emitted unprompted, exactly as the real CLI does.
  if (options.init !== null) queueMicrotask(() => send(options.init ?? initEvent()))

  let buffer = ''
  child.stdin.on('data', (chunk) => { buffer += chunk.toString('utf8') })
  child.stdin.on('end', () => {
    state.promptReceived = buffer
    if (options.onPrompt) {
      options.onPrompt({ send, child, prompt: buffer })
      return
    }
    for (const event of options.script ?? [resultEvent()]) send(event)
  })

  return { child, state }
}

/**
 * The runner unrefs its watchdog timers so a pending run never holds the Host
 * process open. That is correct in production and inconvenient in a test: with
 * nothing else scheduled the loop drains before the timer fires. This keeps the
 * loop alive only for as long as the assertion needs it.
 */
async function withEventLoopAlive(run) {
  const keepAlive = setInterval(() => {}, 5)
  try {
    return await run()
  } finally {
    clearInterval(keepAlive)
  }
}

function runCodebuddy(server, input = {}, options = {}) {
  const runner = new CodebuddyExecRunner({
    spawnProcess: () => server.child,
    resolvePath: async (path) => path,
    ...options.runner,
  })
  return runner.run({
    executable: '/opt/homebrew/bin/codebuddy',
    projectPath: PROJECT_PATH,
    prompt: 'Reply with exactly the word: pong',
    sessionId: null,
    model: null,
    effort: null,
    containment: null,
    env: {},
    ...input,
  }, options)
}

// --------------------------------------------------------------------------
// Argument construction
// --------------------------------------------------------------------------

test('codebuddy arguments pin the verified headless transport and permission mode', () => {
  assert.deepEqual(codebuddyArguments(), [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--permission-mode',
    CODEBUDDY_PERMISSION_MODE,
  ])
})

test('codebuddy arguments never place the prompt in argv', () => {
  const args = codebuddyArguments({ prompt: 'secret prompt text' })
  assert.ok(!args.includes('secret prompt text'))
  assert.ok(args.every((arg) => !arg.includes('secret prompt')))
})

test('codebuddy arguments carry model, effort, and resume when requested', () => {
  const args = codebuddyArguments({ model: 'gpt-5.5', effort: 'high', sessionId: SESSION_ID })
  assert.deepEqual(args.slice(6), ['--model', 'gpt-5.5', '--effort', 'high', '--resume', SESSION_ID])
})

test('codebuddy arguments drop effort values outside the verified size tiers', () => {
  // The CLI enum also has minimal/xhigh, which Ensync's size selector never emits.
  assert.ok(!codebuddyArguments({ effort: 'xhigh' }).includes('--effort'))
  assert.ok(!codebuddyArguments({ effort: 'minimal' }).includes('--effort'))
  assert.ok(codebuddyArguments({ effort: 'max' }).includes('--effort'))
})

test('codebuddy arguments use --resume, not --session-id, to continue a conversation', () => {
  const args = codebuddyArguments({ sessionId: SESSION_ID })
  assert.ok(args.includes('--resume'))
  assert.ok(!args.includes('--session-id'))
})

test('codebuddy containment arguments deny writes to the canonical checkout', () => {
  const args = codebuddyContainmentArguments({
    worktreePath: PROJECT_PATH,
    canonicalRepositoryPath: CANONICAL_PATH,
  })
  assert.equal(args[0], '--settings')
  assert.deepEqual(JSON.parse(args[1]), {
    permissions: {
      deny: [
        `Write(${CANONICAL_PATH}/**)`,
        `Edit(${CANONICAL_PATH}/**)`,
        `NotebookEdit(${CANONICAL_PATH}/**)`,
      ],
    },
  })
})

test('codebuddy arguments never pass --add-dir, which can pollute the JSON stream', () => {
  const args = codebuddyArguments({ model: 'gpt-5.5' }, {
    worktreePath: PROJECT_PATH,
    canonicalRepositoryPath: CANONICAL_PATH,
  })
  assert.ok(!args.includes('--add-dir'))
})

// --------------------------------------------------------------------------
// Containment verification (the fail-open guard)
// --------------------------------------------------------------------------

test('containment check accepts an init echoing the pinned mode and protected cwd', () => {
  assert.equal(codebuddyContainmentMismatch(initEvent(), PROJECT_PATH), null)
})

test('containment check rejects the silent fallback to default mode', () => {
  // Verified against the CLI: `--permission-mode __bogus__` is discarded without
  // error and the session reports "default".
  const mismatch = codebuddyContainmentMismatch(initEvent({ permissionMode: 'default' }), PROJECT_PATH)
  assert.match(mismatch, /reported permission mode "default"/)
})

test('containment check rejects a working directory outside the protected worktree', () => {
  const mismatch = codebuddyContainmentMismatch(initEvent({ cwd: '/tmp/elsewhere' }), PROJECT_PATH)
  assert.match(mismatch, /working directory "\/tmp\/elsewhere"/)
})

test('containment check tolerates a trailing slash rather than failing a real match', () => {
  assert.equal(codebuddyContainmentMismatch(initEvent({ cwd: `${PROJECT_PATH}/` }), PROJECT_PATH), null)
})

test('containment check refuses a missing init event', () => {
  assert.match(codebuddyContainmentMismatch(null, PROJECT_PATH), /did not report a session initialization/)
})

test('the prompt is withheld when the CLI does not echo the pinned permission mode', async () => {
  const server = fakeCodebuddy({ init: initEvent({ permissionMode: 'default' }) })
  await assert.rejects(runCodebuddy(server), (error) => {
    assert.equal(error.code, 'provider_containment_unverified')
    assert.equal(error.status, 409)
    assert.match(error.message, /No prompt was sent/)
    return true
  })
  // The decisive assertion: nothing was ever handed to the model.
  assert.equal(server.state.promptReceived, null)
})

test('the prompt is released once containment is proven', async () => {
  const server = fakeCodebuddy()
  const result = await runCodebuddy(server)
  assert.equal(server.state.promptReceived, 'Reply with exactly the word: pong')
  assert.equal(result.response, 'pong')
})

// --------------------------------------------------------------------------
// Output parsing
// --------------------------------------------------------------------------

test('codebuddy terminal result picks the last result event', () => {
  const events = [initEvent(), resultEvent({ result: 'first' }), resultEvent({ result: 'second' })]
  assert.equal(codebuddyTerminalResult(events).result, 'second')
  assert.equal(codebuddyTerminalResult([initEvent()]), null)
})

test('a completed run reports response, session, and usage from the verified fixture', async () => {
  const server = fakeCodebuddy()
  const result = await runCodebuddy(server)
  assert.equal(result.provider, 'codebuddy')
  assert.equal(result.response, 'pong')
  assert.equal(result.sessionId, SESSION_ID)
  assert.deepEqual(result.usage, {
    source: 'cli',
    inputTokens: 11,
    outputTokens: 4,
    cachedInputTokens: 7,
  })
})

test('a logged-out session never reports "unknown" as if it were a model', async () => {
  const server = fakeCodebuddy()
  const result = await runCodebuddy(server)
  assert.equal(result.model, null)
})

test('assistant text is forwarded as notes and tool names as output', async () => {
  const events = []
  const server = fakeCodebuddy({
    script: [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking out loud' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { secret: 'do not leak' } }] } },
      resultEvent(),
    ],
  })
  await runCodebuddy(server, {}, { onEvent: (event) => events.push(event) })

  const note = events.find((event) => event.type === 'note')
  assert.equal(note.text, 'thinking out loud')
  const toolOutput = events.find((event) => event.type === 'output' && event.text.includes('Edit'))
  assert.ok(toolOutput)
  // Tool input can carry commands and secrets and must never be surfaced.
  assert.ok(!events.some((event) => JSON.stringify(event).includes('do not leak')))
})

test('an empty result is reported as an empty response, not a success', async () => {
  const server = fakeCodebuddy({ script: [resultEvent({ result: '' })] })
  await assert.rejects(runCodebuddy(server), (error) => {
    assert.equal(error.code, 'empty_cli_response')
    return true
  })
})

test('a result without a verified boolean success state is refused', async () => {
  const server = fakeCodebuddy({ script: [resultEvent({ is_error: undefined })] })
  await assert.rejects(runCodebuddy(server), (error) => {
    assert.equal(error.code, 'invalid_cli_output')
    return true
  })
})

// --------------------------------------------------------------------------
// Failure paths
// --------------------------------------------------------------------------

test('an errored result is reported as a CLI failure with its own text', async () => {
  const server = fakeCodebuddy({
    script: [resultEvent({ is_error: true, subtype: 'error_during_execution', result: 'tool exploded' })],
  })
  await assert.rejects(runCodebuddy(server), (error) => {
    assert.equal(error.code, 'cli_failed')
    assert.match(error.message, /error_during_execution.*tool exploded/)
    return true
  })
})

test('credit exhaustion is classified as a quota failure', async () => {
  const server = fakeCodebuddy({
    script: [resultEvent({ is_error: true, result: 'You are out of credits for this billing period.' })],
  })
  await assert.rejects(runCodebuddy(server), (error) => {
    assert.equal(error.code, 'provider_quota')
    assert.equal(error.status, 429)
    return true
  })
})

test('a signed-out failure is classified as an authentication failure', async () => {
  const server = fakeCodebuddy({
    script: [resultEvent({ is_error: true, result: 'Authentication required. Please use /login to sign in.' })],
  })
  await assert.rejects(runCodebuddy(server), (error) => {
    assert.equal(error.code, 'provider_not_authenticated')
    assert.equal(error.status, 409)
    return true
  })
})

test('resuming an unknown session is a session error, never a silent success', async () => {
  // Verified against the CLI: an unknown --resume id prints one error line and
  // still EXITS 0. Trusting the exit code here would report success.
  const server = fakeCodebuddy({
    onPrompt: ({ send, child }) => {
      send({ type: 'error', error: `No conversation found with session ID: ${SESSION_ID}` })
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit('close', 0, null)
      })
    },
  })
  await assert.rejects(runCodebuddy(server, { sessionId: SESSION_ID }), (error) => {
    assert.equal(error.code, 'invalid_session')
    assert.match(error.message, /No conversation found/)
    return true
  })
})

test('exiting without a result event is a disconnection, not a success', async () => {
  const server = fakeCodebuddy({
    onPrompt: ({ child }) => {
      child.exitCode = 0
      child.emit('close', 0, null)
    },
  })
  await assert.rejects(runCodebuddy(server), (error) => {
    assert.equal(error.code, 'codebuddy_exec_disconnected')
    return true
  })
})

test('a spawn failure is reported as a start failure that is safe to retry', async () => {
  const server = fakeCodebuddy({ init: null })
  queueMicrotask(() => server.child.emit('error', new Error('ENOENT')))
  await assert.rejects(runCodebuddy(server), (error) => {
    assert.equal(error.code, 'run_start_failed')
    assert.equal(error.safeToRetry, true)
    return true
  })
})

test('a stray non-JSON line is forwarded rather than failing the run', async () => {
  // Verified: `--add-dir <missing>` prints a bare "<path> not found" line into
  // the middle of the JSON stream.
  const events = []
  const server = fakeCodebuddy({ script: ['/tmp/nope not found', resultEvent()] })
  const result = await runCodebuddy(server, {}, { onEvent: (event) => events.push(event) })
  assert.equal(result.response, 'pong')
  assert.ok(events.some((event) => event.type === 'output' && event.text.includes('not found')))
})

test('a stream that is mostly unparseable is refused', async () => {
  const server = fakeCodebuddy({ script: Array.from({ length: 60 }, (_, index) => `garbage ${index}`) })
  await assert.rejects(runCodebuddy(server), (error) => {
    assert.equal(error.code, 'invalid_cli_output')
    return true
  })
})

// --------------------------------------------------------------------------
// Timeouts and cancellation
// --------------------------------------------------------------------------

test('a silent run is stopped by the inactivity watchdog instead of hanging', async () => {
  // This is the droid-hang guard: CodeBuddy's headless approval behaviour is
  // unverified, so a blocked approval must still end as an honest timeout.
  const server = fakeCodebuddy({ onPrompt: () => {} })
  await withEventLoopAlive(() => assert.rejects(
    runCodebuddy(server, {}, { runner: { inactivityTimeoutMs: 25 } }),
    (error) => {
      assert.equal(error.code, 'run_timed_out')
      assert.equal(error.status, 504)
      assert.match(error.message, /inactivity limit/)
      return true
    },
  ))
})

test('the hard ceiling stops a run that keeps producing output forever', async () => {
  const server = fakeCodebuddy({
    onPrompt: ({ send }) => {
      const timer = setInterval(() => send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'still going' }] } }), 5)
      timer.unref?.()
    },
  })
  await withEventLoopAlive(() => assert.rejects(
    runCodebuddy(server, {}, { runner: { inactivityTimeoutMs: 60_000, hardTimeoutMs: 40 } }),
    (error) => {
      assert.equal(error.code, 'run_timed_out')
      assert.match(error.message, /hard run limit/)
      return true
    },
  ))
})

test('cancellation stops the run and reports it as user-stopped', async () => {
  const controller = new AbortController()
  const server = fakeCodebuddy({ onPrompt: () => queueMicrotask(() => controller.abort()) })
  await assert.rejects(
    runCodebuddy(server, {}, { signal: controller.signal }),
    (error) => {
      assert.equal(error.code, 'run_cancelled')
      assert.equal(error.status, 499)
      return true
    },
  )
})

test('a run cancelled before it starts never sends the prompt', async () => {
  const controller = new AbortController()
  controller.abort()
  const server = fakeCodebuddy()
  await assert.rejects(
    runCodebuddy(server, {}, { signal: controller.signal }),
    (error) => {
      assert.equal(error.code, 'run_cancelled')
      return true
    },
  )
  assert.equal(server.state.promptReceived, null)
})
