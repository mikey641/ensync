import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createEnsyncHost, startEnsyncHost } from './server.mjs'
import { SupportRepairError } from './support-repair.mjs'
import { RemoteSshError } from './remote-ssh.mjs'
import { TelegramBridgeError } from './telegram.mjs'
import { VirtualBoxError } from './virtualbox.mjs'

async function withHost(context, options) {
  const server = createEnsyncHost({
    statusService: { list: async () => [], get: async () => null },
    chatService: { run: async () => ({ response: 'unused' }) },
    projectService: {},
    supportRepairService: { run: async () => ({ status: 'unused' }) },
    supportService: { status: () => ({}), preview: async () => ({}), prepareGitHubIssue: () => ({}) },
    gitService: {},
    ...options,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  return `http://127.0.0.1:${address.port}`
}

test('Host startup resumes the automatic landing queue without polling', async (context) => {
  let starts = 0
  const server = startEnsyncHost({
    host: '127.0.0.1',
    port: 0,
    landingCoordinator: {
      async start() { starts += 1 },
      hasActiveWork() { return false },
    },
    statusService: { list: async () => [], get: async () => null },
    chatService: { run: async () => ({ response: 'unused' }) },
    projectService: {},
    supportRepairService: { run: async () => ({ status: 'unused' }) },
    supportService: { status: () => ({}), preview: async () => ({}), prepareGitHubIssue: () => ({}) },
    gitService: {},
  })
  context.after(() => new Promise((resolve) => server.close(resolve)))
  await once(server, 'listening')
  await Promise.resolve()

  assert.equal(starts, 1)
  assert.equal(server.ensyncServices.landingCoordinator.hasActiveWork(), false)
})

function assertNoForbiddenJobData(value) {
  const forbidden = new Set(['prompt', 'attachments', 'projectPath', 'repositoryPath', 'token', 'pid', 'request'])
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenJobData(item)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `occupied response exposed ${key}`)
    assertNoForbiddenJobData(item)
  }
}

test('occupied job admission returns bounded owner data without request details', async (context) => {
  let runs = 0
  const projectIsolationService = {
    async tryAcquireOrDescribe() {
      return {
        disposition: 'occupied',
        owner: {
          jobId: 'job_1111111111111111', provider: 'codex', targetKind: 'local',
          startedAt: '2026-08-11T10:00:00.000Z', providerProcessStarted: true,
          steerable: true, nativeWorkspaceId: '11111111-1111-4111-8111-111111111111',
        },
      }
    },
  }
  const baseUrl = await withHost(context, {
    projectIsolationService,
    chatService: {
      run: async () => { runs += 1 },
      steer: async () => ({}),
      canSteer: () => false,
      answerQuestion: async () => ({}),
      pendingQuestions: () => [],
    },
  })
  const response = await fetch(`${baseUrl}/api/chat/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: 'job_2222222222222222', kind: 'local',
      request: {
        provider: 'codex', prompt: 'private prompt', attachments: ['/private.png'],
        projectPath: '/private/project', workspaceKey: 'workspace:chat-a',
      },
      navigation: { nativeWorkspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'project-a', chatId: 'chat-a' },
    }),
  })

  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.deepEqual(payload, {
    disposition: 'occupied',
    owner: {
      jobId: 'job_1111111111111111', provider: 'codex', targetKind: 'local',
      startedAt: '2026-08-11T10:00:00.000Z', providerProcessStarted: true,
      steerable: true, nativeWorkspaceId: '11111111-1111-4111-8111-111111111111',
      turnId: null,
    },
  })
  assertNoForbiddenJobData(payload)
  assert.equal(runs, 0)
})

test('support repair route returns only the injected subscription repair result', async (context) => {
  const calls = []
  const supportRepairService = {
    async run(input) {
      calls.push(input)
      return {
        status: 'agent_run_completed',
        verification: 'requires_user_review',
        run: { response: 'Checked and edited the verified project.', usage: { source: 'cli' } },
      }
    },
  }
  const baseUrl = await withHost(context, { supportRepairService })
  const request = { provider: 'codex', projectId: 'project-1', prompt: 'Fix it.' }
  const response = await fetch(`${baseUrl}/api/support/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  })

  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.status, 'agent_run_completed')
  assert.equal(payload.verification, 'requires_user_review')
  assert.deepEqual(calls, [request])
})

test('account sync routes expose only status and encrypted-service workflow results', async (context) => {
  const calls = []
  const accountSyncService = {
    status: () => ({ configured: true, authenticated: false, username: null }),
    register: async (input) => {
      calls.push(['register', input])
      return { configured: true, authenticated: true, username: input.username }
    },
    login: async (input) => {
      calls.push(['login', input])
      return { configured: true, authenticated: true, username: input.username }
    },
    logout: async () => ({ configured: true, authenticated: false, username: null }),
    pull: async () => ({ state: { chats: [] }, revision: 4, updatedAt: '2026-08-07T10:00:00.000Z' }),
    push: async (state, baseRevision) => {
      calls.push(['push', state, baseRevision])
      return { status: 'saved', revision: baseRevision + 1, updatedAt: '2026-08-07T10:01:00.000Z' }
    },
  }
  const baseUrl = await withHost(context, { accountSyncService })

  const status = await fetch(`${baseUrl}/api/account-sync/status`).then((response) => response.json())
  assert.equal(status.authenticated, false)

  const registerResponse = await fetch(`${baseUrl}/api/account-sync/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'account-user', password: 'not-returned' }),
  })
  assert.equal(registerResponse.status, 201)
  assert.equal((await registerResponse.json()).username, 'account-user')

  const pulled = await fetch(`${baseUrl}/api/account-sync/workspace`).then((response) => response.json())
  assert.equal(pulled.revision, 4)
  const pushed = await fetch(`${baseUrl}/api/account-sync/workspace`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: { chats: [{ id: 'chat-a' }] }, baseRevision: 4 }),
  }).then((response) => response.json())
  assert.equal(pushed.revision, 5)
  assert.deepEqual(calls, [
    ['register', { username: 'account-user', password: 'not-returned' }],
    ['push', { chats: [{ id: 'chat-a' }] }, 4],
  ])
})

test('support repair route preserves explicit non-automatic retry policy', async (context) => {
  const supportRepairService = {
    async run() {
      throw new SupportRepairError('provider_quota', 'Quota reached before activity.', 429, {
        safeToRetry: true,
        retryReason: 'No project activity was observed; retry still requires explicit approval.',
      })
    },
  }
  const baseUrl = await withHost(context, { supportRepairService })
  const response = await fetch(`${baseUrl}/api/support/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })

  assert.equal(response.status, 429)
  assert.deepEqual(await response.json(), {
    error: 'Quota reached before activity.',
    code: 'provider_quota',
    safeToRetry: true,
    retry: {
      automatic: false,
      safeToRetry: true,
      reason: 'No project activity was observed; retry still requires explicit approval.',
    },
  })
})

test('support routes expose local preview and unsent issue-draft contracts only', async (context) => {
  const calls = []
  const supportService = {
    status: () => ({
      localReports: { available: true, storage: 'browser_local' },
      humanHelpDesk: { available: false, responseSla: null },
    }),
    async preview(input) {
      calls.push(['preview', input])
      return { report: { ticket: { status: 'local_draft' } }, availability: this.status() }
    },
    prepareGitHubIssue(input) {
      calls.push(['issue', input])
      return { issue: { submitted: false, mode: 'prepare_url_only' } }
    },
  }
  const baseUrl = await withHost(context, { supportService })
  const status = await fetch(`${baseUrl}/api/support/status`).then((response) => response.json())
  assert.equal(status.localReports.available, true)
  assert.equal(status.humanHelpDesk.available, false)

  const previewInput = { category: 'bug', summary: 'Overflow', description: 'Text leaves its card.' }
  const preview = await fetch(`${baseUrl}/api/support/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(previewInput),
  }).then((response) => response.json())
  assert.equal(preview.report.ticket.status, 'local_draft')

  const issueInput = { reviewed: true, report: { ticket: { status: 'local_draft' } } }
  const issue = await fetch(`${baseUrl}/api/support/github-issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(issueInput),
  }).then((response) => response.json())
  assert.equal(issue.issue.submitted, false)
  assert.deepEqual(calls, [['preview', previewInput], ['issue', issueInput]])
})

test('Telegram host routes return direct verified service data and never echo the token', async (context) => {
  const calls = []
  const telegramService = {
    status: () => ({ state: 'disconnected', tokenStorage: 'none' }),
    startPairing: async (token) => {
      calls.push(['pair', token])
      return { pairingId: 'pair-1', code: 'PAIRCODE', tokenStorage: 'memory_only' }
    },
    setTaskContext: (input) => {
      calls.push(['context', input])
      return input
    },
    disconnect: async () => ({ state: 'disconnected', tokenStorage: 'none' }),
    sendMessage: async (text) => ({ connectionId: 'connection-1', deliveries: [{ messageId: 9, text }] }),
    stopPolling: async () => {},
  }
  const baseUrl = await withHost(context, { telegramService })

  const pairing = await fetch(`${baseUrl}/api/telegram/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botToken: '123456:super-secret-bot-token-value' }),
  }).then((response) => response.json())
  assert.equal(pairing.code, 'PAIRCODE')
  assert.equal(JSON.stringify(pairing).includes('super-secret'), false)

  const taskContext = {
    projectId: 'project-1',
    projectLabel: 'Project',
    projectPath: '/project',
    conversationId: 'chat-1',
    provider: 'codex',
  }
  const contextResult = await fetch(`${baseUrl}/api/telegram/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(taskContext),
  }).then((response) => response.json())
  assert.deepEqual(contextResult, taskContext)
  assert.equal(calls[0][0], 'pair')
  assert.equal(calls[1][0], 'context')
})

test('SSH routes expose only verified probe and parsed chat service results', async (context) => {
  const remoteSshService = {
    probe: async (input) => ({
      transport: { state: 'verified', target: { hostname: input.hostname } },
      providers: [],
    }),
    runChat: async (input) => ({
      provider: input.provider,
      response: 'Parsed remote response',
      sessionId: null,
      usage: null,
      remote: { hostname: input.connection.hostname },
    }),
  }
  const baseUrl = await withHost(context, { remoteSshService })
  const connection = {
    hostname: 'worker.example.com',
    username: 'developer',
    port: 22,
    projectPath: '/srv/project',
  }
  const probe = await fetch(`${baseUrl}/api/remote/ssh/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(connection),
  }).then((response) => response.json())
  assert.equal(probe.probe.transport.state, 'verified')

  const chat = await fetch(`${baseUrl}/api/remote/ssh/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection, provider: 'codex', prompt: 'Continue.' }),
  }).then((response) => response.json())
  assert.equal(chat.response, 'Parsed remote response')
  assert.equal('stdout' in chat, false)
  assert.equal('stderr' in chat, false)
})

test('same-Host SSH admission retains one exact conversation bridge while another Host remains independent', async (context) => {
  let firstHostRuns = 0
  let secondHostRuns = 0
  const chatService = {
    run: async () => ({ response: 'unused' }),
    steer: async () => ({}),
    canSteer: () => false,
    answerQuestion: async () => ({}),
    pendingQuestions: () => [],
  }
  const pendingRemoteRun = (count) => async () => {
    count()
    return new Promise(() => {})
  }
  const firstHost = await withHost(context, {
    chatService,
    remoteSshService: {
      runChat: pendingRemoteRun(() => { firstHostRuns += 1 }),
      probe: async () => ({}),
    },
  })
  const secondHost = await withHost(context, {
    chatService,
    remoteSshService: {
      runChat: pendingRemoteRun(() => { secondHostRuns += 1 }),
      probe: async () => ({}),
    },
  })
  const request = {
    connection: {
      hostname: 'Worker.EXAMPLE.com.',
      username: 'developer',
      port: 22,
      projectPath: '/srv/projects/ensync/',
    },
    provider: 'codex',
    workspaceKey: 'canonical-window:remote-chat-1',
    prompt: 'Continue remotely.',
  }
  const start = (baseUrl, jobId, turnId) => fetch(`${baseUrl}/api/chat/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId,
      kind: 'ssh',
      request,
      navigation: {
        nativeWorkspaceId: '11111111-1111-4111-8111-111111111111',
        projectId: 'project-remote',
        chatId: 'chat-remote',
        turnId,
      },
    }),
  })

  const first = await start(firstHost, 'job_ssh_first_00000001', 'turn-ssh-first').then((response) => response.json())
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(firstHostRuns, 1)
  const occupied = await start(firstHost, 'job_ssh_second_0000001', 'turn-ssh-second').then((response) => response.json())
  const crossHost = await start(secondHost, 'job_ssh_crosshost_00001', 'turn-ssh-cross').then((response) => response.json())
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(secondHostRuns, 1)

  assert.equal(first.disposition, 'started', JSON.stringify(first))
  assert.equal(occupied.disposition, 'occupied')
  assert.equal(occupied.owner.jobId, 'job_ssh_first_00000001')
  assert.equal(occupied.owner.targetKind, 'ssh')
  assert.equal(occupied.owner.nativeWorkspaceId, null)
  assert.equal(occupied.owner.steerable, false)
  assert.equal(occupied.owner.turnId, 'turn-ssh-first')
  assert.equal(crossHost.disposition, 'started')
  assert.equal(firstHostRuns, 1)
  assert.equal(secondHostRuns, 1)

  const absent = await fetch(`${firstHost}/api/chat/jobs/job_ssh_second_0000001`)
  assert.equal(absent.status, 404)
})

test('SSH route errors preserve safe pre-activity fallback state', async (context) => {
  const remoteSshService = {
    probe: async () => { throw new RemoteSshError('ssh_connection_failed', 'Host verification failed.', 409, true) },
  }
  const baseUrl = await withHost(context, { remoteSshService })
  const response = await fetch(`${baseUrl}/api/remote/ssh/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'Host verification failed.',
    code: 'ssh_connection_failed',
    safeToRetry: true,
  })
})

test('Telegram route errors preserve bounded host error codes', async (context) => {
  const telegramService = {
    status: () => ({ state: 'disconnected' }),
    startPairing: async () => {
      throw new TelegramBridgeError('invalid_token', 'Enter a valid token issued by BotFather.')
    },
    stopPolling: async () => {},
  }
  const baseUrl = await withHost(context, { telegramService })
  const response = await fetch(`${baseUrl}/api/telegram/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ botToken: 'secret' }),
  })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'Enter a valid token issued by BotFather.',
    code: 'invalid_token',
  })
})

test('git unlanded and land routes delegate to the git workflow service', async (context) => {
  const calls = []
  const fakeGit = {
    unlanded: async (projectPath) => {
      calls.push(['unlanded', projectPath])
      return { repositoryPath: projectPath, baseline: { branch: 'main', head: 'abc' }, branches: [], checkedAt: 'now' }
    },
    land: async (input) => {
      calls.push(['land', input])
      return { land: { branch: input.branch, mergedInto: 'main', mergeHead: 'def', completedAt: 'now' }, git: {} }
    },
  }
  const baseUrl = await withHost(context, { gitService: fakeGit })

  const unlandedResponse = await fetch(`${baseUrl}/api/git/unlanded`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: '/tmp/project' }),
  })
  assert.equal(unlandedResponse.status, 200)
  const unlandedBody = await unlandedResponse.json()
  assert.equal(unlandedBody.unlanded.baseline.branch, 'main')

  const landResponse = await fetch(`${baseUrl}/api/git/land`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: '/tmp/project', branch: 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa' }),
  })
  assert.equal(landResponse.status, 200)
  const landBody = await landResponse.json()
  assert.equal(landBody.land.mergedInto, 'main')

  assert.deepEqual(calls.map(([name]) => name), ['unlanded', 'land'])
})

test('the git init route delegates to the git workflow service', async (context) => {
  const calls = []
  const fakeGit = {
    initialize: async (projectPath) => {
      calls.push(projectPath)
      return {
        initialized: true,
        baselineCommitted: true,
        git: { repositoryPath: projectPath, branch: 'main', dirty: false },
      }
    },
  }
  const baseUrl = await withHost(context, { gitService: fakeGit })

  const response = await fetch(`${baseUrl}/api/git/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: '/tmp/project' }),
  })

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.initialized, true)
  assert.equal(body.git.branch, 'main')
  assert.deepEqual(calls, ['/tmp/project'])
})

test('VirtualBox routes expose real service results and partial recovery errors', async (context) => {
  const virtualBoxService = {
    status: async () => ({ installed: false, executable: null, version: null }),
    list: async () => [{ name: 'Existing VM', uuid: 'vm-1', state: 'poweroff' }],
    inspect: async (input) => ({ name: input.name, uuid: 'vm-1', state: 'poweroff' }),
    preview: async (input) => ({ plan: input, confirmation: `CREATE VM ${input.name}` }),
    provision: async () => {
      throw new VirtualBoxError('Disk creation failed.', {
        code: 'virtualbox_provision_failed',
        status: 409,
        partialState: { name: 'Ensync VM', steps: [{ id: 'disk', status: 'failed' }] },
      })
    },
    start: async (input) => ({ name: input.name, started: true }),
  }
  const baseUrl = await withHost(context, {
    virtualBoxService,
    allowVirtualBoxMutation: true,
  })

  const status = await fetch(`${baseUrl}/api/virtualbox/status`).then((response) => response.json())
  assert.equal(status.installed, false)
  assert.equal(status.mutationEnabled, true)
  const listed = await fetch(`${baseUrl}/api/virtualbox/vms`).then((response) => response.json())
  assert.equal(listed.machines[0].name, 'Existing VM')

  const failure = await fetch(`${baseUrl}/api/virtualbox/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Ensync VM' }),
  })
  assert.equal(failure.status, 409)
  assert.deepEqual(await failure.json(), {
    error: 'Disk creation failed.',
    code: 'virtualbox_provision_failed',
    partialState: { name: 'Ensync VM', steps: [{ id: 'disk', status: 'failed' }] },
  })
})
