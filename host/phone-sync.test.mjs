import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AccountSyncService } from './account-sync.mjs'
import { ChatJobService } from './chat-jobs.mjs'
import { applyBrokeredTurn, ConversationReplyWriter, splitConversationIdentity } from './conversation-reply-writer.mjs'
import { HostSecretStore, memorySecretBackend } from './host-secret-store.mjs'
import { createEnsyncHost } from './server.mjs'
import { createEnsyncSyncServer, MemorySyncStore } from '../sync-service/server.mjs'

const PUBLIC_SYNC_URL = 'https://studio-example.trycloudflare.com'

async function eventually(check, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await check()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw lastError ?? new Error('Condition was not reached.')
}

async function startSyncServer(context) {
  const server = createEnsyncSyncServer({ store: new MemorySyncStore() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  }))
  return `http://127.0.0.1:${server.address().port}`
}

async function startHost(context, options) {
  const server = createEnsyncHost({
    statusService: { list: async () => [{ id: 'codex', name: 'Codex', installed: true, connectionState: 'ready', chatExecution: 'supported' }], get: async () => null },
    chatService: { run: async () => ({ response: 'unused' }) },
    projectService: {},
    supportRepairService: { run: async () => ({ status: 'unused' }) },
    supportService: { status: () => ({}), preview: async () => ({}), prepareGitHubIssue: () => ({}) },
    gitService: {},
    syncBrokerPollIntervalMs: 60_000,
    conversationReplyRetryDelaysMs: [20, 20, 20],
    ...options,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(async () => {
    await server.ensyncServices.syncBrokerHost.stop()
    await new Promise((resolve) => server.close(resolve))
  })
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

async function hostJson(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: response.status, body: await response.json() }
}

function decodeLink(url) {
  const [prefix, fragment] = url.split('#link=')
  assert.equal(prefix, 'https://ensync.vercel.app/mobile/')
  return JSON.parse(Buffer.from(fragment, 'base64url').toString('utf8'))
}

async function tempDir(context) {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-phone-sync-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('phone link creates an account silently, starts the Host, and returns a claimable QR link', async (context) => {
  const syncBase = await startSyncServer(context)
  const backend = memorySecretBackend('test_keychain')
  const directory = await tempDir(context)
  const statePath = join(directory, 'ensync-phone-sync-v1.json')
  const { server, baseUrl } = await startHost(context, {
    accountSyncService: new AccountSyncService({ baseUrl: syncBase }),
    hostSecretStore: new HostSecretStore({ backend }),
    phoneSyncStatePath: statePath,
  })

  const created = await hostJson(baseUrl, '/api/account-sync/phone-link', {
    method: 'POST',
    body: JSON.stringify({ syncUrl: PUBLIC_SYNC_URL, label: 'Studio' }),
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.ok(Date.parse(created.body.expiresAt) > Date.now())
  assert.equal(created.body.persistent, true)
  const link = decodeLink(created.body.url)
  assert.equal(link.v, 1)
  assert.equal(link.sync, PUBLIC_SYNC_URL)
  assert.equal(link.hostLabel, 'Studio')
  assert.equal(Buffer.from(link.key, 'base64url').length, 32)
  assert.match(link.username, /^ensync-[0-9a-f]{12}$/)

  const stored = JSON.parse(backend.values.get('account-sync-credentials'))
  assert.equal(stored.username, link.username)
  assert.ok(stored.password.length >= 32)
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.enabled, true)
  assert.equal(state.hostDeviceId, link.hostId)
  assert.ok(!JSON.stringify(state).includes(stored.password), 'state file holds no secret')

  const status = await hostJson(baseUrl, '/api/account-sync/status')
  assert.equal(status.body.authenticated, true)
  assert.equal(status.body.credentialStorage, 'test_keychain')
  assert.equal(server.ensyncServices.syncBrokerHost.status().running, true)

  // A second QR reuses the same account and Host.
  const again = await hostJson(baseUrl, '/api/account-sync/phone-link', { method: 'POST', body: JSON.stringify({ syncUrl: PUBLIC_SYNC_URL }) })
  assert.equal(decodeLink(again.body.url).hostId, link.hostId)
  assert.equal(decodeLink(again.body.url).username, link.username)

  const claim = await fetch(`${syncBase}/v1/broker/links/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: link.token, deviceId: 'phone_0123456789abcdef', label: 'Pixel 8a' }),
  })
  assert.equal(claim.status, 200)

  const phones = await hostJson(baseUrl, '/api/account-sync/phones')
  assert.equal(phones.status, 200)
  assert.deepEqual(phones.body.phones.map((phone) => phone.label), ['Pixel 8a'])

  const revoked = await hostJson(baseUrl, '/api/account-sync/phones/revoke', {
    method: 'POST',
    body: JSON.stringify({ pairingId: phones.body.phones[0].pairingId }),
  })
  assert.equal(revoked.status, 200)
  assert.deepEqual(revoked.body.phones, [])
})

test('phone link fails closed without secret storage or a public Sync address', async (context) => {
  const syncBase = await startSyncServer(context)
  const { baseUrl } = await startHost(context, { accountSyncService: new AccountSyncService({ baseUrl: syncBase }) })

  const noUrl = await hostJson(baseUrl, '/api/account-sync/phone-link', { method: 'POST', body: '{}' })
  assert.equal(noUrl.status, 409)
  assert.equal(noUrl.body.code, 'phone_link_sync_url_unavailable')

  const loopback = await hostJson(baseUrl, '/api/account-sync/phone-link', { method: 'POST', body: JSON.stringify({ syncUrl: 'https://127.0.0.1:4000' }) })
  assert.equal(loopback.body.code, 'phone_link_sync_url_unavailable')

  const noSecrets = await hostJson(baseUrl, '/api/account-sync/phone-link', { method: 'POST', body: JSON.stringify({ syncUrl: PUBLIC_SYNC_URL }) })
  assert.equal(noSecrets.status, 503)
  assert.equal(noSecrets.body.code, 'secret_storage_unavailable')
  assert.equal((await hostJson(baseUrl, '/api/account-sync/status')).body.authenticated, false)
})

test('a linked Host resumes its account and Host role after a restart', async (context) => {
  const syncBase = await startSyncServer(context)
  const backend = memorySecretBackend()
  const statePath = join(await tempDir(context), 'ensync-phone-sync-v1.json')
  const first = await startHost(context, {
    accountSyncService: new AccountSyncService({ baseUrl: syncBase }),
    hostSecretStore: new HostSecretStore({ backend }),
    phoneSyncStatePath: statePath,
  })
  const created = await hostJson(first.baseUrl, '/api/account-sync/phone-link', { method: 'POST', body: JSON.stringify({ syncUrl: PUBLIC_SYNC_URL }) })
  const hostId = decodeLink(created.body.url).hostId
  await first.server.ensyncServices.syncBrokerHost.stop()

  const second = await startHost(context, {
    accountSyncService: new AccountSyncService({ baseUrl: syncBase }),
    hostSecretStore: new HostSecretStore({ backend }),
    phoneSyncStatePath: statePath,
  })
  await second.server.ensyncServices.phoneSync.restore()
  const worker = second.server.ensyncServices.syncBrokerHost.status()
  assert.equal(worker.running, true)
  assert.equal(worker.host.id, hostId)

  // Stopping remote access keeps it off after the next restart.
  await hostJson(second.baseUrl, '/api/remote/broker/stop', { method: 'POST', body: '{}' })
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).enabled, false)
})

test('conversation identity is validated and never reaches the chat request', () => {
  const split = splitConversationIdentity({ provider: 'codex', prompt: 'hi', conversationId: 'chat-1', messageId: 'msg-1' })
  assert.deepEqual(split.request, { provider: 'codex', prompt: 'hi' })
  assert.deepEqual(split.conversation, { conversationId: 'chat-1', messageId: 'msg-1' })
  assert.equal(splitConversationIdentity({ provider: 'codex' }).conversation, null)
  assert.throws(() => splitConversationIdentity({ conversationId: 'bad\nid' }), { code: 'invalid_conversation_id' })
  assert.throws(() => splitConversationIdentity({ messageId: 'orphan' }), { code: 'invalid_conversation_id' })
  assert.throws(() => splitConversationIdentity({ conversationId: 'chat-1', messageId: 7 }), { code: 'invalid_message_id' })
})

test('a brokered reply lands after its user turn in the renderer message shape', () => {
  const document = {
    format: 'ensync-account-conversations',
    version: 1,
    projects: [{ id: 'p1', name: 'Alpha', path: '/repos/alpha', host: 'local', color: '' }],
    chats: [{
      id: 'chat-1',
      projectId: 'p1',
      title: 'Phone chat',
      provider: 'codex',
      messages: [
        { id: 'u1', role: 'user', content: 'first', time: '10:00', createdAt: '2026-11-08T10:00:00.000Z', origin: 'phone' },
        { id: 'u2', role: 'user', content: 'queued later', time: '10:01' },
      ],
    }],
  }
  const chat = applyBrokeredTurn(document, {
    jobId: 'job_0123456789abcdef',
    conversationId: 'chat-1',
    messageId: 'u1',
    request: { provider: 'codex', workspaceKey: 'conversation:chat-1' },
    outcome: { type: 'completed', result: { provider: 'codex', response: 'Done.\n\n## Ensync continuation\nsummary', sessionId: 'sess-1', model: 'gpt-5' } },
    now: new Date('2026-11-08T10:02:00.000Z'),
  })
  assert.deepEqual(chat.messages.map((message) => message.id), ['u1', 'msg-job_0123456789abcdef-agent', 'u2'])
  assert.equal(chat.messages[0].deliveryStatus, 'completed')
  const reply = chat.messages[1]
  assert.equal(reply.role, 'agent')
  assert.equal(reply.turnId, 'u1')
  assert.equal(reply.provider, 'codex')
  assert.equal(reply.model, 'gpt-5')
  assert.equal(reply.content, 'Done.')
  assert.equal(reply.origin, 'host')
  assert.equal(typeof reply.time, 'string')
  assert.equal(chat.continuation.status, 'completed')
  assert.equal(chat.continuation.sessionId, 'sess-1')
  assert.equal(chat.continuation.workspaceKey, 'conversation:chat-1')
  assert.equal(chat.continuation.semanticSummary, 'summary')

  const repeated = applyBrokeredTurn({ ...document, chats: [chat] }, {
    jobId: 'job_0123456789abcdef', conversationId: 'chat-1', messageId: 'u1', request: {}, outcome: { type: 'completed', result: {} },
  })
  assert.equal(repeated, 'unchanged')
  assert.equal(applyBrokeredTurn(document, { jobId: 'job_x', conversationId: 'missing', outcome: { type: 'completed' } }), null)

  const failed = applyBrokeredTurn(document, {
    jobId: 'job_0123456789abcdef', conversationId: 'chat-1', messageId: 'u1', request: { provider: 'codex' },
    outcome: { type: 'failed', message: 'quota exhausted' },
  })
  assert.equal(failed.messages.length, 2)
  assert.equal(failed.messages[0].deliveryStatus, 'failed')
  assert.equal(failed.continuation.status, 'blocked')
  assert.equal(failed.continuation.fallbackReason, 'quota exhausted')
})

test('the reply writer re-merges on a revision conflict instead of overwriting a phone edit', async () => {
  let remote = {
    format: 'ensync-account-conversations', version: 1, projects: [],
    chats: [{ id: 'chat-1', projectId: 'p1', messages: [{ id: 'u1', role: 'user', content: 'hi', time: '' }] }],
  }
  let revision = 3
  let conflictOnce = true
  const pushes = []
  const accountSync = {
    status: () => ({ authenticated: true }),
    pull: async () => ({ state: structuredClone(remote), revision }),
    push: async (document, baseRevision) => {
      if (conflictOnce) {
        conflictOnce = false
        // The phone pushed another message meanwhile.
        remote = { ...remote, chats: [{ ...remote.chats[0], messages: [...remote.chats[0].messages, { id: 'u2', role: 'user', content: 'more', time: '' }] }] }
        revision += 1
        return { status: 'conflict', revision, remoteState: structuredClone(remote) }
      }
      assert.equal(baseRevision, revision)
      pushes.push(document)
      remote = document
      revision += 1
      return { status: 'saved', revision }
    },
  }
  const writer = new ConversationReplyWriter({ accountSyncService: accountSync })
  const result = await writer.write({
    jobId: 'job_0123456789abcdef', conversationId: 'chat-1', messageId: 'u1', request: { provider: 'codex' },
    outcome: { type: 'completed', result: { provider: 'codex', response: 'hello' } },
  })
  assert.equal(result.status, 'saved')
  assert.deepEqual(pushes[0].chats[0].messages.map((message) => message.id), ['u1', 'msg-job_0123456789abcdef-agent', 'u2'])
})

test('a brokered phone turn runs without its conversation identity and its reply is written to the workspace', async (context) => {
  const syncBase = await startSyncServer(context)
  const backend = memorySecretBackend()
  const seen = []
  const chatJobs = new ChatJobService({
    runLocal: async (request) => {
      seen.push(request)
      return { provider: request.provider, response: `Answer to ${request.prompt}`, sessionId: 'sess-42', model: 'gpt-5', completedAt: '2026-11-08T10:00:00.000Z' }
    },
    runRemote: async () => ({ response: 'unused' }),
  })
  const { server, baseUrl } = await startHost(context, {
    accountSyncService: new AccountSyncService({ baseUrl: syncBase }),
    hostSecretStore: new HostSecretStore({ backend }),
    phoneSyncStatePath: join(await tempDir(context), 'state.json'),
    chatJobService: chatJobs,
  })
  const created = await hostJson(baseUrl, '/api/account-sync/phone-link', { method: 'POST', body: JSON.stringify({ syncUrl: PUBLIC_SYNC_URL }) })
  const link = decodeLink(created.body.url)

  // Stand-in for the phone: same account, a client device paired by code.
  const phone = new AccountSyncService({ baseUrl: syncBase })
  await phone.login(JSON.parse(backend.values.get('account-sync-credentials')))
  await phone.registerBrokerDevice({ deviceId: 'phone_0123456789abcdef', role: 'client', label: 'Phone' })
  const pairing = await server.ensyncServices.syncBrokerHost.createPairing()
  await phone.claimBrokerPairing(pairing.code)
  const initial = await phone.pull()
  await phone.push({
    format: 'ensync-account-conversations',
    version: 1,
    projects: [{ id: 'p1', name: 'Alpha', path: '/repos/alpha', host: 'local', color: '' }],
    chats: [{ id: 'chat-1', projectId: 'p1', title: 'From phone', provider: 'codex', messages: [{ id: 'u1', role: 'user', content: 'ping', time: '', origin: 'phone' }] }],
  }, initial.revision)

  await phone.submitBrokerJob({
    hostId: link.hostId,
    jobId: 'job_phone_0123456789',
    kind: 'local',
    request: { provider: 'codex', projectPath: '/repos/alpha', prompt: 'ping', workspaceKey: 'conversation:chat-1', conversationId: 'chat-1', messageId: 'u1' },
  })
  await server.ensyncServices.syncBrokerHost.pollOnce()

  const pulled = await eventually(async () => {
    const value = await phone.pull()
    const chat = value.state.chats.find((item) => item.id === 'chat-1')
    if (chat.messages.length < 2) throw new Error('reply not written yet')
    return chat
  })
  assert.equal(seen.length, 1)
  assert.equal('conversationId' in seen[0], false)
  assert.equal('messageId' in seen[0], false)
  assert.deepEqual(pulled.messages.map((message) => message.role), ['user', 'agent'])
  assert.equal(pulled.messages[0].deliveryStatus, 'completed')
  assert.equal(pulled.messages[1].content, 'Answer to ping')
  assert.equal(pulled.continuation.sessionId, 'sess-42')
})
