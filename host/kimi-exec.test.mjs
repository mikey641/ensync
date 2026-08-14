import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  KIMI_FORCED_PERMISSION_MODE,
  KIMI_OUTPUT_FORMAT,
  KIMI_PROMPT_TRANSPORT,
  KIMI_TERMINAL_EVENT_TYPE,
  KimiExecRunner,
  kimiIsTerminalFrame,
  kimiParseFrame,
  kimiSessionArguments,
  kimiVisibleArguments,
} from './kimi-exec.mjs'

const PROJECT = '/tmp/ensync-kimi-project'
const SESSION_ID = 'ses_01JQ4Z8N'

/** Speaks the NDJSON contract verified against the Kimi Code CLI 0.34.0 bundle. */
function fakeKimi(options = {}) {
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
    return true
  }

  const spawnProcess = (executable, args) => {
    child.spawnedWith = { executable, args }
    queueMicrotask(() => {
      if (options.onSpawn) {
        options.onSpawn(child)
        return
      }
      if (options.stderr) child.stderr.write(options.stderr)
      for (const frame of options.frames ?? []) {
        child.stdout.write(`${JSON.stringify(frame)}\n`)
      }
      child.stdout.end()
      child.exitCode = options.exitCode ?? 0
      child.emit('close', options.exitCode ?? 0, null)
    })
    return child
  }

  return { child, spawnProcess }
}

/**
 * Holds the event loop open while a test waits on one of the runner's watchdogs. Those
 * timers are `unref`'d on purpose, so a pending run never keeps the Host process alive;
 * the side effect is that a test awaiting one would otherwise drain the loop and be
 * reported as never settling. This keeps the production timers honest.
 */
async function holdingEventLoop(run) {
  const keepAlive = setInterval(() => {}, 5)
  try {
    return await run()
  } finally {
    clearInterval(keepAlive)
  }
}

const assistant = (content, toolCalls) => ({
  role: 'assistant',
  ...(content === undefined ? {} : { content }),
  ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
})

const resumeHint = (sessionId = SESSION_ID) => ({
  role: 'meta',
  type: KIMI_TERMINAL_EVENT_TYPE,
  session_id: sessionId,
  command: `kimi -r ${sessionId}`,
  content: `To resume this session: kimi -r ${sessionId}`,
})

test('kimiSessionArguments pins prompt mode and the NDJSON output format', () => {
  const args = kimiSessionArguments({ prompt: 'rename the helper' })

  assert.deepEqual(args, ['--prompt', 'rename the helper', '--output-format', 'stream-json'])
  assert.equal(KIMI_OUTPUT_FORMAT, 'stream-json')
})

test('kimiSessionArguments never sends a bare session flag, plan mode, or extra dirs', () => {
  const args = kimiSessionArguments({ prompt: 'go', model: 'k2', sessionId: SESSION_ID })

  assert.deepEqual(args, [
    '--prompt', 'go',
    '--output-format', 'stream-json',
    '--model', 'k2',
    '--session', SESSION_ID,
  ])
  // A bare `--session` opens an interactive picker, which is an immediate headless hang.
  assert.notEqual(args.at(-1), '--session')
  for (const forbidden of ['--continue', '-c', '--plan', '--add-dir', '--agent', '--yolo', '-y', '--auto']) {
    assert.ok(!args.includes(forbidden), `${forbidden} must not be sent`)
  }
})

test('kimiSessionArguments omits the session flag when no id was chosen', () => {
  const args = kimiSessionArguments({ prompt: 'go' })
  assert.ok(!args.includes('--session'))
})

test('the permission mode is the CLI’s, not Ensync’s, and the prompt rides argv', () => {
  // Both are recorded facts the containment note in host/chat.mjs cites.
  assert.equal(KIMI_FORCED_PERMISSION_MODE, 'auto')
  assert.equal(KIMI_PROMPT_TRANSPORT, 'argv')
})

test('kimiVisibleArguments withholds the prompt from anything shown or logged', () => {
  const input = { prompt: 'secret task text', model: 'k2' }

  assert.deepEqual(kimiVisibleArguments(input), [
    '--prompt', '<prompt>',
    '--output-format', 'stream-json',
    '--model', 'k2',
  ])
  assert.ok(kimiSessionArguments(input).includes('secret task text'))
})

test('kimiParseFrame accepts only JSON objects', () => {
  assert.deepEqual(kimiParseFrame('{"role":"assistant","content":"hi"}'), {
    role: 'assistant',
    content: 'hi',
  })
  assert.equal(kimiParseFrame('[1,2]'), null)
  assert.equal(kimiParseFrame('not json'), null)
  assert.equal(kimiParseFrame('{"broken":'), null)
  assert.equal(kimiParseFrame(''), null)
})

test('kimiIsTerminalFrame matches only the verified completion frame', () => {
  assert.equal(kimiIsTerminalFrame(resumeHint()), true)
  assert.equal(kimiIsTerminalFrame({ role: 'meta', type: 'turn.step.retrying' }), false)
  assert.equal(kimiIsTerminalFrame({ role: 'assistant', content: 'done' }), false)
  // turn.ended never reaches stdout; it must not be treated as completion.
  assert.equal(kimiIsTerminalFrame({ role: 'meta', type: 'turn.ended' }), false)
})

test('a completed turn returns the final assistant text and the resumable session id', async () => {
  const fake = fakeKimi({
    frames: [
      assistant('Looking at the helper.', [{ type: 'function', id: 't1', function: { name: 'Read', arguments: '{}' } }]),
      { role: 'tool', tool_call_id: 't1', content: 'file contents' },
      assistant('Renamed the helper and updated its callers.'),
      resumeHint(),
    ],
  })
  const events = []

  const result = await new KimiExecRunner({ spawnProcess: fake.spawnProcess }).run({
    executable: '/usr/local/bin/kimi',
    projectPath: PROJECT,
    prompt: 'Rename the helper.',
    model: 'k2',
    effort: 'high',
    env: {},
  }, { onEvent: (event) => events.push(event) })

  assert.equal(result.provider, 'kimi')
  assert.equal(result.response, 'Renamed the helper and updated its callers.')
  assert.equal(result.sessionId, SESSION_ID)
  assert.equal(result.requestedModel, 'k2')
  assert.equal(result.requestedEffort, 'high')
  // stream-json carries no token counts, so usage stays honestly unknown.
  assert.equal(result.usage, null)

  // Text that preceded tool work is a note, not the answer.
  assert.ok(events.some((event) => event.type === 'note' && event.text === 'Looking at the helper.'))
  const started = events.find((event) => event.type === 'started')
  assert.ok(!started.command.includes('Rename the helper.'))
  assert.match(started.command, /<prompt>/)
})

test('a stream without the resume hint is an unverified run even when it exits zero', async () => {
  const fake = fakeKimi({
    frames: [assistant('I think I am done.')],
    exitCode: 0,
  })

  await assert.rejects(
    new KimiExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'kimi',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'invalid_cli_output')
      assert.equal(error.status, 502)
      return true
    },
  )
})

test('a completed turn with no assistant text is reported as an empty response', async () => {
  const fake = fakeKimi({ frames: [resumeHint()] })

  await assert.rejects(
    new KimiExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'kimi',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'empty_cli_response')
      return true
    },
  )
})

test('a failing run folds stderr into the failure detail', async () => {
  const fake = fakeKimi({ frames: [], stderr: 'kimi: not authenticated\n', exitCode: 1 })

  await assert.rejects(
    new KimiExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'kimi',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'invalid_cli_output')
      assert.match(error.message, /not authenticated/)
      return true
    },
  )
})

test('a retry frame is surfaced as a notice and does not end the run', async () => {
  const fake = fakeKimi({
    frames: [
      { role: 'meta', type: 'turn.step.retrying', failed_attempt: 1, max_attempts: 3 },
      assistant('Recovered and finished.'),
      resumeHint(),
    ],
  })
  const events = []

  const result = await new KimiExecRunner({ spawnProcess: fake.spawnProcess }).run({
    executable: 'kimi',
    projectPath: PROJECT,
    prompt: 'go',
    env: {},
  }, { onEvent: (event) => events.push(event) })

  assert.equal(result.response, 'Recovered and finished.')
  const notice = events.find((event) => event.type === 'notice')
  assert.equal(notice.code, 'provider_retrying')
  assert.match(notice.message, /attempt 1 of 3/)
})

test('unparseable lines are ignored rather than guessed at', async () => {
  const fake = fakeKimi({
    onSpawn: (child) => {
      child.stdout.write('warning: update available\n')
      child.stdout.write('{"broken":\n')
      child.stdout.write(`${JSON.stringify(assistant('Finished.'))}\n`)
      child.stdout.write(`${JSON.stringify(resumeHint())}\n`)
      child.stdout.end()
      child.exitCode = 0
      child.emit('close', 0, null)
    },
  })

  const result = await new KimiExecRunner({ spawnProcess: fake.spawnProcess }).run({
    executable: 'kimi',
    projectPath: PROJECT,
    prompt: 'go',
    env: {},
  })

  assert.equal(result.response, 'Finished.')
})

test('a silent run is ended by the inactivity watchdog', async () => {
  const fake = fakeKimi({ onSpawn: () => {} })

  await holdingEventLoop(() => assert.rejects(
    new KimiExecRunner({ spawnProcess: fake.spawnProcess, inactivityTimeoutMs: 20 }).run({
      executable: 'kimi',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'run_timed_out')
      assert.equal(error.status, 504)
      return true
    },
  ))
  assert.ok(fake.child.killed.includes('SIGTERM'))
})

test('the hard ceiling stops a run that keeps streaming forever', async () => {
  const fake = fakeKimi({
    onSpawn: (child) => {
      const timer = setInterval(() => {
        child.stdout.write(`${JSON.stringify(assistant('still working'))}\n`)
      }, 5)
      timer.unref?.()
      child.stdout.on('close', () => clearInterval(timer))
    },
  })

  await holdingEventLoop(() => assert.rejects(
    new KimiExecRunner({
      spawnProcess: fake.spawnProcess,
      inactivityTimeoutMs: 10_000,
      hardTimeoutMs: 30,
    }).run({
      executable: 'kimi',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'run_timed_out')
      assert.match(error.message, /hard run limit/)
      return true
    },
  ))
})

test('cancellation terminates the process and reports run_cancelled', async () => {
  const fake = fakeKimi({ onSpawn: () => {} })
  const controller = new AbortController()
  const pending = new KimiExecRunner({ spawnProcess: fake.spawnProcess }).run({
    executable: 'kimi',
    projectPath: PROJECT,
    prompt: 'go',
    env: {},
  }, { signal: controller.signal })

  controller.abort()

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'run_cancelled')
    assert.equal(error.status, 499)
    return true
  })
  assert.ok(fake.child.killed.includes('SIGTERM'))
})

test('a spawn failure is reported as run_start_failed', async () => {
  const fake = fakeKimi({
    onSpawn: (child) => child.emit('error', new Error('spawn ENOENT')),
  })

  await assert.rejects(
    new KimiExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'kimi',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'run_start_failed')
      assert.match(error.message, /spawn ENOENT/)
      return true
    },
  )
})

test('the child is spawned in the contained project directory', async () => {
  let spawnOptions = null
  const fake = fakeKimi({ frames: [assistant('done'), resumeHint()] })
  const spawnProcess = (executable, args, options) => {
    spawnOptions = options
    return fake.spawnProcess(executable, args, options)
  }

  await new KimiExecRunner({ spawnProcess }).run({
    executable: 'kimi',
    projectPath: PROJECT,
    prompt: 'go',
    env: { PATH: '/usr/bin' },
  })

  assert.equal(spawnOptions.cwd, PROJECT)
  assert.equal(spawnOptions.shell, false)
  assert.deepEqual(spawnOptions.env, { PATH: '/usr/bin' })
})
