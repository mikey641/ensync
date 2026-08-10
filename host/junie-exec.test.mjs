import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  JUNIE_CONFIG_DEFAULT_LOCATIONS,
  JUNIE_EFFORTS,
  JUNIE_INPUT_FORMAT,
  JUNIE_OUTPUT_FORMAT,
  JunieExecRunner,
  junieReportedErrors,
  junieSessionArguments,
  junieTerminalOutput,
  junieUsage,
} from './junie-exec.mjs'

const PROJECT = '/tmp/ensync-junie-project'

/**
 * Speaks the contract verified against Junie 26.8.3 (2548.5): the task arrives on
 * stdin, and `--output-format=json` answers with a single terminal `CliOutput` object.
 */
function fakeJunie(options = {}) {
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

  const stdinChunks = []
  child.stdin.on('data', (chunk) => stdinChunks.push(chunk.toString('utf8')))

  const spawnProcess = (executable, args) => {
    child.spawnedWith = { executable, args }
    queueMicrotask(() => {
      if (options.onSpawn) {
        options.onSpawn(child)
        return
      }
      if (options.stderr) child.stderr.write(options.stderr)
      if (options.stdout !== undefined) child.stdout.write(options.stdout)
      child.stdout.end()
      child.exitCode = options.exitCode ?? 0
      child.emit('close', options.exitCode ?? 0, null)
    })
    return child
  }

  return { child, spawnProcess, stdinText: () => stdinChunks.join('') }
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

function cliOutput(overrides = {}) {
  return JSON.stringify({
    taskName: 'Ensync task',
    result: 'Renamed the helper and updated its callers.',
    changes: [],
    errors: [],
    llmUsage: {
      calls: 3,
      inputTokens: 120,
      outputTokens: 40,
      cacheInputTokens: 900,
      cacheCreateTokens: 12,
      cost: 0.004,
    },
    ...overrides,
  })
}

test('junieSessionArguments pins the verified headless, containment, and update flags', () => {
  const args = junieSessionArguments({ projectPath: PROJECT })

  assert.deepEqual(args, [
    `--project=${PROJECT}`,
    `--input-format=${JUNIE_INPUT_FORMAT}`,
    `--output-format=${JUNIE_OUTPUT_FORMAT}`,
    `--config-default-locations=${JUNIE_CONFIG_DEFAULT_LOCATIONS}`,
    '--skip-update-check',
  ])
  assert.equal(JUNIE_OUTPUT_FORMAT, 'json')
  assert.equal(JUNIE_CONFIG_DEFAULT_LOCATIONS, 'false')
})

test('junieSessionArguments never sends the prompt, a BYOK provider, or brave mode', () => {
  const args = junieSessionArguments({
    projectPath: PROJECT,
    prompt: 'rename the helper',
    model: 'anthropic-claude',
    effort: 'high',
  })

  assert.ok(!args.some((argument) => argument.includes('rename the helper')))
  assert.ok(!args.some((argument) => argument.startsWith('--task')))
  assert.ok(!args.some((argument) => argument.startsWith('--provider')))
  assert.ok(!args.includes('--brave'))
  for (const forbidden of ['--review', '--demo', '--gateway', '--prepare-pr-structure']) {
    assert.ok(!args.includes(forbidden), `${forbidden} is rejected by this release build`)
  }
})

test('junieSessionArguments sends model, the three supported efforts, and a resume pair', () => {
  const args = junieSessionArguments({
    projectPath: PROJECT,
    model: 'gpt-5',
    effort: 'medium',
    sessionId: 'session-260811-012218-18h8',
  })

  assert.ok(args.includes('--model=gpt-5'))
  assert.ok(args.includes('--effort=medium'))
  assert.ok(args.includes('--session-id=session-260811-012218-18h8'))
  assert.ok(args.includes('--resume'))
})

test('junieSessionArguments drops an effort Junie does not define rather than remapping it', () => {
  // Ensync's size selector offers `max`; `junie --help` enumerates only low/medium/high.
  assert.deepEqual([...JUNIE_EFFORTS].sort(), ['high', 'low', 'medium'])
  const args = junieSessionArguments({ projectPath: PROJECT, effort: 'max' })
  assert.ok(!args.some((argument) => argument.startsWith('--effort')))
})

test('junieTerminalOutput finds the result object among unstructured launcher chatter', () => {
  const stdout = [
    '[Junie] checking for updates',
    'not json {',
    cliOutput(),
    '',
  ].join('\n')

  const output = junieTerminalOutput(stdout)
  assert.equal(output.taskName, 'Ensync task')
  assert.equal(output.result, 'Renamed the helper and updated its callers.')
})

test('junieTerminalOutput ignores objects that carry no CliOutput field', () => {
  assert.equal(junieTerminalOutput('{"unrelated":true}\n'), null)
  assert.equal(junieTerminalOutput('plain text only'), null)
})

test('junieReportedErrors keeps only genuine error strings', () => {
  assert.deepEqual(junieReportedErrors({ errors: ['boom', '  ', 7, ' tidy '] }), ['boom', 'tidy'])
  assert.deepEqual(junieReportedErrors({ errors: [] }), [])
  assert.deepEqual(junieReportedErrors({}), [])
})

test('junieUsage maps LlmUsageOutput and reports unusable counters as unknown', () => {
  assert.deepEqual(
    junieUsage({ inputTokens: 120, outputTokens: 40, cacheInputTokens: 900, cost: 0.004 }),
    { source: 'cli', inputTokens: 120, outputTokens: 40, cachedInputTokens: 900 },
  )
  assert.deepEqual(
    junieUsage({ inputTokens: -1, outputTokens: 40, cacheInputTokens: 1.5 }),
    { source: 'cli', inputTokens: null, outputTokens: 40, cachedInputTokens: null },
  )
  assert.equal(junieUsage({ cost: 0.004 }), null)
  assert.equal(junieUsage(null), null)
})

test('a completed run delivers the prompt on stdin and returns the parsed result', async () => {
  const fake = fakeJunie({ stdout: `${cliOutput()}\n` })
  const events = []

  const result = await new JunieExecRunner({ spawnProcess: fake.spawnProcess }).run({
    executable: '/usr/local/bin/junie',
    projectPath: PROJECT,
    prompt: 'Rename the helper.',
    model: 'gpt-5',
    effort: 'high',
    env: {},
  }, { onEvent: (event) => events.push(event) })

  assert.equal(fake.stdinText(), 'Rename the helper.')
  assert.equal(result.provider, 'junie')
  assert.equal(result.response, 'Renamed the helper and updated its callers.')
  assert.equal(result.requestedModel, 'gpt-5')
  assert.equal(result.requestedEffort, 'high')
  assert.deepEqual(result.usage, {
    source: 'cli',
    inputTokens: 120,
    outputTokens: 40,
    cachedInputTokens: 900,
  })

  const started = events.find((event) => event.type === 'started')
  assert.equal(started.provider, 'junie')
  assert.ok(!started.command.includes('Rename the helper.'))
})

test('errors reported inside CliOutput fail the run instead of passing as a result', async () => {
  const fake = fakeJunie({ stdout: `${cliOutput({ errors: ['model request failed'] })}\n` })

  await assert.rejects(
    new JunieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'junie',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'cli_failed')
      assert.match(error.message, /model request failed/)
      return true
    },
  )
})

test('a zero exit with no result object is an unverified run, not a success', async () => {
  const fake = fakeJunie({ stdout: 'Done.\n', exitCode: 0 })

  await assert.rejects(
    new JunieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'junie',
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

test('a completed object with a blank result is reported as an empty response', async () => {
  const fake = fakeJunie({ stdout: `${cliOutput({ result: '   ' })}\n` })

  await assert.rejects(
    new JunieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'junie',
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

test('stderr is surfaced and folded into the failure detail', async () => {
  const fake = fakeJunie({ stdout: '', stderr: 'junie: not authenticated\n', exitCode: 1 })
  const events = []

  await assert.rejects(
    new JunieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'junie',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }, { onEvent: (event) => events.push(event) }),
    (error) => {
      assert.equal(error.code, 'invalid_cli_output')
      assert.match(error.message, /not authenticated/)
      return true
    },
  )
  assert.ok(events.some((event) => event.type === 'output' && event.stream === 'stderr'))
})

test('a silent run is ended by the inactivity watchdog rather than hanging', async () => {
  // This is the droid failure mode: a headless approval request nobody can answer.
  const fake = fakeJunie({ onSpawn: () => {} })

  await holdingEventLoop(() => assert.rejects(
    new JunieExecRunner({ spawnProcess: fake.spawnProcess, inactivityTimeoutMs: 20 }).run({
      executable: 'junie',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'run_timed_out')
      assert.equal(error.status, 504)
      assert.match(error.message, /approval it could not show/)
      return true
    },
  ))
  assert.ok(fake.child.killed.includes('SIGTERM'))
})

test('the hard ceiling stops a run that keeps producing output forever', async () => {
  const fake = fakeJunie({
    onSpawn: (child) => {
      const timer = setInterval(() => child.stdout.write('working\n'), 5)
      timer.unref?.()
      child.stdout.on('close', () => clearInterval(timer))
    },
  })

  await holdingEventLoop(() => assert.rejects(
    new JunieExecRunner({
      spawnProcess: fake.spawnProcess,
      inactivityTimeoutMs: 10_000,
      hardTimeoutMs: 30,
    }).run({
      executable: 'junie',
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
  const fake = fakeJunie({ onSpawn: () => {} })
  const controller = new AbortController()
  const pending = new JunieExecRunner({ spawnProcess: fake.spawnProcess }).run({
    executable: 'junie',
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

test('an already-aborted signal never starts the turn and stays retryable', async () => {
  const fake = fakeJunie({ onSpawn: () => {} })

  await assert.rejects(
    new JunieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'junie',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }, { signal: AbortSignal.abort() }),
    (error) => {
      assert.equal(error.code, 'run_cancelled')
      return true
    },
  )
})

test('a spawn failure before the prompt is written is reported as safe to retry', async () => {
  const fake = fakeJunie({
    onSpawn: (child) => child.emit('error', new Error('spawn ENOENT')),
  })

  await assert.rejects(
    new JunieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'junie',
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
  const fake = fakeJunie({ stdout: `${cliOutput()}\n` })
  const spawnProcess = (executable, args, options) => {
    spawnOptions = options
    return fake.spawnProcess(executable, args, options)
  }

  await new JunieExecRunner({ spawnProcess }).run({
    executable: 'junie',
    projectPath: PROJECT,
    prompt: 'go',
    env: { PATH: '/usr/bin' },
  })

  assert.equal(spawnOptions.cwd, PROJECT)
  assert.equal(spawnOptions.shell, false)
  assert.deepEqual(spawnOptions.env, { PATH: '/usr/bin' })
})
