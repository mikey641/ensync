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


// End to end: the real phone client (mobile/src) against the real Sync service and Host.
import { BrokerClient } from '../mobile/src/broker-client.js'
import { parseLinkPayload } from '../mobile/src/link.js'
import { PhoneSync } from '../mobile/src/phone-sync.js'
import { createUserMessage, listProjects, projectChats, turnRequest } from '../mobile/src/workspace.js'

function memoryStorage() {
  const values = new Map()
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k) }
}

test('QR link → phone sends in a desktop chat → Mac runs it → reply appears on the phone and in the desktop doc', async (context) => {
  const syncBase = await startSyncServer(context)
  const backend = memorySecretBackend('test_keychain')
  const seen = []
  const chatJobs = new ChatJobService({
    runLocal: async (request) => {
      seen.push(request)
      return { provider: request.provider, response: `תשובה: ${request.prompt}`, sessionId: 'sess-e2e', model: 'opus', completedAt: new Date().toISOString() }
    },
    runRemote: async () => ({ response: 'unused' }),
  })
  const { server, baseUrl } = await startHost(context, {
    accountSyncService: new AccountSyncService({ baseUrl: syncBase }),
    hostSecretStore: new HostSecretStore({ backend }),
    phoneSyncStatePath: join(await tempDir(context), 'state.json'),
    chatJobService: chatJobs,
    syncBrokerPollIntervalMs: 50,
  })
  const created = await hostJson(baseUrl, '/api/account-sync/phone-link', { method: 'POST', body: JSON.stringify({ syncUrl: PUBLIC_SYNC_URL, label: 'studio' }) })
  assert.equal(created.status, 200, JSON.stringify(created.body))

  // Desktop already has a project + chat in its synced document.
  const desktop = new AccountSyncService({ baseUrl: syncBase })
  await desktop.login(JSON.parse(backend.values.get('account-sync-credentials')))
  const initial = await desktop.pull()
  await desktop.push({
    format: 'ensync-account-conversations', version: 1,
    projects: [{ id: 'p1', name: 'assistant', path: '/Users/me/assistant', host: 'local', color: '' }],
    chats: [{ id: 'chat-1', projectId: 'p1', title: 'מייל לעורך דין', provider: 'claude', messages: [{ id: 'd1', role: 'user', content: 'from desktop', time: '', provider: 'claude' }] }],
  }, initial.revision)

  // Phone scans the QR (the tunnel URL is swapped for the local test server).
  const payload = JSON.parse(Buffer.from(created.body.url.split('#link=')[1], 'base64url').toString('utf8'))
  const link = parseLinkPayload(Buffer.from(JSON.stringify({ ...payload, sync: syncBase })).toString('base64url'))
  const client = await BrokerClient.claimLink(link, { label: 'Pixel 8a' })
  const sync = new PhoneSync(client, { storage: memoryStorage() })
  context.after(() => sync.stop())
  sync.start()
  await eventually(() => { if (!sync.loaded) throw new Error('not loaded') })

  const view = sync.view()
  const project = listProjects(view, []).find((item) => item.id === 'p1')
  assert.ok(project, 'desktop project visible on phone')
  const chat = projectChats(view, 'p1').find((item) => item.id === 'chat-1')
  assert.equal(chat.title, 'מייל לעורך דין')

  const message = createUserMessage('יש חדש?', 'claude')
  sync.send({ chat, project, message, request: turnRequest({ chat, project, provider: 'claude', prompt: message.content, messageId: message.id }) })

  // Mac runs it; the reply lands in the document; the phone sees it.
  const reply = await eventually(() => {
    const current = sync.view().chats.find((item) => item.id === 'chat-1')
    const agent = current.messages.find((item) => item.role === 'agent')
    if (!agent) throw new Error('no reply on phone yet')
    return agent
  }, 8_000)
  assert.equal(reply.content, 'תשובה: יש חדש?')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].projectPath, '/Users/me/assistant')
  assert.equal(seen[0].workspaceKey, 'conversation:chat-1')

  const desktopView = (await desktop.pull()).state.chats.find((item) => item.id === 'chat-1')
  assert.deepEqual(desktopView.messages.map((item) => item.role), ['user', 'user', 'agent'])
  assert.equal(desktopView.continuation.sessionId, 'sess-e2e')
  void server
})
