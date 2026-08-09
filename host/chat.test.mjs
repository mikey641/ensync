import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ChatRunError,
  ChatRunService,
  parseClaudeChatResult,
  parseCodexChatResult,
  quotaFailureIsSafe,
  redactTerminalText,
  validateAttachmentPaths,
  validateProjectPath,
} from './chat.mjs'
import { createRelayHost } from './server.mjs'

async function projectFixture(context) {
  const projectPath = await mkdtemp(join(tmpdir(), 'relay-chat-test-'))
  context.after(() => rm(projectPath, { recursive: true, force: true }))
  return projectPath
}

function statusService(provider) {
  return {
    async get(id, options) {
      assert.equal(id, provider.id)
      assert.deepEqual(options, { refresh: true })
      return provider
    },
  }
}

function readyProvider(id) {
  return {
    id,
    name: id === 'codex' ? 'Codex' : 'Claude Code',
    installed: true,
    executable: `/test/bin/${id}`,
    authentication: {
      state: 'authenticated',
      method: id === 'codex' ? 'ChatGPT login' : 'claude.ai OAuth',
      reason: `${id} is logged in.`,
    },
  }
}

test('project validation requires an existing non-root absolute directory', async (context) => {
  const projectPath = await projectFixture(context)
  assert.equal(await validateProjectPath(projectPath), await realpath(projectPath))

  await assert.rejects(
    validateProjectPath('relative/project'),
    (error) => error instanceof ChatRunError && error.code === 'invalid_project',
  )
  await assert.rejects(
    validateProjectPath(join(projectPath, 'missing')),
    (error) => error instanceof ChatRunError && error.code === 'invalid_project',
  )
})

test('project validation enforces configured host roots', async (context) => {
  const allowedRoot = await projectFixture(context)
  const outsideRoot = await projectFixture(context)

  await assert.rejects(
    validateProjectPath(outsideRoot, { allowedRoots: [allowedRoot] }),
    (error) => error instanceof ChatRunError && error.code === 'project_not_allowed',
  )
})

test('Codex chat uses stdin, validated cwd, scrubbed environment, and CLI JSON only', async (context) => {
  const projectPath = await projectFixture(context)
  const calls = []
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    environment: {
      PATH: '/test/bin',
      OPENAI_API_KEY: 'must-not-leak',
      ANTHROPIC_API_KEY: 'must-not-leak',
      RELAY_TEST_VALUE: 'kept',
    },
    processRunner: async (...call) => {
      calls.push(call)
      return {
        exitCode: 0,
        error: null,
        timedOut: false,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Real Codex response' },
          }),
          JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 21, output_tokens: 8, cached_input_tokens: 3 },
          }),
        ].join('\n'),
      }
    },
  })

  const result = await service.run({
    provider: 'codex',
    projectPath,
    prompt: 'Inspect this project',
    model: 'gpt-5.4',
    effort: 'high',
    timeoutMs: 2_000,
  })

  assert.equal(calls.length, 1)
  const [executable, args, options] = calls[0]
  assert.equal(executable, '/test/bin/codex')
  assert.deepEqual(args, ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '--model', 'gpt-5.4', '-c', 'model_reasoning_effort="high"', '-'])
  assert.equal(options.cwd, await realpath(projectPath))
  assert.equal(options.input, 'Inspect this project')
  assert.equal(options.inactivityTimeoutMs, 2_000)
  assert.equal(options.hardTimeoutMs, 2_000)
  assert.equal(options.env.OPENAI_API_KEY, undefined)
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(options.env.RELAY_TEST_VALUE, 'kept')
  assert.equal(result.response, 'Real Codex response')
  assert.equal(result.sessionId, '123e4567-e89b-12d3-a456-426614174000')
  assert.equal(result.requestedEffort, 'high')
  assert.deepEqual(result.usage, {
    source: 'cli',
    inputTokens: 21,
    outputTokens: 8,
    cachedInputTokens: 3,
  })
})

test('Codex provider default omits the model argument', async (context) => {
  const projectPath = await projectFixture(context)
  let capturedArgs
  let capturedOptions
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    processRunner: async (_executable, args, options) => {
      capturedArgs = args
      capturedOptions = options
      return {
        exitCode: 0,
        error: null,
        timedOut: false,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Default model response' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      }
    },
  })

  const result = await service.run({ provider: 'codex', projectPath, prompt: 'Use the default' })
  assert.equal(capturedArgs.includes('--model'), false)
  assert.equal(capturedArgs.includes('-c'), false)
  assert.equal(capturedOptions.inactivityTimeoutMs, 15 * 60 * 1_000)
  assert.equal(capturedOptions.hardTimeoutMs, 2 * 60 * 60 * 1_000)
  assert.equal(result.requestedModel, null)
  assert.equal(result.requestedEffort, null)
})

test('retained Codex jobs use the live runner and validate steering through the same Host service', async (context) => {
  const projectPath = await projectFixture(context)
  let liveInput
  let releaseRun
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const steers = []
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    environment: { PATH: '/test/bin', OPENAI_API_KEY: 'must-not-leak' },
    processRunner: async () => { throw new Error('codex exec must not start for a retained live job') },
    codexLiveTurnRunner: {
      run: async (input) => {
        liveInput = input
        markStarted()
        return new Promise((resolve) => { releaseRun = resolve })
      },
      steer: async (jobId, prompt, attachments) => {
        steers.push({ jobId, prompt, attachments })
        return { turnId: 'provider-turn-1' }
      },
    },
  })

  const run = service.run({
    provider: 'codex',
    projectPath,
    prompt: 'Start live',
    effort: 'medium',
  }, { liveTurnId: 'job_1111111111111111' })
  await started

  assert.equal(service.hasRunningRuns(), true)
  assert.equal(liveInput.id, 'job_1111111111111111')
  assert.equal(liveInput.prompt, 'Start live')
  assert.equal(liveInput.effort, 'medium')
  assert.equal(liveInput.env.OPENAI_API_KEY, undefined)
  assert.deepEqual(await service.steer('job_1111111111111111', { prompt: 'Correct it now' }), {
    turnId: 'provider-turn-1',
  })
  assert.deepEqual(steers, [{
    jobId: 'job_1111111111111111', prompt: 'Correct it now', attachments: [],
  }])

  releaseRun({
    provider: 'codex', projectPath, response: 'done', sessionId: 'session', model: null,
    requestedModel: null, requestedEffort: 'medium', usage: null, durationMs: 1,
    completedAt: '2026-08-07T12:00:00.000Z',
  })
  assert.equal((await run).response, 'done')
  assert.equal(service.hasRunningRuns(), false)
})

test('every local file type validates and Codex receives supported images on new or resumed turns', async (context) => {
  const projectPath = await projectFixture(context)
  const imagePath = join(projectPath, 'reference image.png')
  const arbitraryFilePath = join(projectPath, 'requirements.custom-format')
  await writeFile(imagePath, 'image fixture')
  await writeFile(arbitraryFilePath, 'custom fixture')
  const resolvedImagePath = await realpath(imagePath)
  const resolvedArbitraryPath = await realpath(arbitraryFilePath)
  assert.deepEqual(
    await validateAttachmentPaths([imagePath, arbitraryFilePath, imagePath]),
    [resolvedImagePath, resolvedArbitraryPath],
  )

  const sessionId = '123e4567-e89b-12d3-a456-426614174000'
  let capturedArgs
  const events = []
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    processRunner: async (_executable, args) => {
      capturedArgs = args
      return {
        exitCode: 0,
        error: null,
        timedOut: false,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Files inspected' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      }
    },
  })

  await service.run({
    provider: 'codex',
    projectPath,
    prompt: 'Inspect both explicitly attached files.',
    attachments: [imagePath, arbitraryFilePath],
    sessionId,
  }, { onEvent: (event) => events.push(event) })

  assert.deepEqual(capturedArgs, [
    'exec',
    'resume',
    '--image',
    resolvedImagePath,
    '--json',
    '--skip-git-repo-check',
    sessionId,
    '-',
  ])
  assert.equal(capturedArgs.includes(resolvedArbitraryPath), false)
  assert.match(events[0].command, /--image '<attached-image>'/)
  assert.equal(events[0].command.includes(resolvedImagePath), false)
})

test('attachment validation rejects missing, relative, and non-file paths before a CLI starts', async (context) => {
  const projectPath = await projectFixture(context)
  await assert.rejects(
    validateAttachmentPaths(['relative.png']),
    (error) => error instanceof ChatRunError && error.code === 'invalid_attachment',
  )
  await assert.rejects(
    validateAttachmentPaths([join(projectPath, 'missing.png')]),
    (error) => error instanceof ChatRunError && error.code === 'invalid_attachment',
  )
  await assert.rejects(
    validateAttachmentPaths([projectPath]),
    (error) => error instanceof ChatRunError && error.code === 'invalid_attachment',
  )
})

test('a started local CLI run invalidates shared provider telemetry before returning', async (context) => {
  const projectPath = await projectFixture(context)
  let invalidations = 0
  const provider = readyProvider('codex')
  const service = new ChatRunService({
    statusService: {
      async get(id, options) {
        assert.equal(id, provider.id)
        assert.deepEqual(options, { refresh: true })
        return provider
      },
      invalidate() {
        invalidations += 1
      },
    },
    processRunner: async () => ({
      exitCode: 0,
      error: null,
      timedOut: false,
      stderr: '',
      stdout: [
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }),
        JSON.stringify({ type: 'turn.completed' }),
      ].join('\n'),
    }),
  })

  await service.run({ provider: 'codex', projectPath, prompt: 'Complete one task' })
  assert.equal(invalidations, 1)
})

test('a signal-terminated local provider never reports a null exit code', async (context) => {
  const projectPath = await projectFixture(context)
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    processRunner: async () => ({
      exitCode: null,
      signal: 'SIGTERM',
      error: null,
      timedOut: false,
      aborted: false,
      stderr: 'apply_patch verification failed',
      stdout: '',
    }),
  })

  await assert.rejects(
    service.run({ provider: 'codex', projectPath, prompt: 'Continue safely' }),
    (error) =>
      error instanceof ChatRunError
      && error.code === 'cli_failed'
      && error.safeToRetry === false
      && error.message.includes('terminated by signal SIGTERM')
      && error.message.includes('apply_patch verification failed')
      && !error.message.includes('code null'),
  )
})

test('Codex resumed chat applies the effort config at exec resume scope', async (context) => {
  const projectPath = await projectFixture(context)
  const sessionId = '123e4567-e89b-12d3-a456-426614174000'
  let capturedArgs
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    processRunner: async (_executable, args) => {
      capturedArgs = args
      return {
        exitCode: 0,
        error: null,
        timedOut: false,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Resumed with low effort' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      }
    },
  })

  const result = await service.run({ provider: 'codex', projectPath, prompt: 'Continue', sessionId, effort: 'low' })
  assert.deepEqual(capturedArgs, [
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
    '-c',
    'model_reasoning_effort="low"',
    sessionId,
    '-',
  ])
  assert.equal(result.requestedEffort, 'low')
})

test('live execution events preserve CLI line boundaries, redact secrets, and keep raw streams out of the result', async (context) => {
  const projectPath = await projectFixture(context)
  const cliLines = [
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'api_key=super-secret-value-12345' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', phase: 'commentary', text: 'Checking authorization=provider-note-secret' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', phase: 'final_answer', text: 'Verified response' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ]
  const stdout = cliLines.join('\n')
  const events = []
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    processRunner: async (_executable, _args, options) => {
      const boundary = cliLines[0].indexOf('secret')
      options.onStdout(stdout.slice(0, boundary))
      options.onStdout(stdout.slice(boundary, cliLines[0].length + 1))
      options.onStdout(stdout.slice(cliLines[0].length + 1))
      options.onStderr('provider diagnostic\n')
      return { exitCode: 0, error: null, timedOut: false, stderr: 'provider diagnostic', stdout }
    },
  })

  const result = await service.run(
    { provider: 'codex', projectPath, prompt: 'Inspect' },
    { onEvent: (event) => events.push(event) },
  )

  assert.equal(events[0].type, 'started')
  assert.equal(events[0].command, '/test/bin/codex exec --json --color never --skip-git-repo-check -')
  const output = events.filter((event) => event.type === 'output')
  assert.equal(output.some((event) => event.stream === 'stderr' && event.text === 'provider diagnostic\n'), true)
  assert.equal(output.some((event) => event.redacted && event.text.includes('api_key=[REDACTED]')), true)
  assert.equal(JSON.stringify(output).includes('super-secret-value-12345'), false)
  const notes = events.filter((event) => event.type === 'note')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].provider, 'codex')
  assert.equal(notes[0].redacted, true)
  assert.equal(notes[0].text, 'Checking authorization=[REDACTED]')
  assert.equal(JSON.stringify(notes).includes('provider-note-secret'), false)
  assert.equal(result.response, 'Verified response')
  assert.equal('stdout' in result, false)
  assert.equal('stderr' in result, false)
})

test('terminal redaction covers provider tokens, bearer values, and authorization assignments', () => {
  const safe = redactTerminalText('ghp_1234567890abcdefghijkl Bearer abcdefghijklmnop authorization=top-secret-value')
  assert.equal(safe.redacted, true)
  assert.equal(safe.text.includes('1234567890abcdefghijkl'), false)
  assert.equal(safe.text.includes('abcdefghijklmnop'), false)
  assert.equal(safe.text.includes('top-secret-value'), false)
})

test('Claude chat resumes a verified session without putting the prompt in arguments', async (context) => {
  const projectPath = await projectFixture(context)
  const sessionId = '123e4567-e89b-12d3-a456-426614174000'
  let captured
  const events = []
  const service = new ChatRunService({
    statusService: statusService(readyProvider('claude')),
    processRunner: async (...call) => {
      captured = call
      const stdout = [
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          model: 'claude-opus-4-6',
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'I found the affected test and am updating it.' },
              { type: 'tool_use', id: 'tool-1', name: 'Edit', input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Real Claude response' }] },
        }),
        JSON.stringify({
          type: 'result',
          is_error: false,
          result: 'Real Claude response',
          session_id: sessionId,
          usage: { input_tokens: 34, output_tokens: 13, cache_read_input_tokens: 5 },
          modelUsage: { 'claude-opus-4-6': { inputTokens: 34, outputTokens: 13 } },
        }),
      ].join('\n')
      call[2].onStdout(stdout)
      return {
        exitCode: 0,
        error: null,
        timedOut: false,
        stderr: '',
        stdout,
      }
    },
  })

  const result = await service.run({
    provider: 'claude',
    projectPath,
    prompt: 'Continue the implementation',
    sessionId,
    effort: 'max',
  }, { onEvent: (event) => events.push(event) })

  assert.deepEqual(captured[1], [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--effort',
    'max',
    '--resume',
    sessionId,
  ])
  assert.equal(captured[2].input, 'Continue the implementation')
  assert.equal(result.response, 'Real Claude response')
  assert.equal(result.model, 'claude-opus-4-6')
  assert.equal(result.requestedEffort, 'max')
  assert.deepEqual(result.usage, {
    source: 'cli',
    inputTokens: 34,
    outputTokens: 13,
    cachedInputTokens: 5,
  })
  assert.deepEqual(
    events.filter((event) => event.type === 'note').map((event) => ({ provider: event.provider, text: event.text })),
    [{ provider: 'claude', text: 'I found the affected test and am updating it.' }],
  )
})

test('Claude progress notes survive per-content-block assistant events', async (context) => {
  const projectPath = await projectFixture(context)
  const sessionId = '123e4567-e89b-12d3-a456-426614174000'
  const events = []
  // Claude Code 2.1.223 emits one assistant event per content block, so the
  // commentary text and the tool call that justifies showing it arrive as
  // separate lines that share a message ID.
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-4-6' }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'thinking', thinking: 'hidden reasoning' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'text', text: 'Reading the failing test first.' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file body' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_b', content: [{ type: 'thinking', thinking: 'more hidden reasoning' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_b', content: [{ type: 'text', text: 'Real Claude response' }] } }),
    JSON.stringify({ type: 'result', is_error: false, result: 'Real Claude response', session_id: sessionId }),
  ].join('\n')

  const service = new ChatRunService({
    statusService: statusService(readyProvider('claude')),
    processRunner: async (_executable, _args, options) => {
      options.onStdout(stdout)
      return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout }
    },
  })

  const result = await service.run(
    { provider: 'claude', projectPath, prompt: 'Fix the test' },
    { onEvent: (event) => events.push(event) },
  )

  assert.equal(result.response, 'Real Claude response')
  assert.deepEqual(
    events.filter((event) => event.type === 'note').map((event) => ({ provider: event.provider, text: event.text })),
    [{ provider: 'claude', text: 'Reading the failing test first.' }],
  )
  assert.equal(JSON.stringify(events.filter((event) => event.type === 'note')).includes('hidden reasoning'), false)
})

test('chat refuses unsupported providers and non-subscription authentication', async (context) => {
  const projectPath = await projectFixture(context)
  let processCalls = 0
  const apiKeyProvider = readyProvider('codex')
  apiKeyProvider.authentication.method = 'API key'
  const service = new ChatRunService({
    statusService: statusService(apiKeyProvider),
    processRunner: async () => {
      processCalls += 1
      throw new Error('process must not run')
    },
  })

  await assert.rejects(
    service.run({ provider: 'copilot', projectPath, prompt: 'Hello' }),
    (error) => error instanceof ChatRunError && error.code === 'unsupported_provider',
  )
  await assert.rejects(
    service.run({ provider: 'codex', projectPath, prompt: 'Hello' }),
    (error) =>
      error instanceof ChatRunError
      && error.code === 'subscription_auth_required'
      && error.safeToRetry === true,
  )
  await assert.rejects(
    service.run({ provider: 'codex', projectPath, prompt: 'Hello', effort: 'ultra' }),
    (error) => error instanceof ChatRunError && error.code === 'invalid_effort',
  )
  assert.equal(processCalls, 0)
})

test('chat timeout and malformed CLI output are explicit failures', async (context) => {
  const projectPath = await projectFixture(context)
  const timeoutService = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    processRunner: async () => ({
      exitCode: null,
      error: null,
      timedOut: true,
      timeoutReason: 'inactivity',
      stderr: '',
      stdout: '',
    }),
  })
  await assert.rejects(
    timeoutService.run({ provider: 'codex', projectPath, prompt: 'Hello' }),
    (error) =>
      error instanceof ChatRunError
      && error.code === 'run_timed_out'
      && error.safeToRetry === false
      && error.message.includes('no CLI output or lifecycle progress')
      && error.message.includes('Partial work may exist'),
  )

  const hardTimeoutService = new ChatRunService({
    statusService: statusService(readyProvider('claude')),
    processRunner: async () => ({
      exitCode: null,
      error: null,
      timedOut: true,
      timeoutReason: 'hard_limit',
      stderr: '',
      stdout: '',
    }),
  })
  await assert.rejects(
    hardTimeoutService.run({ provider: 'claude', projectPath, prompt: 'Hello' }),
    (error) =>
      error instanceof ChatRunError
      && error.code === 'run_timed_out'
      && error.safeToRetry === false
      && error.message.includes('hard run limit')
      && error.message.includes('Partial work may exist'),
  )

  assert.throws(
    () => parseCodexChatResult('not json'),
    (error) => error instanceof ChatRunError && error.code === 'invalid_cli_output',
  )
  assert.throws(
    () => parseClaudeChatResult(JSON.stringify({ is_error: false, result: '' })),
    (error) => error instanceof ChatRunError && error.code === 'empty_cli_response',
  )
})

test('successful provider streams receive bounded repair before Ensync surfaces an error', () => {
  const codexOutput = [
    'Ensync Host returned a malformed execution event.',
    `\u001b[32m${JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' })}\u001b[0m`,
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Recovered Codex response' },
    }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n')
  const codex = parseCodexChatResult(codexOutput)

  assert.equal(codex.response, 'Recovered Codex response')
  assert.deepEqual(codex.outputRecovery, {
    applied: true,
    normalizedLineCount: 1,
    discardedLineCount: 1,
  })

  const claude = parseClaudeChatResult([
    'Claude Code emitted a one-line startup diagnostic.',
    JSON.stringify({ type: 'result', is_error: false, result: 'Recovered Claude response' }),
  ].join('\n'))
  assert.equal(claude.response, 'Recovered Claude response')
  assert.deepEqual(claude.outputRecovery, {
    applied: true,
    normalizedLineCount: 0,
    discardedLineCount: 1,
  })

  const excessiveNoise = [
    ...Array.from({ length: 33 }, (_, index) => `diagnostic ${index}`),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n')
  assert.throws(
    () => parseCodexChatResult(excessiveNoise),
    (error) =>
      error instanceof ChatRunError
      && error.code === 'invalid_cli_output'
      && error.safeToRetry === false
      && error.message.includes('bounded repair'),
  )
})

test('quota retry safety requires a structured terminal failure with zero activity', () => {
  const codexSafe = [
    JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'Usage limit reached' } }),
  ].join('\n')
  const codexWithCommand = [
    JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
    JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'touch changed.txt' },
    }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'Rate limit reached' } }),
  ].join('\n')
  const claudeSafe = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'result', is_error: true, result: 'Quota exceeded' }),
  ].join('\n')
  const claudeWithTool = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Write' }] },
    }),
    JSON.stringify({ type: 'result', is_error: true, result: 'Capacity unavailable' }),
  ].join('\n')
  const codexWithUnknownWork = [
    JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
    JSON.stringify({ type: 'item.started', item: { type: 'future_work_item' } }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'Usage limit reached' } }),
  ].join('\n')
  const claudeWithUnknownBlock = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'future_activity' }] } }),
    JSON.stringify({ type: 'result', is_error: true, result: 'Quota exceeded' }),
  ].join('\n')
  const claudeIncomplete = [
    JSON.stringify({ type: 'result', is_error: true, result: 'Quota exceeded' }),
    JSON.stringify({ type: 'system', subtype: 'trailing-unknown-state' }),
  ].join('\n')

  assert.equal(quotaFailureIsSafe('codex', codexSafe), true)
  assert.equal(quotaFailureIsSafe('codex', codexWithCommand), false)
  assert.equal(quotaFailureIsSafe('codex', codexWithUnknownWork), false)
  assert.equal(quotaFailureIsSafe('codex', `unverified diagnostic\n${codexSafe}`), false)
  assert.equal(quotaFailureIsSafe('codex', `\u001b[32m${codexSafe}\u001b[0m`), false)
  assert.equal(quotaFailureIsSafe('codex', '', 'Usage limit reached'), false)
  assert.equal(quotaFailureIsSafe('claude', claudeSafe), true)
  assert.equal(quotaFailureIsSafe('claude', claudeWithTool), false)
  assert.equal(quotaFailureIsSafe('claude', claudeWithUnknownBlock), false)
  assert.equal(quotaFailureIsSafe('claude', claudeIncomplete), false)
})

test('safe quota failure and unsafe tool failure have different error contracts', () => {
  const safeOutput = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'result', is_error: true, result: 'Rate limit reached' }),
  ].join('\n')
  const unsafeOutput = [
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] },
    }),
    JSON.stringify({ type: 'result', is_error: true, result: 'Rate limit reached' }),
  ].join('\n')

  assert.throws(
    () => parseClaudeChatResult(safeOutput),
    (error) =>
      error instanceof ChatRunError
      && error.code === 'provider_quota'
      && error.status === 429
      && error.safeToRetry === true,
  )
  assert.throws(
    () => parseClaudeChatResult(unsafeOutput),
    (error) =>
      error instanceof ChatRunError
      && error.code === 'cli_failed'
      && error.safeToRetry === false,
  )
})

test('POST /api/chat/run returns only the injected host runner result', async (context) => {
  const expected = {
    provider: 'codex',
    projectPath: '/verified/project',
    response: 'Verified response',
    sessionId: null,
    model: null,
    requestedModel: null,
    usage: null,
    durationMs: 12,
    completedAt: '2026-08-05T12:00:00.000Z',
  }
  let received
  const server = createRelayHost({
    chatService: {
      async run(request) {
        received = request
        return expected
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())

  const address = server.address()
  assert.equal(typeof address, 'object')
  const request = { provider: 'codex', projectPath: '/project', prompt: 'Hello' }
  const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(received, request)
  assert.deepEqual(await response.json(), expected)
})

test('POST /api/chat/run exposes retry safety without implying every quota string is safe', async (context) => {
  const server = createRelayHost({
    chatService: {
      async run() {
        throw new ChatRunError('provider_quota', 'Verified quota failure.', 429, true)
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())

  const address = server.address()
  assert.equal(typeof address, 'object')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'codex', projectPath: '/project', prompt: 'Hello' }),
  })

  assert.equal(response.status, 429)
  assert.deepEqual(await response.json(), {
    error: 'Verified quota failure.',
    code: 'provider_quota',
    safeToRetry: true,
  })
})

test('POST /api/chat/run/stream flushes observed CLI events before completion and returns a bounded final result event', async (context) => {
  let releaseRun
  const waitForRelease = new Promise((resolve) => { releaseRun = resolve })
  const expected = {
    provider: 'codex',
    projectPath: '/verified/project',
    response: 'Verified response',
    sessionId: null,
    model: null,
    requestedModel: null,
    usage: null,
    durationMs: 12,
    completedAt: '2026-08-05T12:00:00.000Z',
  }
  const server = createRelayHost({
    chatService: {
      async run(_request, options) {
        options.onEvent({
          type: 'started',
          provider: 'codex',
          cwd: '/verified/project',
          command: '/test/bin/codex exec -',
          at: '2026-08-05T11:59:59.000Z',
        })
        await waitForRelease
        return expected
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())

  const address = server.address()
  assert.equal(typeof address, 'object')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/run/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'codex', projectPath: '/project', prompt: 'Hello' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const first = decoder.decode((await reader.read()).value)
  assert.equal(JSON.parse(first.trim()).type, 'started')

  releaseRun()
  let remainder = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    remainder += decoder.decode(chunk.value, { stream: true })
  }
  const completed = remainder.trim().split('\n').map((line) => JSON.parse(line)).at(-1)
  assert.equal(completed.type, 'completed')
  assert.deepEqual(completed.result, expected)
  assert.equal('stdout' in completed.result, false)
  assert.equal('stderr' in completed.result, false)
})

test('POST /api/chat/run/stream represents a safe pre-activity failure inside the stream', async (context) => {
  const server = createRelayHost({
    chatService: {
      async run() {
        throw new ChatRunError('provider_quota', 'Verified quota failure.', 429, true)
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())

  const address = server.address()
  assert.equal(typeof address, 'object')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/run/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'codex', projectPath: '/project', prompt: 'Hello' }),
  })
  assert.equal(response.status, 200)
  const event = JSON.parse((await response.text()).trim())
  assert.equal(typeof event.at, 'string')
  delete event.at
  assert.deepEqual(event, {
    type: 'error',
    error: 'Verified quota failure.',
    code: 'provider_quota',
    status: 429,
    safeToRetry: true,
  })
})

test('ChatRunService passes cancellation to the exact process and never classifies it as retryable', async (context) => {
  const projectPath = await projectFixture(context)
  const controller = new AbortController()
  let receivedSignal
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    processRunner: async (_executable, _args, options) => {
      receivedSignal = options.signal
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
      return { exitCode: null, signal: 'SIGTERM', error: null, timedOut: false, aborted: true, stdout: '', stderr: '' }
    },
  })

  const run = service.run(
    { provider: 'codex', projectPath, prompt: 'Keep working' },
    { signal: controller.signal },
  )
  setTimeout(() => controller.abort(), 10)

  await assert.rejects(run, (error) =>
    error instanceof ChatRunError
    && error.code === 'run_cancelled'
    && error.status === 499
    && error.safeToRetry === false)
  assert.equal(receivedSignal, controller.signal)
})

test('disconnecting a streaming HTTP client aborts the Host run instead of orphaning it', async (context) => {
  let hostObservedAbort
  const observedAbort = new Promise((resolve) => { hostObservedAbort = resolve })
  const server = createRelayHost({
    chatService: {
      async run(_request, options) {
        options.onEvent({
          type: 'started',
          provider: 'codex',
          cwd: '/verified/project',
          command: '/test/bin/codex exec -',
          at: new Date().toISOString(),
        })
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
        hostObservedAbort(options.signal.aborted)
        throw new ChatRunError('run_cancelled', 'Run stopped by user.', 499, false)
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/run/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'codex', projectPath: '/project', prompt: 'Hello' }),
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  await reader.read()
  controller.abort()

  assert.equal(await Promise.race([
    observedAbort,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Host did not observe disconnect.')), 1_000)),
  ]), true)
})

test('stream cancellation has a distinct non-retryable terminal event', async (context) => {
  const server = createRelayHost({
    chatService: {
      async run() {
        throw new ChatRunError('run_cancelled', 'Run stopped by user.', 499, false)
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/run/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'codex', projectPath: '/project', prompt: 'Hello' }),
  })
  const event = JSON.parse((await response.text()).trim())

  assert.equal(event.type, 'cancelled')
  assert.equal(event.code, 'run_cancelled')
  assert.equal(event.status, 499)
  assert.equal(event.safeToRetry, false)
})
