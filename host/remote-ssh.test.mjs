import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import {
  buildSshArguments,
  RemoteSshError,
  RemoteSshProcessAdapter,
  RemoteSshService,
  validateRemoteProjectPath,
  validateRemoteSshConnection,
  validateSshHostname,
  validateSshPort,
  validateSshUsername,
} from './remote-ssh.mjs'
import {
  createRemoteBridgeInput,
  decodeRemoteBridgeEnvelope,
  encodeRemoteBridgeEnvelope,
  remoteChatArguments,
} from './remote-ssh-bridge.mjs'
import { runProcess } from './command.mjs'
import { createEnsyncHost } from './server.mjs'
import { runGit } from './git.mjs'

const WORKSPACE_KEY = 'canonical-window:remote-chat-1'

function connection(overrides = {}) {
  return {
    hostname: 'worker.example.com',
    username: 'developer',
    port: 22,
    identityFile: null,
    projectPath: '/srv/projects/ensync',
    ...overrides,
  }
}

function processResult(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    error: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    ...overrides,
  }
}

function remoteWorkspace() {
  return {
    path: '/home/developer/.ensync/agent-workspaces-v1/repository/conversation',
    repositoryPath: '/home/developer/.ensync/agent-workspaces-v1/repository/conversation',
    branch: 'ensync/chat-0123456789abcdef01234567',
    reused: false,
    gitBefore: {
      branch: 'ensync/chat-0123456789abcdef01234567',
      head: '0123456789abcdef0123456789abcdef01234567',
      dirty: false,
      changedFiles: 0,
      checkedAt: '2026-08-06T10:04:00.000Z',
    },
  }
}

test('remote bridge scopes model effort correctly for new and resumed provider runs', () => {
  const sessionId = '123e4567-e89b-12d3-a456-426614174000'
  assert.deepEqual(remoteChatArguments({ provider: 'codex', effort: 'high' }), [
    'exec', '--json', '--color', 'never', '--skip-git-repo-check', '-c', 'model_reasoning_effort="high"', '-',
  ])
  assert.deepEqual(remoteChatArguments({ provider: 'codex', effort: 'max', sessionId }), [
    'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'model_reasoning_effort="max"', sessionId, '-',
  ])
  assert.deepEqual(remoteChatArguments({ provider: 'claude', effort: 'medium', sessionId }), [
    '--print', '--verbose', '--output-format', 'stream-json', '--effort', 'medium', '--resume', sessionId,
  ])
  assert.equal(remoteChatArguments({ provider: 'claude' }).includes('--effort'), false)
})

function probeResult() {
  return {
    operation: 'probe',
    remote: {
      platform: 'linux',
      release: '6.8.0',
      arch: 'x64',
      hostname: 'worker',
    },
    node: { available: true, version: 'v22.18.0', executable: '/usr/bin/node' },
    project: {
      requestedPath: '/srv/projects/ensync',
      canonicalPath: '/srv/projects/ensync',
    },
    git: { installed: true, executable: '/usr/bin/git', version: 'git version 2.45.2' },
    providers: [
      {
        id: 'codex',
        installed: true,
        command: 'codex',
        executable: '/usr/local/bin/codex',
        directlyRunnable: true,
        version: 'codex-cli 0.90.0',
        authentication: {
          state: 'authenticated',
          method: 'ChatGPT login',
          reason: 'Remote Codex reports an active login.',
        },
        versionProbe: { stdout: 'raw version output', stderr: '' },
        authenticationProbe: { stdout: 'raw auth output', stderr: '' },
      },
    ],
    checkedAt: '2026-08-06T10:00:00.000Z',
  }
}

test('SSH connection validation accepts only strict host, user, port, key-path, and absolute project inputs', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-ssh-test-'))
  const identityFile = join(directory, 'id_ed25519')
  await writeFile(identityFile, 'fake test key path only')
  context.after(() => rm(directory, { recursive: true, force: true }))

  const validated = await validateRemoteSshConnection(connection({ identityFile }))
  assert.equal(validated.hostname, 'worker.example.com')
  assert.equal(validated.username, 'developer')
  assert.equal(validated.port, 22)
  assert.equal(validated.identityFile, await realpath(identityFile))
  assert.equal(validated.projectPath, '/srv/projects/ensync')

  assert.equal(validateSshHostname('2001:db8::10'), '2001:db8::10')
  assert.equal(validateSshUsername('build-agent_2'), 'build-agent_2')
  assert.equal(validateSshPort(65_535), 65_535)
  assert.equal(validateRemoteProjectPath('C:\\Users\\dev\\project'), 'C:\\Users\\dev\\project')

  for (const invalidHost of ['user@host', '-oProxyCommand=bad', 'host/path', 'bad host']) {
    assert.throws(() => validateSshHostname(invalidHost), RemoteSshError)
  }
  for (const invalidUser of ['-root', 'name@host', 'user name', 'user;touch']) {
    assert.throws(() => validateSshUsername(invalidUser), RemoteSshError)
  }
  for (const invalidPort of [0, 65_536, 22.5, '22']) {
    assert.throws(() => validateSshPort(invalidPort), RemoteSshError)
  }
  for (const invalidProject of ['relative/project', '/', 'C:\\', '/srv/../root']) {
    assert.throws(() => validateRemoteProjectPath(invalidProject), RemoteSshError)
  }
  await assert.rejects(
    validateRemoteSshConnection(connection({ password: 'not accepted' })),
    (error) => error instanceof RemoteSshError && error.code === 'credentials_not_supported',
  )
})

test('a stale renderer without a remote conversation key gets an actionable restart error', async () => {
  const service = new RemoteSshService({
    sshFinder: async () => '/fake/bin/ssh',
    processRunner: async () => processResult(),
  })

  await assert.rejects(
    service.runChat({ connection: connection(), provider: 'codex', prompt: 'Continue' }),
    (error) => error instanceof RemoteSshError
      && error.code === 'client_upgrade_required'
      && error.message.includes('Quit Ensync completely'),
  )
})

test('OpenSSH arguments are fixed, strict-known-host, forwarding-free, and contain no project or prompt data', () => {
  const args = buildSshArguments(connection({ identityFile: '/keys/id_ed25519' }))
  assert.deepEqual(args.slice(-3), ['worker.example.com', 'node', '-'])
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(args.includes('StrictHostKeyChecking=yes'))
  assert.ok(args.includes('ClearAllForwardings=yes'))
  assert.ok(args.includes('ForwardAgent=no'))
  assert.ok(args.includes('PreferredAuthentications=publickey'))
  assert.ok(args.includes('/keys/id_ed25519'))
  assert.ok(!args.some((arg) => /StrictHostKeyChecking=no/i.test(arg)))
  assert.ok(!args.includes('/srv/projects/ensync'))
  assert.ok(!args.includes('private prompt'))
})

test('real service probe uses a fake SSH executable and sends the bridge only over stdin', async () => {
  const calls = []
  const service = new RemoteSshService({
    sshFinder: async () => '/fake/bin/ssh',
    environment: { PATH: '/fake/bin', OPENAI_API_KEY: 'local-key-must-not-leak' },
    processRunner: async (...args) => {
      calls.push(args)
      return processResult({
        stdout: encodeRemoteBridgeEnvelope({ ok: true, result: probeResult() }),
      })
    },
  })

  const result = await service.probe(connection())
  assert.equal(calls.length, 1)
  const [executable, args, options] = calls[0]
  assert.equal(executable, '/fake/bin/ssh')
  assert.equal(Array.isArray(args), true)
  assert.deepEqual(args.slice(-3), ['worker.example.com', 'node', '-'])
  assert.equal(args.includes('/srv/projects/ensync'), false)
  assert.equal(options.input.includes('/srv/projects/ensync'), false)
  assert.equal(options.env.OPENAI_API_KEY, undefined)
  assert.equal(result.transport.hostKeyVerification, 'strict_known_hosts')
  assert.equal(result.remote.platform, 'linux')
  assert.equal(result.node.version, 'v22.18.0')
  assert.equal(result.git.version, 'git version 2.45.2')
  assert.equal(result.providers[0].authentication.method, 'ChatGPT login')
  assert.equal('versionProbe' in result.providers[0], false)
  assert.equal('authenticationProbe' in result.providers[0], false)
})

test('probe distinguishes a verified SSH session with no remote Node.js', async () => {
  const service = new RemoteSshService({
    sshFinder: async () => '/fake/bin/ssh',
    processRunner: async () => processResult({
      exitCode: 127,
      stderr: 'sh: node: command not found',
    }),
  })

  const result = await service.probe(connection())
  assert.equal(result.transport.state, 'verified')
  assert.equal(result.node.available, false)
  assert.equal(result.remote, null)
  assert.equal(result.git.availability, 'unknown')
  assert.deepEqual(result.providers, [])
})

test('SSH transport failures do not claim a connection and return bounded diagnostics', async () => {
  const service = new RemoteSshService({
    sshFinder: async () => '/fake/bin/ssh',
    processRunner: async () => processResult({
      exitCode: 255,
      stderr: `Host key verification failed. token=secret\n${'x'.repeat(1_000)}`,
    }),
  })

  await assert.rejects(
    service.probe(connection()),
    (error) =>
      error instanceof RemoteSshError
      && error.code === 'ssh_connection_failed'
      && error.message.length < 520
      && !error.message.includes('secret'),
  )
})

test('remote Codex chat keeps prompt out of argv and returns only parsed structured output publicly', async () => {
  const prompt = 'Continue the remote implementation without copying context.'
  const cliStdout = [
    'Remote Codex startup diagnostic.',
    JSON.stringify({ type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Remote Codex response' },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 18, output_tokens: 7, cached_input_tokens: 2 },
      model: 'gpt-5.4',
    }),
  ].join('\n')
  let captured
  const events = []
  const service = new RemoteSshService({
    sshFinder: async () => '/fake/bin/ssh',
    processRunner: async (...args) => {
      captured = args
      return processResult({
        stdout: encodeRemoteBridgeEnvelope({
          ok: true,
          result: {
            operation: 'chat',
            provider: 'codex',
            projectPath: '/srv/projects/ensync',
            workspace: remoteWorkspace(),
            executable: '/usr/local/bin/codex',
            authentication: { state: 'authenticated', method: 'ChatGPT login' },
            process: processResult({ stdout: cliStdout, stderr: 'exact remote diagnostic' }),
            remote: {
              platform: 'linux',
              release: '6.8.0',
              arch: 'x64',
              hostname: 'worker',
              nodeVersion: 'v22.18.0',
            },
            completedAt: '2026-08-06T10:05:00.000Z',
          },
        }),
      })
    },
  })

  const result = await service.runChat({
    connection: connection(),
    provider: 'codex',
    workspaceKey: WORKSPACE_KEY,
    prompt,
    model: 'gpt-5.4',
    effort: 'high',
    timeoutMs: 2_000,
  }, { onEvent: (event) => events.push(event) })

  assert.equal(captured[1].includes(prompt), false)
  assert.equal(captured[2].input.includes(prompt), false)
  assert.equal(captured[2].inactivityTimeoutMs, 32_000)
  assert.equal(captured[2].hardTimeoutMs, 32_000)
  const payloadMarker = captured[2].input.lastIndexOf(')("')
  const encodedPayload = captured[2].input.slice(payloadMarker + 3).split('",function remoteChatArguments', 1)[0]
  const remotePayload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8'))
  assert.equal(remotePayload.inactivityTimeoutMs, 2_000)
  assert.equal(remotePayload.hardTimeoutMs, 2_000)
  assert.equal(result.response, 'Remote Codex response')
  assert.equal(result.sessionId, '123e4567-e89b-12d3-a456-426614174000')
  assert.equal(result.model, 'gpt-5.4')
  assert.equal(result.requestedEffort, 'high')
  assert.deepEqual(events, [{
    type: 'notice',
    code: 'project_workspace_ready',
    message: `Remote protected workspace used on ${remoteWorkspace().branch} at ${remoteWorkspace().path}. The shared checkout was not the provider working directory.`,
    workspace: { path: remoteWorkspace().path, branch: remoteWorkspace().branch },
    at: events[0].at,
  }])
  assert.deepEqual(result.outputRecovery, {
    applied: true,
    normalizedLineCount: 0,
    discardedLineCount: 1,
  })
  assert.deepEqual(result.usage, {
    source: 'cli',
    inputTokens: 18,
    outputTokens: 7,
    cachedInputTokens: 2,
  })
  assert.equal('process' in result, false)
  assert.equal('stdout' in result, false)
  assert.equal(result.remote.hostKeyVerification, 'strict_known_hosts')
  assert.equal(result.remote.hostname, 'worker')
  assert.equal(result.remote.target.hostname, 'worker.example.com')
})

test('a signal-terminated remote provider never reports a null exit code', async () => {
  const service = new RemoteSshService({
    sshFinder: async () => '/fake/bin/ssh',
    processRunner: async () => processResult({
      stdout: encodeRemoteBridgeEnvelope({
        ok: true,
        result: {
          operation: 'chat',
          provider: 'codex',
          projectPath: '/srv/projects/ensync',
          workspace: remoteWorkspace(),
          process: processResult({ exitCode: null, signal: 'SIGTERM' }),
        },
      }),
    }),
  })

  await assert.rejects(
    service.runChat({ connection: connection(), provider: 'codex', workspaceKey: WORKSPACE_KEY, prompt: 'Continue safely' }),
    (error) =>
      error instanceof RemoteSshError
      && error.code === 'cli_failed'
      && error.safeToRetry === false
      && error.message.includes('terminated by signal SIGTERM')
      && !error.message.includes('code null'),
  )
})

test('remote bridge activity refreshes both bridge and parent watchdogs without exposing transport markers as provider output', async (context) => {
  if (process.platform === 'win32') return context.skip('The remote bridge intentionally rejects Windows command shims.')
  const directory = await mkdtemp(join(tmpdir(), 'ensync-ssh-progress-'))
  const projectPath = join(directory, 'project')
  const executable = join(directory, 'codex')
  await mkdir(projectPath)
  for (const args of [
    ['init', '--initial-branch=main'],
    ['config', 'user.name', 'Ensync Test'],
    ['config', 'user.email', 'ensync@example.test'],
  ]) {
    const result = await runGit(args, { cwd: projectPath })
    assert.equal(result.exitCode, 0, result.stderr)
  }
  await writeFile(join(projectPath, 'tracked.txt'), 'baseline\n')
  for (const args of [['add', 'tracked.txt'], ['commit', '-m', 'baseline']]) {
    const result = await runGit(args, { cwd: projectPath })
    assert.equal(result.exitCode, 0, result.stderr)
  }
  const baseline = (await runGit(['rev-parse', 'HEAD'], { cwd: projectPath })).stdout.trim()
  assert.equal((await runGit(['config', 'core.autocrlf', 'true'], { cwd: projectPath })).exitCode, 0)
  await writeFile(join(projectPath, 'tracked.txt'), 'unique shared-checkout change\n')
  await writeFile(join(projectPath, 'untracked.txt'), 'unique untracked change\n')
  await writeFile(executable, `#!${process.execPath}\n${[
    "const args = process.argv.slice(2)",
    "if (args[0] === 'login') { console.log('Logged in with ChatGPT'); process.exit(0) }",
    "const events = [",
    "  { type: 'thread.started', thread_id: '123e4567-e89b-12d3-a456-426614174000' },",
    "  ...Array.from({ length: 8 }, (_, index) => ({ type: 'item.updated', item: { type: 'reasoning', text: String(index) } })),",
    "  { type: 'item.completed', item: { type: 'agent_message', text: 'Remote progress completed' } },",
    "  { type: 'turn.completed' },",
    "]",
    "let index = 0",
    "const timer = setInterval(() => {",
    "  console.log(JSON.stringify(events[index++]));",
    "  if (index === events.length) { clearInterval(timer); process.exit(0) }",
    "}, 180)",
  ].join('\n')}\n`)
  await chmod(executable, 0o755)
  context.after(() => rm(directory, { recursive: true, force: true }))

  const bridge = await runProcess(process.execPath, ['-'], {
    input: createRemoteBridgeInput({
      operation: 'chat',
      provider: 'codex',
      projectPath,
      workspaceKey: WORKSPACE_KEY,
      prompt: 'Keep working while progress is emitted.',
      sessionId: null,
      model: null,
      effort: null,
      inactivityTimeoutMs: 400,
      hardTimeoutMs: 5_000,
    }),
    env: { ...process.env, HOME: directory, PATH: `${directory}${delimiter}${process.env.PATH ?? ''}` },
    inactivityTimeoutMs: 1_250,
    hardTimeoutMs: 6_000,
    maxCaptureBytes: 12 * 1024 * 1024,
  })

  assert.equal(bridge.timedOut, false)
  assert.equal(bridge.exitCode, 0)
  assert.match(bridge.stderr, /ENSYNC_SSH_PROGRESS_V1:(?:spawn|stdout)/)
  const envelope = decodeRemoteBridgeEnvelope(bridge.stdout)
  assert.equal(envelope?.ok, true)
  assert.equal(envelope.result.projectPath, await realpath(projectPath))
  assert.notEqual(envelope.result.workspace.path, envelope.result.projectPath)
  assert.match(envelope.result.workspace.branch, /^ensync\/chat-[a-f0-9]{24}$/)
  assert.equal(envelope.result.workspace.seededFromSharedCheckout, true)
  assert.equal(envelope.result.workspace.gitBefore.head, baseline)
  assert.equal(envelope.result.workspace.gitBefore.changedFiles, 2)
  assert.equal(await readFile(join(envelope.result.workspace.path, 'tracked.txt'), 'utf8'), 'unique shared-checkout change\n')
  assert.equal(await readFile(join(envelope.result.workspace.path, 'untracked.txt'), 'utf8'), 'unique untracked change\n')
  assert.equal(await readFile(join(projectPath, 'tracked.txt'), 'utf8'), 'unique shared-checkout change\n')
  assert.equal(await readFile(join(projectPath, 'untracked.txt'), 'utf8'), 'unique untracked change\n')
  assert.equal(envelope.result.process.timedOut, false)
  assert.equal(envelope.result.process.stdout.includes('Remote progress completed'), true)
  assert.equal(envelope.result.process.stdout.includes('ENSYNC_SSH_PROGRESS_V1'), false)
  assert.equal(envelope.result.process.stderr.includes('ENSYNC_SSH_PROGRESS_V1'), false)
  assert.equal((await runGit(['status', '--porcelain'], { cwd: projectPath })).stdout.trim().split('\n').length, 2)
})

test('process adapter retains exact provider streams internally while the service handles safe remote preflight errors', async () => {
  const exactStdout = '{"type":"result","is_error":false,"result":"ok"}\n'
  const exactStderr = 'provider stderr\n'
  const adapter = new RemoteSshProcessAdapter({
    sshFinder: async () => '/fake/bin/ssh',
    processRunner: async () => processResult({
      stdout: encodeRemoteBridgeEnvelope({
        ok: true,
        result: {
          process: processResult({ stdout: exactStdout, stderr: exactStderr }),
        },
      }),
    }),
  })
  const execution = await adapter.execute(connection(), { operation: 'test' })
  assert.equal(execution.envelope.result.process.stdout, exactStdout)
  assert.equal(execution.envelope.result.process.stderr, exactStderr)

  const unavailable = new RemoteSshService({
    sshFinder: async () => '/fake/bin/ssh',
    processRunner: async () => processResult({
      stdout: encodeRemoteBridgeEnvelope({
        ok: false,
        error: { code: 'provider_unavailable', message: 'raw remote detail' },
      }),
    }),
  })
  await assert.rejects(
    unavailable.runChat({
      connection: connection(),
      provider: 'claude',
      workspaceKey: WORKSPACE_KEY,
      prompt: 'Hello',
    }),
    (error) =>
      error instanceof RemoteSshError
      && error.code === 'provider_unavailable'
      && error.safeToRetry === true
      && !error.message.includes('raw remote detail'),
  )
  await assert.rejects(
    unavailable.runChat({
      connection: connection(),
      provider: 'claude',
      workspaceKey: WORKSPACE_KEY,
      prompt: 'Hello',
      effort: 'ultra',
    }),
    (error) => error instanceof RemoteSshError && error.code === 'invalid_effort',
  )
  await assert.rejects(
    unavailable.runChat({
      connection: connection(),
      provider: 'claude',
      workspaceKey: WORKSPACE_KEY,
      prompt: 'Hello',
      attachments: ['/Users/example/local.png'],
    }),
    (error) => error instanceof RemoteSshError && error.code === 'remote_attachments_unsupported',
  )
})

test('SSH timeout errors distinguish bridge inactivity from the transport hard ceiling and are never retryable', async () => {
  const remoteIdle = new RemoteSshService({
    sshFinder: async () => '/fake/bin/ssh',
    processRunner: async () => processResult({
      stdout: encodeRemoteBridgeEnvelope({
        ok: true,
        result: {
          projectPath: '/srv/projects/ensync',
          workspace: remoteWorkspace(),
          process: processResult({ timedOut: true, timeoutReason: 'inactivity' }),
        },
      }),
    }),
  })
  await assert.rejects(
    remoteIdle.runChat({ connection: connection(), provider: 'codex', workspaceKey: WORKSPACE_KEY, prompt: 'Continue' }),
    (error) =>
      error instanceof RemoteSshError
      && error.code === 'run_timed_out'
      && error.safeToRetry === false
      && error.message.includes('no CLI output or lifecycle progress')
      && error.message.includes('Partial work may exist'),
  )

  const transportHardLimit = new RemoteSshProcessAdapter({
    sshFinder: async () => '/fake/bin/ssh',
    processRunner: async () => processResult({ timedOut: true, timeoutReason: 'hard_limit' }),
  })
  await assert.rejects(
    transportHardLimit.execute(connection(), { operation: 'chat' }),
    (error) =>
      error instanceof RemoteSshError
      && error.code === 'ssh_timed_out'
      && error.safeToRetry === false
      && error.message.includes('hard run limit')
      && error.message.includes('partial work'),
  )
})

test('SSH host routes return only the injected verified service result', async (context) => {
  const expected = {
    transport: {
      state: 'verified',
      hostKeyVerification: 'strict_known_hosts',
      target: {
        hostname: 'worker.example.com',
        username: 'developer',
        port: 22,
        projectPath: '/srv/projects/ensync',
        identityMode: 'ssh_agent_or_default_identity',
      },
    },
    ...probeResult(),
  }
  let received
  const server = createEnsyncHost({
    remoteSshService: {
      async probe(input) {
        received = input
        return expected
      },
      async runChat() {
        throw new Error('not used')
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  const request = connection()
  const response = await fetch(`http://127.0.0.1:${address.port}/api/remote/ssh/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(received, request)
  assert.deepEqual(await response.json(), { probe: expected })
})

test('SSH host route preserves bounded retry safety without leaking remote details', async (context) => {
  const server = createEnsyncHost({
    remoteSshService: {
      async probe() {
        throw new Error('not used')
      },
      async runChat() {
        throw new RemoteSshError(
          'provider_not_authenticated',
          'The requested provider is not authenticated on the remote machine.',
          409,
          true,
        )
      },
    },
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/remote/ssh/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection: connection(), provider: 'codex', workspaceKey: WORKSPACE_KEY, prompt: 'Hello' }),
  })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'The requested provider is not authenticated on the remote machine.',
    code: 'provider_not_authenticated',
    safeToRetry: true,
  })
})

test('remote chat cancellation reaches the exact OpenSSH process and is never retryable', async () => {
  const controller = new AbortController()
  let receivedSignal
  const service = new RemoteSshService({
    sshFinder: async () => '/fake/bin/ssh',
    processRunner: async (_executable, _args, options) => {
      receivedSignal = options.signal
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
      return processResult({ exitCode: null, signal: 'SIGTERM', aborted: true })
    },
  })

  const run = service.runChat({
    connection: connection(),
    provider: 'codex',
    workspaceKey: WORKSPACE_KEY,
    prompt: 'Continue remotely',
  }, { signal: controller.signal })
  setTimeout(() => controller.abort(), 10)

  await assert.rejects(run, (error) =>
    error instanceof RemoteSshError
    && error.code === 'run_cancelled'
    && error.status === 499
    && error.safeToRetry === false)
  assert.equal(receivedSignal, controller.signal)
})
