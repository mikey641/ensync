import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  AUGGIE_DENIED_TOOLS,
  AUGGIE_OUTPUT_FORMAT,
  AUGGIE_PROMPT_TRANSPORT,
  AUGGIE_STDIN_FIRST_CHUNK_DEADLINE_MS,
  AuggieExecRunner,
  auggiePermissionArguments,
  auggiePermissionRuleDropped,
  auggieSessionArguments,
  auggieTerminalResult,
  auggieUsage,
} from './auggie-exec.mjs'

const PROJECT = '/tmp/ensync-auggie-project'

/**
 * Speaks the contract verified against Auggie 0.34.0: the instruction arrives on stdin
 * within the CLI's 100 ms first-chunk window, and `--print --output-format json`
 * answers with a single terminal `{"type":"result",...}` object on stdout.
 */
function fakeAuggie(options = {}) {
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
  let firstChunkAt = null
  child.stdin.on('data', (chunk) => {
    firstChunkAt ??= Date.now()
    stdinChunks.push(chunk.toString('utf8'))
  })

  const spawnProcess = (executable, args, spawnOptions) => {
    child.spawnedWith = { executable, args, spawnOptions }
    child.spawnedAt = Date.now()
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

  return {
    child,
    spawnProcess,
    stdinText: () => stdinChunks.join(''),
    stdinLatencyMs: () => (firstChunkAt === null ? Infinity : firstChunkAt - child.spawnedAt),
  }
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

function resultObject(overrides = {}) {
  return JSON.stringify({
    type: 'result',
    result: 'Renamed the helper and updated its callers.',
    is_error: false,
    subtype: 'success',
    session_id: 'sess-abc123',
    num_turns: 4,
    request_id: 'req-77',
    ...overrides,
  })
}

test('auggieSessionArguments pins print mode, JSON output, and the contained workspace root', () => {
  const args = auggieSessionArguments({ projectPath: PROJECT })

  assert.equal(AUGGIE_OUTPUT_FORMAT, 'json')
  assert.equal(AUGGIE_PROMPT_TRANSPORT, 'stdin')
  assert.ok(args.includes('--print'))
  assert.deepEqual(args.slice(1, 3), ['--output-format', 'json'])
  assert.ok(args.includes('--workspace-root'))
  assert.equal(args[args.indexOf('--workspace-root') + 1], PROJECT)
  assert.ok(args.includes('--no-discover-workspaces'))
  assert.ok(args.includes('--no-update-terminal-title'))
})

test('auggiePermissionArguments denies every shell and network tool by exact name', () => {
  // Auggie's default with NO rules is allow-all (`b2e` returns {allow:true} on an empty
  // policy list), so an unpinned run has no containment at all.
  assert.deepEqual(auggiePermissionArguments(), [
    '--permission', 'launch-process:deny',
    '--permission', 'read-process:deny',
    '--permission', 'write-process:deny',
    '--permission', 'kill-process:deny',
    '--permission', 'list-processes:deny',
    '--permission', 'web-fetch:deny',
  ])
  // Names are verbatim from `auggie tools list`; rules match on exact tool name only.
  for (const tool of AUGGIE_DENIED_TOOLS) {
    assert.match(tool, /^[a-zA-Z0-9_-]+$/, 'the CLI parser rejects any other character')
  }
})

test('auggieSessionArguments leaves editing tools enabled so a task can actually be done', () => {
  const args = auggieSessionArguments({ projectPath: PROJECT })

  for (const editor of ['save-file', 'str-replace-editor', 'apply_patch', 'remove-files', 'view']) {
    assert.ok(!args.includes(`${editor}:deny`), `${editor} must stay usable`)
  }
  // `ask-user` is never sent: a --print run has no approval handler, so it resolves to
  // the same denial with a vaguer explanation to the model.
  assert.ok(!args.some((argument) => argument.endsWith(':ask-user')))
  assert.ok(!args.some((argument) => argument.endsWith(':allow')))
})

test('auggieSessionArguments never puts the prompt, an instruction file, or ask mode in argv', () => {
  const args = auggieSessionArguments({
    projectPath: PROJECT,
    prompt: 'rename the helper',
    model: 'claude-sonnet',
    effort: 'high',
  })

  assert.ok(!args.some((argument) => argument.includes('rename the helper')))
  for (const forbidden of [
    '-i', '--instruction', '-if', '--instruction-file',
    '-a', '--ask', '-q', '--quiet', '--enhance-prompt', '-c', '--continue',
  ]) {
    assert.ok(!args.includes(forbidden), `${forbidden} must never be sent`)
  }
})

test('auggieSessionArguments sends a model and a resume ID but drops effort, which Auggie has no flag for', () => {
  const args = auggieSessionArguments({
    projectPath: PROJECT,
    model: 'claude-sonnet',
    effort: 'max',
    sessionId: 'sess-abc123',
    maxTurns: 40,
  })

  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet')
  assert.equal(args[args.indexOf('--resume') + 1], 'sess-abc123')
  assert.equal(args[args.indexOf('--max-turns') + 1], '40')
  // No effort/reasoning flag exists in `auggie --help`; `--persona` means something else.
  assert.ok(!args.some((argument) => argument.startsWith('--effort')))
  assert.ok(!args.includes('--persona'))
})

test('auggieSessionArguments ignores an unusable --max-turns rather than sending garbage', () => {
  for (const maxTurns of [0, -3, 1.5, '40', null]) {
    const args = auggieSessionArguments({ projectPath: PROJECT, maxTurns })
    assert.ok(!args.includes('--max-turns'), `max-turns ${String(maxTurns)} must be dropped`)
  }
})

test('auggieTerminalResult finds the result object among unstructured CLI chatter', () => {
  const stdout = [
    'Warning: Could not fetch tenant MCP server configurations: Please configure Augment API URL',
    'not json {',
    '{"type":"progress","noise":true}',
    resultObject(),
    '',
  ].join('\n')

  const result = auggieTerminalResult(stdout)
  assert.equal(result.type, 'result')
  assert.equal(result.result, 'Renamed the helper and updated its callers.')
  assert.equal(result.session_id, 'sess-abc123')
})

test('auggieTerminalResult ignores objects that are not the terminal result frame', () => {
  assert.equal(auggieTerminalResult('{"unrelated":true}\n'), null)
  assert.equal(auggieTerminalResult('plain text only'), null)
  assert.equal(auggieTerminalResult(null), null)
})

test('auggiePermissionRuleDropped reads the only signal that containment weakened', () => {
  const warning = 'WARNING: Failed to parse permission rule "launch-process": Policy cannot be empty'
  assert.equal(auggiePermissionRuleDropped(warning, ''), true)
  assert.equal(auggiePermissionRuleDropped('', warning), true)
  assert.equal(auggiePermissionRuleDropped('all good', ''), false)
  assert.equal(auggiePermissionRuleDropped(null, undefined), false)
})

test('auggieUsage reports unknown because the billing block carries cost, not tokens', () => {
  assert.equal(auggieUsage({ usage_unit: 'credits', total_cost: 3 }), null)
  assert.equal(auggieUsage(undefined), null)
})

test('a completed run delivers the prompt on stdin and returns the parsed result', async () => {
  const fake = fakeAuggie({ stdout: `${resultObject()}\n` })
  const events = []

  const result = await new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
    executable: '/opt/homebrew/bin/auggie',
    projectPath: PROJECT,
    prompt: 'Rename the helper.',
    model: 'claude-sonnet',
    effort: 'high',
    env: {},
  }, { onEvent: (event) => events.push(event) })

  assert.equal(fake.stdinText(), 'Rename the helper.')
  assert.equal(result.provider, 'auggie')
  assert.equal(result.response, 'Renamed the helper and updated its callers.')
  assert.equal(result.sessionId, 'sess-abc123')
  assert.equal(result.requestedModel, 'claude-sonnet')
  assert.equal(result.requestedEffort, 'high')
  assert.equal(result.usage, null)

  const started = events.find((event) => event.type === 'started')
  assert.equal(started.provider, 'auggie')
  assert.ok(!started.command.includes('Rename the helper.'))
})

test('the prompt beats the CLI 100 ms stdin deadline because it is written before anything awaits', async () => {
  const fake = fakeAuggie({ stdout: `${resultObject()}\n` })

  await new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
    executable: 'auggie',
    projectPath: PROJECT,
    prompt: 'go',
    env: {},
  })

  assert.ok(
    fake.stdinLatencyMs() < AUGGIE_STDIN_FIRST_CHUNK_DEADLINE_MS,
    `first stdin chunk must land inside the ${AUGGIE_STDIN_FIRST_CHUNK_DEADLINE_MS} ms window Auggie allows`,
  )
})

test('a dropped permission rule fails the run even when the answer looks fine', async () => {
  const fake = fakeAuggie({
    stdout: [
      'WARNING: Failed to parse permission rule "launch-process": Policy cannot be empty',
      resultObject(),
      '',
    ].join('\n'),
  })

  await assert.rejects(
    new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'auggie',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'provider_containment_unverified')
      assert.equal(error.status, 409)
      return true
    },
  )
})

test('an error_during_execution result fails instead of passing as an answer', async () => {
  const fake = fakeAuggie({
    stdout: `${resultObject({ is_error: true, subtype: 'error_during_execution' })}\n`,
  })

  await assert.rejects(
    new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'auggie',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'cli_failed')
      assert.match(error.message, /error_during_execution/)
      return true
    },
  )
})

test('empty_completion is a failure even though Auggie itself sets is_error false', async () => {
  const fake = fakeAuggie({
    stdout: `${resultObject({ is_error: false, subtype: 'empty_completion', result: '' })}\n`,
  })

  await assert.rejects(
    new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'auggie',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'empty_cli_response')
      assert.equal(error.safeToRetry, true)
      return true
    },
  )
})

test('error_max_turns is reported as a stopped run, not a completed one', async () => {
  const fake = fakeAuggie({
    stdout: `${resultObject({ is_error: true, subtype: 'error_max_turns' })}\n`,
  })

  await assert.rejects(
    new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'auggie',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'cli_failed')
      assert.match(error.message, /maximum number of agentic turns/)
      return true
    },
  )
})

test('a zero exit with no result object is an unverified run, not a success', async () => {
  const fake = fakeAuggie({ stdout: 'Done.\n', exitCode: 0 })

  await assert.rejects(
    new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'auggie',
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

test('a successful result with a blank message is reported as an empty response', async () => {
  const fake = fakeAuggie({ stdout: `${resultObject({ result: '   ' })}\n` })

  await assert.rejects(
    new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'auggie',
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
  const fake = fakeAuggie({
    stdout: '',
    stderr: "You are not currently logged in to Augment.\n",
    exitCode: 1,
  })
  const events = []

  await assert.rejects(
    new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'auggie',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }, { onEvent: (event) => events.push(event) }),
    (error) => {
      assert.equal(error.code, 'invalid_cli_output')
      assert.match(error.message, /not currently logged in/)
      return true
    },
  )
  assert.ok(events.some((event) => event.type === 'output' && event.stream === 'stderr'))
})

test('a silent run is ended by the inactivity watchdog rather than hanging', async () => {
  // This is the droid failure mode: a headless approval request nobody can answer.
  const fake = fakeAuggie({ onSpawn: () => {} })

  await holdingEventLoop(() => assert.rejects(
    new AuggieExecRunner({ spawnProcess: fake.spawnProcess, inactivityTimeoutMs: 20 }).run({
      executable: 'auggie',
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
  const fake = fakeAuggie({
    onSpawn: (child) => {
      const timer = setInterval(() => child.stdout.write('working\n'), 5)
      timer.unref?.()
      child.stdout.on('close', () => clearInterval(timer))
    },
  })

  await holdingEventLoop(() => assert.rejects(
    new AuggieExecRunner({
      spawnProcess: fake.spawnProcess,
      inactivityTimeoutMs: 10_000,
      hardTimeoutMs: 30,
    }).run({
      executable: 'auggie',
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
  const fake = fakeAuggie({ onSpawn: () => {} })
  const controller = new AbortController()
  const pending = new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
    executable: 'auggie',
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

test('an already-aborted signal reports run_cancelled instead of waiting for a turn', async () => {
  const fake = fakeAuggie({ onSpawn: () => {} })

  await assert.rejects(
    new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'auggie',
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

test('a spawn failure is reported as a start failure that is safe to retry', async () => {
  const fake = fakeAuggie({
    onSpawn: (child) => child.emit('error', new Error('spawn ENOENT')),
  })

  await assert.rejects(
    new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
      executable: 'auggie',
      projectPath: PROJECT,
      prompt: 'go',
      env: {},
    }),
    (error) => {
      assert.equal(error.code, 'run_start_failed')
      assert.equal(error.safeToRetry, true)
      assert.match(error.message, /spawn ENOENT/)
      return true
    },
  )
})

test('the child is spawned in the contained project directory with no shell', async () => {
  const fake = fakeAuggie({ stdout: `${resultObject()}\n` })

  await new AuggieExecRunner({ spawnProcess: fake.spawnProcess }).run({
    executable: 'auggie',
    projectPath: PROJECT,
    prompt: 'go',
    env: { PATH: '/usr/bin' },
  })

  assert.equal(fake.child.spawnedWith.spawnOptions.cwd, PROJECT)
  assert.equal(fake.child.spawnedWith.spawnOptions.shell, false)
  assert.deepEqual(fake.child.spawnedWith.spawnOptions.env, { PATH: '/usr/bin' })
})
