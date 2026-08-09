import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createEnsyncHost } from './server.mjs'
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
