import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  argumentsFor,
  ChatRunError,
  ChatRunService,
  parseClaudeChatResult,
  parseCodexChatResult,
  quotaFailureIsSafe,
  redactTerminalText,
  validateAttachmentPaths,
  validateProjectPath,
} from './chat.mjs'
import { createEnsyncHost } from './server.mjs'

const execFile = promisify(execFileCallback)

async function projectFixture(context) {
  const projectPath = await mkdtemp(join(tmpdir(), 'relay-chat-test-'))
  context.after(() => rm(projectPath, { recursive: true, force: true }))
  return projectPath
}

async function gitProjectFixture(context) {
  const projectPath = await projectFixture(context)
  await execFile('git', ['init', '-b', 'main'], { cwd: projectPath })
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
  const labels = { codex: 'Codex', claude: 'Claude Code', droid: 'Factory Droid', cursor: 'Cursor Agent' }
  const methods = { codex: 'ChatGPT login', claude: 'claude.ai OAuth', droid: 'Factory browser login', cursor: 'Cursor login' }
  return {
    id,
    name: labels[id] ?? id,
    installed: true,
    executable: `/test/bin/${id}`,
    authentication: {
      state: 'authenticated',
      method: methods[id] ?? 'login',
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

test('ChatRunService uses a pre-acquired workspace lease without acquiring or releasing it', async (context) => {
  const projectPath = await projectFixture(context)
  let acquireCalls = 0
  let releaseCalls = 0
  let processCwd = null
  const lease = {
    workspace: {
      projectPath, repositoryPath: projectPath, branch: 'ensync/chat-a', base: null, integration: null,
      gitBefore: { dirty: false, changedFiles: 0 },
      shared: { repositoryPath: projectPath },
    },
    signal: new AbortController().signal,
    assertHeld() {},
    async release() { releaseCalls += 1 },
  }
  const projectIsolation = {
    async acquire() { acquireCalls += 1; return lease },
    async commitAgentWork() { return { committed: false, changedFiles: 0 } },
    async checkSharedCheckout() { return { available: false } },
  }
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    projectIsolation,
    processRunner: async (_executable, _args, options) => {
      processCwd = options.cwd
      return {
        exitCode: 0, error: null, timedOut: false, stderr: '',
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
        ].join('\n'),
      }
    },
  })

  await service.run({ provider: 'codex', projectPath, prompt: 'Continue', workspaceKey: 'workspace:chat-a' }, {
    preAcquiredWorkspaceLease: lease,
  })

  assert.equal(acquireCalls, 0)
  assert.equal(releaseCalls, 0)
  assert.equal(processCwd, projectPath)
})

test('ChatRunService adds only protected-workspace isolation to the renderer prompt', async (context) => {
  const projectPath = await projectFixture(context)
  let processInput = ''
  const lease = {
    workspace: {
      projectPath,
      repositoryPath: projectPath,
      branch: 'ensync/chat-renderer-envelope',
      base: null,
      integration: null,
      gitBefore: { dirty: false, changedFiles: 0, head: 'base' },
      shared: { repositoryPath: projectPath },
    },
    signal: new AbortController().signal,
    assertHeld() {},
    async release() {},
  }
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    projectIsolation: {
      async commitAgentWork() { return { committed: false, changedFiles: 0 } },
      async checkSharedCheckout() { return { available: false } },
    },
    processRunner: async (_executable, _args, options) => {
      processInput = options.input
      return {
        exitCode: 0, error: null, timedOut: false, stderr: '',
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
        ].join('\n'),
      }
    },
  })
  const prompt = 'Continue the renderer-started task.'

  await service.run({
    provider: 'codex', projectPath, prompt, workspaceKey: 'conversation:renderer-envelope',
  }, {
    preAcquiredWorkspaceLease: lease,
  })

  assert.match(processInput, /\[ENSYNC HOST WORKSPACE ISOLATION\]/)
  assert.match(processInput, /Protected branch: ensync\/chat-renderer-envelope/)
  assert.match(processInput, /Continue the renderer-started task\.$/)
})

test('ChatRunService tells the provider and renderer that baseline reconciliation is deferred until landing', async (context) => {
  const projectPath = await projectFixture(context)
  const baselineConflict = {
    baselineSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    files: ['TODO.md', 'components/views/UnitDetail.tsx', 'package.json'],
    reason: 'New baseline changes conflict with this conversation’s work. Ensync preserved the clean conversation branch and will reconcile it before landing.',
  }
  const events = []
  let seenPrompt = ''
  const lease = {
    workspace: {
      projectPath,
      repositoryPath: projectPath,
      branch: 'ensync/chat-deferred',
      baselineConflict,
      base: {
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        canonicalSha: baselineConflict.baselineSha,
        source: 'base_refresh_deferred',
        reason: baselineConflict.reason,
        remote: 'origin',
        branch: 'main',
        refreshed: false,
      },
      integration: {
        canonicalSha: baselineConflict.baselineSha,
        integrated: false,
        unintegratedCommits: 1,
      },
      gitBefore: {
        dirty: false,
        changedFiles: 0,
        head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      shared: { repositoryPath: projectPath },
    },
    signal: new AbortController().signal,
    assertHeld() {},
    async release() {},
  }
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    projectIsolation: {
      async commitAgentWork() { return { committed: false, changedFiles: 0 } },
      async checkSharedCheckout() { return { available: false } },
    },
    processRunner: async (_executable, _args, options) => {
      seenPrompt = options.input
      return {
        exitCode: 0, error: null, timedOut: false, stderr: '',
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
        ].join('\n'),
      }
    },
  })

  const result = await service.run({
    provider: 'codex', projectPath, prompt: 'Continue', workspaceKey: 'conversation:deferred-baseline',
  }, {
    preAcquiredWorkspaceLease: lease,
    onEvent: (event) => events.push(event),
  })

  assert.match(seenPrompt, /DEFERRED BASELINE RECONCILIATION/)
  assert.match(seenPrompt, /bbbbbbbbbbbb/)
  assert.match(seenPrompt, /components\/views\/UnitDetail\.tsx/)
  assert.match(seenPrompt, /continue/i)
  assert.match(seenPrompt, /before landing/i)
  assert.doesNotMatch(seenPrompt, /never merges them for you/i)
  const ready = events.find((event) => event.code === 'project_workspace_ready')
  assert.match(ready.message, /reconciliation is deferred until landing/i)
  assert.deepEqual(ready.workspace.baselineConflict, baselineConflict)
  assert.deepEqual(result.workspace.baselineConflict, baselineConflict)
})

test('ChatRunService ignores the removed filesystem overlap monitor and prompt wrapper', async (context) => {
  const projectPath = await projectFixture(context)
  const overlap = {
    peerBranch: 'ensync/chat-bbbbbbbbbbbbbbbbbbbbbbbb',
    source: 'active',
    paths: ['src/App.tsx'],
    totalCount: 1,
  }
  const events = []
  let seenPrompt = ''
  let startCalls = 0
  const lease = {
    workspace: {
      projectPath,
      repositoryPath: projectPath,
      commonGitDirectory: join(projectPath, '.git'),
      branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa',
      base: null,
      integration: null,
      gitBefore: { dirty: false, changedFiles: 0, head: 'base' },
      shared: { repositoryPath: projectPath },
    },
    signal: new AbortController().signal,
    assertHeld() {},
    async release() {},
  }
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    projectIsolation: {
      async commitAgentWork() { return { committed: false, changedFiles: 0 } },
      async checkSharedCheckout() { return { available: false } },
    },
    workspaceOverlapMonitor: {
      async start(_workspace, options) {
        startCalls += 1
        options.onEvent({
          type: 'notice',
          code: 'workspace_file_overlap_detected',
          message: 'Another conversation is editing src/App.tsx.',
          overlap: { ...overlap, state: 'detected' },
          at: '2026-08-12T00:00:00.000Z',
        })
        return {
          current: () => [overlap],
          async refresh() { return [overlap] },
          async stop() {},
        }
      },
    },
    processRunner: async (_executable, _args, options) => {
      seenPrompt = options.input
      return {
        exitCode: 0, error: null, timedOut: false, stderr: '',
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
        ].join('\n'),
      }
    },
  })

  await service.run({
    provider: 'codex', projectPath, prompt: 'Continue', workspaceKey: 'conversation:overlap-lifecycle',
  }, {
    preAcquiredWorkspaceLease: lease,
    onEvent: (event) => events.push(event),
  })

  assert.doesNotMatch(seenPrompt, /CROSS-CONVERSATION FILE AWARENESS/)
  assert.doesNotMatch(seenPrompt, /src\/App\.tsx/)
  assert.doesNotMatch(seenPrompt, /another worktree at/)
  assert.equal(events.some((event) => event.code === 'workspace_file_overlap_detected'), false)
  assert.equal(startCalls, 0)
})

test('failed provider run publishes its terminal error without observing the shared checkout', async (context) => {
  const projectPath = await projectFixture(context)
  const events = []
  let sharedCheckoutChecks = 0
  let releases = 0
  const lease = {
    workspace: {
      canonicalProjectPath: projectPath,
      projectPath,
      repositoryPath: projectPath,
      commonGitDirectory: join(projectPath, '.git'),
      branch: 'ensync/chat-failed-terminal',
      base: { branch: 'main', canonicalSha: 'c'.repeat(40) },
      integration: null,
      gitBefore: { dirty: false, changedFiles: 0, head: 'c'.repeat(40) },
      shared: {
        repositoryPath: projectPath,
        head: 'c'.repeat(40),
        statusEntries: [],
      },
    },
    signal: new AbortController().signal,
    assertHeld() {},
    async release() {
      releases += 1
      return { removed: true, reason: null }
    },
  }
  const service = new ChatRunService({
    statusService: statusService(readyProvider('claude')),
    projectIsolation: {
      async acquire() { return lease },
      async commitAgentWork() {
        return { committed: true, changedFiles: 1, head: 'd'.repeat(40) }
      },
      async checkSharedCheckout() {
        sharedCheckoutChecks += 1
        return { available: false }
      },
    },
    processRunner: async () => ({
      exitCode: 1,
      error: null,
      timedOut: false,
      stderr: 'Claude Code stopped after tool activity.',
      stdout: [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }] },
        }),
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'You have hit your session limit.',
        }),
      ].join('\n'),
    }),
  })

  await assert.rejects(
    service.run({
      provider: 'claude', projectPath, prompt: 'Continue', workspaceKey: 'conversation:failed-terminal',
    }, {
      onEvent: (event) => events.push(event),
    }),
    (error) => error instanceof ChatRunError
      && error.code === 'cli_failed'
      && error.safeToRetry === false,
  )

  assert.ok(events.some((event) => event.code === 'agent_work_committed'))
  assert.equal(sharedCheckoutChecks, 0)
  assert.equal(releases, 1)
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
    prompt: 'Inspect this project and preserve [quoted user marker]',
    model: 'gpt-5.4',
    effort: 'high',
    timeoutMs: 2_000,
  })

  assert.equal(calls.length, 1)
  const [executable, args, options] = calls[0]
  assert.equal(executable, '/test/bin/codex')
  assert.deepEqual(args, ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '--model', 'gpt-5.4', '-c', 'model_reasoning_effort="high"', '-'])
  assert.equal(options.cwd, await realpath(projectPath))
  assert.equal(options.input, 'Inspect this project and preserve [quoted user marker]')
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

test('Codex provider default omits model and absolute run limits', async (context) => {
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
  assert.equal(capturedOptions.hardTimeoutMs, null)
  assert.equal(result.requestedModel, null)
  assert.equal(result.requestedEffort, null)
})

test('the hard run ceiling honors ENSYNC_CHAT_HARD_TIMEOUT_MS and ignores invalid values', async (context) => {
  const projectPath = await projectFixture(context)
  const runWith = async (environment) => {
    let capturedOptions
    const service = new ChatRunService({
      statusService: statusService(readyProvider('codex')),
      environment,
      processRunner: async (_executable, _args, options) => {
        capturedOptions = options
        return {
          exitCode: 0,
          error: null,
          timedOut: false,
          stderr: '',
          stdout: [
            JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Configured ceiling response' } }),
            JSON.stringify({ type: 'turn.completed' }),
          ].join('\n'),
        }
      },
    })
    await service.run({ provider: 'codex', projectPath, prompt: 'Check the ceiling' })
    return capturedOptions
  }

  const configured = await runWith({ ENSYNC_CHAT_HARD_TIMEOUT_MS: `${8 * 60 * 60 * 1_000}` })
  assert.equal(configured.hardTimeoutMs, 8 * 60 * 60 * 1_000)
  assert.equal(configured.inactivityTimeoutMs, 15 * 60 * 1_000)

  const lowered = await runWith({ ENSYNC_CHAT_HARD_TIMEOUT_MS: '600000' })
  assert.equal(lowered.hardTimeoutMs, 600_000)
  assert.equal(lowered.inactivityTimeoutMs, 600_000)

  const invalid = await runWith({ ENSYNC_CHAT_HARD_TIMEOUT_MS: 'unlimited' })
  assert.equal(invalid.hardTimeoutMs, 24 * 60 * 60 * 1_000)
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
      canSteer: (jobId) => jobId === 'job_1111111111111111',
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

test('Claude startup-only code 1 is safe for automatic fallback', async (context) => {
  const projectPath = await projectFixture(context)
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: '123e4567-e89b-12d3-a456-426614174000' }),
    JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' }),
    JSON.stringify({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup' }),
  ].join('\n')
  const service = new ChatRunService({
    statusService: statusService(readyProvider('claude')),
    processRunner: async () => ({
      exitCode: 1,
      error: null,
      timedOut: false,
      outputTruncated: false,
      stderr: '',
      stdout,
    }),
  })

  await assert.rejects(
    service.run({ provider: 'claude', projectPath, prompt: 'Start the task' }),
    (error) => error instanceof ChatRunError
      && error.code === 'provider_startup_failed'
      && error.safeToRetry === true,
  )
})

test('Claude nonzero exit surfaces its terminal structured error instead of startup hook output', async (context) => {
  const projectPath = await projectFixture(context)
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' }),
    JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      hook_name: 'SessionStart:startup',
      output: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"bootstrap"}}',
    }),
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'package.json' } }] },
    }),
    JSON.stringify({
      type: 'result',
      is_error: true,
      terminal_reason: 'api_error',
      result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    }),
  ].join('\n')
  const service = new ChatRunService({
    statusService: statusService(readyProvider('claude')),
    processRunner: async () => ({
      exitCode: 1,
      error: null,
      timedOut: false,
      outputTruncated: false,
      stderr: '',
      stdout,
    }),
  })

  await assert.rejects(
    service.run({ provider: 'claude', projectPath, prompt: 'Continue the task' }),
    (error) =>
      error instanceof ChatRunError
      && error.code === 'cli_failed'
      && error.safeToRetry === false
      && error.message === 'Claude Code reported an error: Failed to authenticate: OAuth session expired and could not be refreshed'
      && !error.message.includes('hook_started'),
  )
})

test('Claude code 1 after an assistant event is not replayable', async (context) => {
  const projectPath = await projectFixture(context)
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I started the task.' }] } }),
  ].join('\n')
  const service = new ChatRunService({
    statusService: statusService(readyProvider('claude')),
    processRunner: async () => ({
      exitCode: 1,
      error: null,
      timedOut: false,
      outputTruncated: false,
      stderr: '',
      stdout,
    }),
  })

  await assert.rejects(
    service.run({ provider: 'claude', projectPath, prompt: 'Start the task' }),
    (error) => error instanceof ChatRunError
      && error.code === 'cli_failed'
      && error.safeToRetry === false,
  )
})

test('a truncated Claude startup stream is not replayable', async (context) => {
  const projectPath = await projectFixture(context)
  const service = new ChatRunService({
    statusService: statusService(readyProvider('claude')),
    processRunner: async () => ({
      exitCode: 1,
      error: null,
      timedOut: false,
      outputTruncated: true,
      stderr: '',
      stdout: JSON.stringify({ type: 'system', subtype: 'init' }),
    }),
  })

  await assert.rejects(
    service.run({ provider: 'claude', projectPath, prompt: 'Start the task' }),
    (error) => error instanceof ChatRunError
      && error.code === 'cli_failed'
      && error.safeToRetry === false,
  )
})

test('only exact SessionStart lifecycle output proves a replayable Claude startup failure', async (context) => {
  const projectPath = await projectFixture(context)
  const unsafeStreams = [
    {
      stdout: [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'PreToolUse:command' }),
      ].join('\n'),
      stderr: '',
    },
    {
      stdout: JSON.stringify({ type: 'system', subtype: 'init' }),
      stderr: 'Unexpected provider diagnostic',
    },
  ]

  for (const stream of unsafeStreams) {
    const service = new ChatRunService({
      statusService: statusService(readyProvider('claude')),
      processRunner: async () => ({
        exitCode: 1,
        error: null,
        timedOut: false,
        outputTruncated: false,
        ...stream,
      }),
    })

    await assert.rejects(
      service.run({ provider: 'claude', projectPath, prompt: 'Start the task' }),
      (error) => error instanceof ChatRunError
        && error.code === 'cli_failed'
        && error.safeToRetry === false,
    )
  }
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

  // Copilot is gated rather than unsupported: its runner is deliberately not
  // built, so the refusal carries the exact outstanding requirement instead of a
  // generic "not supported" message.
  await assert.rejects(
    service.run({ provider: 'copilot', projectPath, prompt: 'Hello' }),
    (error) => error instanceof ChatRunError
      && error.code === 'provider_execution_gated'
      && error.status === 422
      && /never puts a prompt in argv/.test(error.message),
  )
  await assert.rejects(
    service.run({ provider: 'kiro', projectPath, prompt: 'Hello' }),
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

test('codebuddy and ollama are refused with their own exact outstanding requirement', async (context) => {
  const projectPath = await projectFixture(context)
  let processCalls = 0
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    processRunner: async () => {
      processCalls += 1
      throw new Error('process must not run')
    },
  })

  // CodeBuddy's runner is complete and its containment is recorded, but the CLI
  // has never completed an authenticated turn, so the headless-approval
  // behaviour is unverified. The refusal says exactly that.
  await assert.rejects(
    service.run({ provider: 'codebuddy', projectPath, prompt: 'Hello' }),
    (error) => error instanceof ChatRunError
      && error.code === 'provider_execution_gated'
      && error.status === 422
      && /not signed in/.test(error.message)
      && /CodeBuddy Code/.test(error.message),
  )

  // Ollama is not an unfinished integration: it is an inference server with no
  // tool execution, so it cannot carry out a task at all.
  await assert.rejects(
    service.run({ provider: 'ollama', projectPath, prompt: 'Hello' }),
    (error) => error instanceof ChatRunError
      && error.code === 'provider_execution_gated'
      && /local model runtime, not a coding agent/.test(error.message),
  )

  assert.equal(processCalls, 0)
})

for (const providerId of ['cursor']) {
test(`${providerId} stays discovery-only until paid overage can be disabled per run`, async (context) => {
  const projectPath = await projectFixture(context)
  let runnerCalls = 0
  const runner = {
    run: async () => {
      runnerCalls += 1
      throw new Error('gated runner must not run')
    },
  }
  const service = new ChatRunService({
    statusService: statusService(readyProvider(providerId)),
    processRunner: async () => {
      throw new Error('process must not run')
    },
    droidExecRunner: runner,
    cursorAgentRunner: runner,
  })

  await assert.rejects(
    service.run({ provider: providerId, projectPath, prompt: 'Hello' }),
    (error) => error instanceof ChatRunError
      && error.code === 'provider_execution_gated'
      && /paid|overage|Extra Usage|Additional Usage/i.test(error.message),
  )
  assert.equal(runnerCalls, 0)
})
}

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
  const claudeSessionLimit = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'result',
      is_error: true,
      result: "You've hit your session limit · resets 5:10pm (Asia/Jerusalem)",
    }),
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
  assert.equal(quotaFailureIsSafe('claude', claudeSessionLimit), true)
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
  const server = createEnsyncHost({
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
  const server = createEnsyncHost({
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
  const server = createEnsyncHost({
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
  const server = createEnsyncHost({
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
  let processStarted
  const started = new Promise((resolve) => { processStarted = resolve })
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    processRunner: async (_executable, _args, options) => {
      receivedSignal = options.signal
      processStarted()
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
      return { exitCode: null, signal: 'SIGTERM', error: null, timedOut: false, aborted: true, stdout: '', stderr: '' }
    },
  })

  const run = service.run(
    { provider: 'codex', projectPath, prompt: 'Keep working' },
    { signal: controller.signal },
  )
  // Cancel only once the process is actually running: a wall-clock delay races the
  // pre-spawn cancellation checks, which reject before any signal reaches the process.
  void started.then(() => controller.abort())

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
  const server = createEnsyncHost({
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
  const server = createEnsyncHost({
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

test('codex arguments pin the OS sandbox to the protected worktree', () => {
  const containment = { worktreePath: '/tmp/worktree', canonicalRepositoryPath: '/tmp/shared' }
  const args = argumentsFor(
    { provider: 'codex', prompt: 'p', projectPath: '/tmp/shared' },
    [],
    containment,
  )
  assert.ok(args.includes('--sandbox'), 'expected --sandbox flag')
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write')
  const configIndex = args.findIndex((value) => typeof value === 'string' && value.includes('writable_roots'))
  assert.ok(configIndex > 0, 'expected writable_roots override')
  assert.match(args[configIndex], /\/tmp\/worktree/)
})

test('codex resume arguments pin the sandbox via config overrides, not --sandbox (rejected by exec resume)', () => {
  // `codex exec resume --sandbox workspace-write ...` is rejected by the installed CLI with
  // `error: unexpected argument '--sandbox' found` (exit 2). On resume, the sandbox must be
  // expressed purely through `-c` config overrides.
  const containment = { worktreePath: '/tmp/worktree', canonicalRepositoryPath: '/tmp/shared' }
  const args = argumentsFor(
    { provider: 'codex', prompt: 'p', projectPath: '/tmp/shared', sessionId: '123e4567-e89b-12d3-a456-426614174000' },
    [],
    containment,
  )
  assert.equal(args.includes('--sandbox'), false, '--sandbox is not accepted by exec resume and must not appear')
  const sandboxModeIndex = args.indexOf('sandbox_mode="workspace-write"')
  assert.ok(sandboxModeIndex > 0, 'expected sandbox_mode config override')
  assert.equal(args[sandboxModeIndex - 1], '-c')
  const writableRootsIndex = args.findIndex((value) => typeof value === 'string' && value.includes('writable_roots'))
  assert.ok(writableRootsIndex > 0, 'expected writable_roots override')
  assert.equal(args[writableRootsIndex - 1], '-c')
  assert.match(args[writableRootsIndex], /\/tmp\/worktree/)
})

test('claude arguments pin deny rules for the canonical checkout', () => {
  const containment = { worktreePath: '/tmp/worktree', canonicalRepositoryPath: '/tmp/shared' }
  const args = argumentsFor(
    { provider: 'claude', prompt: 'p', projectPath: '/tmp/shared' },
    [],
    containment,
  )
  const settingsIndex = args.indexOf('--settings')
  assert.ok(settingsIndex > 0, 'expected --settings flag')
  const settings = JSON.parse(args[settingsIndex + 1])
  assert.deepEqual(settings.permissions.deny, [
    'Write(/tmp/shared/**)',
    'Edit(/tmp/shared/**)',
    'NotebookEdit(/tmp/shared/**)',
  ])
})

test('arguments carry no containment flags without a protected workspace', () => {
  for (const provider of ['codex', 'claude']) {
    const args = argumentsFor({ provider, prompt: 'p', projectPath: '/tmp/shared' }, [], null)
    assert.equal(args.includes('--sandbox'), false)
    assert.equal(args.includes('--settings'), false)
  }
})

test('ChatRunService completes after exact-SHA enqueue without awaiting background landing', { timeout: 10_000 }, async (context) => {
  const projectPath = await projectFixture(context)
  const savedSha = 'a'.repeat(40)
  const lease = {
    workspace: {
      canonicalProjectPath: projectPath,
      projectPath,
      repositoryPath: projectPath,
      commonGitDirectory: join(projectPath, '.git'),
      branch: 'ensync/chat-detached-land',
      base: { branch: 'main', canonicalSha: 'c'.repeat(40) },
      integration: null,
      gitBefore: { dirty: false, changedFiles: 0 },
      shared: { repositoryPath: projectPath },
    },
    signal: new AbortController().signal,
    assertHeld() {},
    async release() {},
  }
  const observerCalls = []
  const landingNeverFinishes = new Promise(() => {})
  let enqueued = null
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    projectIsolation: {
      async commitAgentWork() { return { committed: true, changedFiles: 1, head: savedSha } },
      async checkSharedCheckout() { return { available: false } },
    },
    landingCoordinator: {
      async enqueue(input) {
        enqueued = input
        queueMicrotask(() => void landingNeverFinishes)
        return { ...input, id: 'landing-1', state: 'queued' }
      },
    },
    processRunner: async () => ({
      exitCode: 0, error: null, timedOut: false, stderr: '',
      stdout: [
        JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
      ].join('\n'),
    }),
  })

  const result = await service.run(
    { provider: 'codex', projectPath, prompt: 'Continue', workspaceKey: 'workspace:chat-hung-land' },
    {
      preAcquiredWorkspaceLease: lease,
      turnId: 'turn-delivery-description',
      onEvent: (event) => {
        observerCalls.push(event.code)
        throw new Error('renderer disconnected')
      },
    },
  )

  assert.equal(result.response, 'done')
  assert.deepEqual(enqueued, {
    repositoryPath: projectPath,
    commonGitDirectory: join(projectPath, '.git'),
    projectPath,
    workspacePath: projectPath,
    branch: 'ensync/chat-detached-land',
    savedSha,
    targetBranch: 'main',
    targetBaseSha: 'c'.repeat(40),
    provider: 'codex',
    turnId: 'turn-delivery-description',
    deliveryTarget: 'production',
  })
  assert.ok(observerCalls.includes('agent_work_committed'))
  assert.ok(observerCalls.includes('automatic_landing_queued'))
})

test('ChatRunService fails a successful provider run when its exact work snapshot cannot be saved', async (context) => {
  const projectPath = await projectFixture(context)
  let releaseCalls = 0
  let enqueueCalls = 0
  const notices = []
  const lease = {
    workspace: {
      canonicalProjectPath: projectPath,
      projectPath,
      repositoryPath: projectPath,
      branch: 'ensync/chat-save-failure',
      base: null,
      integration: null,
      gitBefore: { dirty: false, changedFiles: 0 },
      shared: { repositoryPath: projectPath },
    },
    signal: new AbortController().signal,
    assertHeld() {},
    async release() {
      releaseCalls += 1
      return { removed: true, reason: null }
    },
  }
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    projectIsolation: {
      async acquire() { return lease },
      async commitAgentWork() { throw new Error('snapshot storage unavailable') },
      async checkSharedCheckout() { return { available: false } },
    },
    landingCoordinator: {
      async enqueue() {
        enqueueCalls += 1
        return { completionSequence: 1 }
      },
    },
    processRunner: async () => ({
      exitCode: 0, error: null, timedOut: false, stderr: '',
      stdout: [
        JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
      ].join('\n'),
    }),
  })

  await assert.rejects(
    service.run(
      { provider: 'codex', projectPath, prompt: 'Continue', workspaceKey: 'workspace:chat-save-failure' },
      { onEvent: (event) => { if (event.type === 'notice') notices.push(event) } },
    ),
    (error) => error instanceof ChatRunError
      && error.code === 'agent_work_save_failed'
      && error.safeToRetry === false,
  )

  assert.equal(enqueueCalls, 0)
  assert.equal(releaseCalls, 1)
  assert.ok(notices.some((notice) => notice.code === 'agent_work_commit_failed'))
})

test('ChatRunService fails a successful provider run when its exact SHA cannot be durably queued', async (context) => {
  const projectPath = await projectFixture(context)
  const savedSha = 'b'.repeat(40)
  let releaseCalls = 0
  const notices = []
  const lease = {
    workspace: {
      canonicalProjectPath: projectPath,
      projectPath,
      repositoryPath: projectPath,
      branch: 'ensync/chat-queue-failure',
      base: null,
      integration: null,
      gitBefore: { dirty: false, changedFiles: 0 },
      shared: { repositoryPath: projectPath },
    },
    signal: new AbortController().signal,
    assertHeld() {},
    async release() {
      releaseCalls += 1
      return { removed: true, reason: null }
    },
  }
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    projectIsolation: {
      async acquire() { return lease },
      async commitAgentWork() { return { committed: true, changedFiles: 1, head: savedSha } },
      async checkSharedCheckout() { return { available: false } },
    },
    landingCoordinator: {
      async enqueue() { throw new Error('landing journal unavailable') },
    },
    processRunner: async () => ({
      exitCode: 0, error: null, timedOut: false, stderr: '',
      stdout: [
        JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
      ].join('\n'),
    }),
  })

  await assert.rejects(
    service.run(
      { provider: 'codex', projectPath, prompt: 'Continue', workspaceKey: 'workspace:chat-queue-failure' },
      { onEvent: (event) => { if (event.type === 'notice') notices.push(event) } },
    ),
    (error) => error instanceof ChatRunError
      && error.code === 'automatic_landing_queue_failed'
      && error.safeToRetry === false,
  )

  assert.equal(releaseCalls, 1)
  assert.ok(notices.some((notice) => notice.code === 'automatic_landing_queue_failed'))
})

test('background conflict resolution keeps subscription auth and temporary-worktree containment', async (context) => {
  const worktreePath = await gitProjectFixture(context)
  let processOptions = null
  let processArguments = null
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    processRunner: async (_executable, args, options) => {
      processArguments = args
      processOptions = options
      return {
        exitCode: 0, error: null, timedOut: false, stderr: '',
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'resolved' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
        ].join('\n'),
      }
    },
  })

  await service.resolveLandingConflict({
    item: {
      provider: 'codex',
      branch: 'ensync/chat-conflict',
      savedSha: 'b'.repeat(40),
      repositoryPath: worktreePath,
    },
    worktreePath,
    projectPath: worktreePath,
    conflictFiles: ['src/feature.ts'],
    commonGitDirectory: join(worktreePath, '.git'),
    signal: new AbortController().signal,
  })

  assert.equal(processOptions.cwd, await realpath(worktreePath))
  assert.match(processOptions.input, /ENSYNC HOST AUTOMATIC LANDING CONFLICT/)
  assert.match(processOptions.input, new RegExp('b{40}'))
  assert.match(processOptions.input, /src\/feature\.ts/)
  assert.ok(processArguments.includes('model_reasoning_effort="max"'))
})

test('a Claude conflict falls back to an authenticated contained Codex resolver', async (context) => {
  const worktreePath = await gitProjectFixture(context)
  let runs = 0
  const service = new ChatRunService({
    statusService: {
      async get(id) {
        return id === 'codex' ? readyProvider('codex') : { id, installed: false }
      },
    },
    processRunner: async () => {
      runs += 1
      return {
        exitCode: 0, error: null, timedOut: false, stderr: '',
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'resolved' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
        ].join('\n'),
      }
    },
  })

  await service.resolveLandingConflict({
    item: {
      provider: 'claude',
      branch: 'ensync/chat-conflict',
      savedSha: 'd'.repeat(40),
      repositoryPath: worktreePath,
    },
    worktreePath,
    projectPath: worktreePath,
    conflictFiles: ['src/conflict.ts'],
    commonGitDirectory: join(worktreePath, '.git'),
  })

  assert.equal(runs, 1)
})

test('a connected Claude landing resolver uses maximum verified session effort', async (context) => {
  const worktreePath = await gitProjectFixture(context)
  let processArguments = null
  const service = new ChatRunService({
    statusService: statusService(readyProvider('claude')),
    processRunner: async (_executable, args) => {
      processArguments = args
      return {
        exitCode: 0, error: null, timedOut: false, stderr: '',
        stdout: [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: '123e4567-e89b-12d3-a456-426614174000' }),
          JSON.stringify({ type: 'result', is_error: false, result: 'resolved', session_id: '123e4567-e89b-12d3-a456-426614174000' }),
        ].join('\n'),
      }
    },
  })

  await service.resolveLandingConflict({
    item: {
      provider: 'claude',
      branch: 'ensync/chat-conflict',
      savedSha: 'f'.repeat(40),
      repositoryPath: worktreePath,
      attempts: 1,
    },
    worktreePath,
    projectPath: worktreePath,
    conflictFiles: ['src/conflict.ts'],
    commonGitDirectory: join(worktreePath, '.git'),
  })

  const effortFlag = processArguments.indexOf('--effort')
  assert.notEqual(effortFlag, -1)
  assert.equal(processArguments[effortFlag + 1], 'max')
})

test('background conflict retries rotate across eligible providers at maximum verified effort', async (context) => {
  const worktreePath = await gitProjectFixture(context)
  const droidRuns = []
  const service = new ChatRunService({
    statusService: {
      async get(id) { return readyProvider(id) },
    },
    processRunner: async () => {
      throw new Error('the second attempt should rotate away from Codex')
    },
    droidExecRunner: {
      async run(input) {
        droidRuns.push(input)
        return { response: 'resolved', sessionId: null, model: input.model, usage: null }
      },
    },
  })

  await service.resolveLandingConflict({
    item: {
      provider: 'codex',
      branch: 'ensync/chat-conflict',
      savedSha: 'e'.repeat(40),
      repositoryPath: worktreePath,
      attempts: 2,
    },
    worktreePath,
    projectPath: worktreePath,
    conflictFiles: ['src/conflict.ts'],
    commonGitDirectory: join(worktreePath, '.git'),
  })

  assert.equal(droidRuns.length, 1)
  assert.equal(droidRuns[0].model, null)
  assert.equal(droidRuns[0].effort, 'max')
})

for (const providerId of ['cursor']) {
  test(`background conflict resolution retries ${providerId} work when no contained resolver is connected`, async (context) => {
    const worktreePath = await gitProjectFixture(context)
    let runs = 0
    const runner = {
      async run() {
        runs += 1
        return { response: 'resolved', sessionId: null, model: null, usage: null }
      },
    }
    const service = new ChatRunService({
      statusService: {
        async get(id) { return id === providerId ? readyProvider(providerId) : { id, installed: false } },
      },
      processRunner: async () => {
        runs += 1
        return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout: '' }
      },
      droidExecRunner: providerId === 'droid' ? runner : undefined,
    })

    await assert.rejects(service.resolveLandingConflict({
      item: {
        provider: providerId,
        branch: 'ensync/chat-conflict',
        savedSha: 'd'.repeat(40),
        repositoryPath: worktreePath,
      },
      worktreePath,
      projectPath: worktreePath,
      conflictFiles: ['src/conflict.ts'],
      commonGitDirectory: join(worktreePath, '.git'),
    }), (error) => error instanceof ChatRunError
      && error.code === 'conflict_resolution_provider_unavailable'
      && error.safeToRetry === true)

    assert.equal(runs, 0)
  })
}

test('background conflict resolution rejects a project symlink that escapes the worktree', {
  skip: process.platform === 'win32',
}, async (context) => {
  const worktreePath = await gitProjectFixture(context)
  const outsidePath = await projectFixture(context)
  const linkedProject = join(worktreePath, 'linked-project')
  await symlink(outsidePath, linkedProject)
  let runs = 0
  const service = new ChatRunService({
    statusService: statusService(readyProvider('codex')),
    processRunner: async () => {
      runs += 1
      return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout: '' }
    },
  })

  await assert.rejects(service.resolveLandingConflict({
    item: {
      provider: 'codex',
      branch: 'ensync/chat-conflict',
      savedSha: 'b'.repeat(40),
      repositoryPath: worktreePath,
    },
    worktreePath,
    projectPath: linkedProject,
    conflictFiles: ['src/feature.ts'],
    commonGitDirectory: join(worktreePath, '.git'),
  }), (error) => error instanceof ChatRunError && error.code === 'invalid_project')

  assert.equal(runs, 0)
})

// `AskUserQuestion` is the one Claude tool that is not work: it is the agent
// turning to the person. Text in front of it is the message it wrote *to* them,
// so labelling it a progress note both mislabels the agent's own answer and
// loses it — Claude's terminal `result` carries only the last assistant text of
// the turn, so nothing else in the stream ever repeats it.
// Shape replayed from a real recorded run (assistant text, then a lone
// AskUserQuestion tool_use block, then the control request).
test('Claude text before a question is the agent message on the question, not a note', async (context) => {
  const projectPath = await projectFixture(context)
  const sessionId = '123e4567-e89b-12d3-a456-426614174000'
  const events = []
  const report = 'Confirmed the root cause. Here is the full report.'
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-4-6' }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'thinking', thinking: 'hidden reasoning' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'text', text: report }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'tool_use', id: 'tool-1', name: 'AskUserQuestion', input: {} }] } }),
    JSON.stringify({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [{ question: 'Which fix do you want?', header: 'Fix', options: [{ label: 'Timeout', description: null }] }] },
        tool_use_id: 'tool-1',
        requires_user_interaction: true,
      },
    }),
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
    { provider: 'claude', projectPath, prompt: 'Find the stuck jobs' },
    { liveTurnId: 'job_2222222222222222', onEvent: (event) => events.push(event) },
  )

  assert.equal(result.response, 'Real Claude response')
  // The report is the agent's message, so it is not a note anywhere.
  assert.deepEqual(events.filter((event) => event.type === 'note').map((event) => event.text), [])
  const asked = events.find((event) => event.type === 'question')
  assert.equal(asked.message, report)
})

// The same text with no question channel to carry it has nowhere better to go,
// so the long-standing note routing is left exactly as it was.
test('Claude text before a question stays a note when no question channel exists', async (context) => {
  const projectPath = await projectFixture(context)
  const sessionId = '123e4567-e89b-12d3-a456-426614174000'
  const events = []
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-4-6' }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'text', text: 'About to ask something.' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'tool_use', id: 'tool-1', name: 'AskUserQuestion', input: {} }] } }),
    JSON.stringify({ type: 'result', is_error: false, result: 'Real Claude response', session_id: sessionId }),
  ].join('\n')

  const service = new ChatRunService({
    statusService: statusService(readyProvider('claude')),
    processRunner: async (_executable, _args, options) => {
      options.onStdout(stdout)
      return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout }
    },
  })

  await service.run({ provider: 'claude', projectPath, prompt: 'Ask me' }, { onEvent: (event) => events.push(event) })
  assert.deepEqual(events.filter((event) => event.type === 'note').map((event) => event.text), ['About to ask something.'])
})

// A question the agent asks after going back to work must not inherit the words
// it wrote before an earlier one.
test('a diverted Claude question message is never replayed onto later work', async (context) => {
  const projectPath = await projectFixture(context)
  const sessionId = '123e4567-e89b-12d3-a456-426614174000'
  const events = []
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-4-6' }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'text', text: 'Here is what I found.' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_a', content: [{ type: 'tool_use', id: 'tool-1', name: 'AskUserQuestion', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'answered' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_b', content: [{ type: 'text', text: 'Applying the fix now.' }] } }),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_b', content: [{ type: 'tool_use', id: 'tool-2', name: 'Edit', input: {} }] } }),
    JSON.stringify({ type: 'result', is_error: false, result: 'Real Claude response', session_id: sessionId }),
  ].join('\n')

  const service = new ChatRunService({
    statusService: statusService(readyProvider('claude')),
    processRunner: async (_executable, _args, options) => {
      options.onStdout(stdout)
      return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout }
    },
  })

  await service.run(
    { provider: 'claude', projectPath, prompt: 'Fix it' },
    { liveTurnId: 'job_3333333333333333', onEvent: (event) => events.push(event) },
  )
  assert.deepEqual(events.filter((event) => event.type === 'note').map((event) => event.text), ['Applying the fix now.'])
})
