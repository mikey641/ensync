import assert from 'node:assert/strict'
import test from 'node:test'

import { AccountSyncService } from './account-sync.mjs'
import { BrokerClient } from '../mobile/src/broker-client.js'
import { linkFragment, parseLinkPayload } from '../mobile/src/link.js'
import { PhoneSync } from '../mobile/src/phone-sync.js'
import { applyPendingOps, createChat, createUserMessage, listProjects, turnRequest } from '../mobile/src/workspace.js'
import { createPhoneSyncHarness } from '../mobile/test/phone-sync-harness.mjs'

function memoryStorage() {
  const values = new Map()
  return {
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, String(value)) },
    removeItem(key) { values.delete(key) },
  }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('condition not met in time')
}

const SEEDED = {
  format: 'ensync-account-conversations',
  version: 1,
  projects: [
    { id: 'project-site', name: 'Site', path: '/Users/me/site', host: 'local', color: '#3b82f6' },
  ],
  chats: [
    {
      id: 'chat-1731000000000',
      projectId: 'project-site',
      title: 'תיקון כותרת',
      subtitle: '',
      group: 'Today',
      provider: 'claude',
      providerMode: 'fixed',
      model: null,
      sizeTier: null,
      messages: [
        { id: 'msg-1731000000001', role: 'user', content: 'תקן את הכותרת', time: '10:00' },
        { id: 'msg-1731000000002', role: 'agent', content: 'Done — **fixed**.', time: '10:01', provider: 'claude', deliveryStatus: 'completed' },
      ],
      continuation: { provider: 'claude', sessionId: 'claude-session-1', turnId: 't1' },
    },
  ],
}

async function linkedSetup(context, harnessOptions = {}) {
  const harness = await createPhoneSyncHarness(harnessOptions)
  context.after(() => harness.close())
  const credentials = { username: `phone-${Math.random().toString(36).slice(2, 8)}`, password: 'a strong mobile encryption password' }
  const host = new AccountSyncService({ baseUrl: harness.baseUrl })
  await host.register(credentials)
  harness.registerAccount(credentials.username, credentials.password)
  const hostDevice = await host.registerBrokerDevice({ deviceId: 'host_phone_sync_0001', role: 'host', label: 'Studio' })
  await host.publishBrokerCapabilities({
    providers: [{ id: 'codex', name: 'Codex', available: true }, { id: 'claude', name: 'Claude Code', available: true }],
    recentProjects: [{ path: '/Users/me/site', name: 'Site' }, { path: '/Users/me/api', name: 'API' }],
  })
  const link = await harness.createLink({ username: credentials.username, hostId: hostDevice.id, hostLabel: 'Studio' })
  return { harness, host, credentials, link }
}

test('a #link= fragment parses into a validated phone link', async () => {
  const payload = { v: 1, sync: 'https://abc.trycloudflare.com', token: 'x'.repeat(32), username: 'mikey', key: Buffer.alloc(32, 7).toString('base64url'), hostId: 'host_studio_000001', hostLabel: 'studio' }
  const fragment = Buffer.from(JSON.stringify(payload)).toString('base64url')
  assert.equal(linkFragment(`#link=${fragment}`), fragment)
  assert.equal(linkFragment('#other=1'), null)
  assert.deepEqual(parseLinkPayload(fragment), payload)
  assert.throws(() => parseLinkPayload(Buffer.from(JSON.stringify({ ...payload, sync: 'http://evil.example' })).toString('base64url')), /HTTPS/)
  assert.throws(() => parseLinkPayload(Buffer.from(JSON.stringify({ ...payload, key: 'short' })).toString('base64url')), /not an Ensync phone link/)
  assert.throws(() => parseLinkPayload('%%%'), /damaged/)
})

test('phone claims a QR link and runs an encrypted brokered turn the Host can decrypt', async (context) => {
  const { host, link } = await linkedSetup(context)
  const phone = await BrokerClient.claimLink(parseLinkPayload(link.fragment), { deviceId: 'client_phone_test_0001', label: 'iPhone' })
  assert.equal(phone.host.id, 'host_phone_sync_0001')
  await assert.rejects(BrokerClient.claimLink(parseLinkPayload(link.fragment)), (error) => error.code === 'broker_link_invalid')

  const restored = await BrokerClient.restore(JSON.parse(JSON.stringify(phone.toJSON())))
  const [listed] = await restored.hosts()
  assert.equal(listed.capabilities.recentProjects.length, 2)

  const chat = SEEDED.chats[0]
  const message = createUserMessage('שלום from the phone', 'claude')
  const request = turnRequest({ chat, project: SEEDED.projects[0], provider: 'claude', prompt: message.content, messageId: message.id })
  const submitted = await restored.submit({ hostId: phone.host.id, request })

  const [received] = await host.pollBrokerHostJobs()
  assert.equal(received.id, submitted.id)
  assert.deepEqual(received.request, {
    provider: 'claude',
    projectPath: '/Users/me/site',
    prompt: 'שלום from the phone',
    workspaceKey: 'conversation:chat-1731000000000',
    sessionId: 'claude-session-1',
    deliveryTarget: 'production',
    conversationId: 'chat-1731000000000',
    messageId: message.id,
  })

  await host.claimBrokerJob(received)
  await host.publishBrokerEvent(received, { type: 'output', stream: 'stdout', text: 'working', at: '2026-11-08T12:00:00.000Z', sequence: 1 })
  const command = await restored.command({ id: submitted.id, hostId: submitted.hostId, clientId: submitted.clientId }, 'steer', { prompt: 'also fix the footer' })
  const [hostCommand] = await host.pollBrokerCommands(received)
  assert.equal(hostCommand.id, command.id)
  assert.deepEqual(hostCommand.payload, { prompt: 'also fix the footer' })
  await host.publishBrokerEvent(received, { type: 'completed', result: { response: 'Delivered.' }, at: '2026-11-08T12:00:01.000Z', sequence: 2 })
  const completed = await restored.job(submitted.id)
  assert.equal(completed.state, 'completed')
  assert.equal(completed.events[1].result.response, 'Delivered.')
})

test('an expired phone session refreshes itself with the refresh token', async (context) => {
  const { harness, link } = await linkedSetup(context, { sessionLifetimeMs: 0 })
  const phone = await BrokerClient.claimLink(parseLinkPayload(link.fragment))
  await phone.hosts()
  assert.ok(harness.stats.refreshes >= 1)
})

test('phone sync reads the desktop document, pushes a phone turn, and receives the Host reply live', async (context) => {
  const { harness, host, link } = await linkedSetup(context)
  await host.push(SEEDED, 0)
  const phone = await BrokerClient.claimLink(parseLinkPayload(link.fragment))
  const sync = new PhoneSync(phone, { storage: memoryStorage() })
  context.after(() => sync.stop())
  sync.start()
  await waitFor(() => sync.loaded && sync.status.state === 'live')
  assert.equal(sync.view().chats[0].title, 'תיקון כותרת')
  const projects = listProjects(sync.view(), sync.host?.capabilities?.recentProjects)
  assert.deepEqual(projects.map((project) => project.name), ['Site', 'API'])

  // A desktop edit lands while the phone is about to push: the phone must re-merge, not overwrite.
  const desktop = await host.pull()
  desktop.state.chats[0].messages.push({ id: 'msg-1731000000003', role: 'user', content: 'desktop follow-up', time: '10:02' })
  await host.push(desktop.state, desktop.revision)

  const chat = sync.chat('chat-1731000000000')
  const message = createUserMessage('גם תעדכן את הפוטר', 'claude')
  sync.send({ chat, project: projects[0], message, request: turnRequest({ chat, project: projects[0], provider: 'claude', prompt: message.content, messageId: message.id }) })
  await waitFor(() => sync.jobs[0]?.submitted)

  const pushed = await host.pull()
  const ids = pushed.state.chats[0].messages.map((item) => item.id)
  assert.deepEqual(ids, ['msg-1731000000001', 'msg-1731000000002', 'msg-1731000000003', message.id])
  assert.equal(pushed.state.chats[0].messages[3].origin, 'phone')

  const [job] = await host.pollBrokerHostJobs()
  assert.equal(job.request.conversationId, 'chat-1731000000000')
  assert.equal(job.request.messageId, message.id)
  await host.claimBrokerJob(job)
  await host.publishBrokerEvent(job, { type: 'completed', result: { response: 'עודכן.' }, at: '2026-11-08T12:00:00.000Z', sequence: 1 })
  // Host writes the durable reply into the document (spec step 3).
  pushed.state.chats[0].messages.push({ id: 'msg-1731000000099-reply', role: 'agent', content: 'עודכן.', time: '12:00', provider: 'claude', deliveryStatus: 'completed' })
  await host.push(pushed.state, pushed.revision)

  await waitFor(() => sync.chat('chat-1731000000000').messages.at(-1).content === 'עודכן.')
  await waitFor(() => sync.jobs.length === 0)
  assert.ok(harness.stats.waits >= 1)
})

test('a new chat from the phone for a Host recent project adds the project and chat to the document', async (context) => {
  const { host, link } = await linkedSetup(context, { waitSupported: false })
  await host.push(SEEDED, 0)
  const phone = await BrokerClient.claimLink(parseLinkPayload(link.fragment))
  const sync = new PhoneSync(phone, { storage: memoryStorage() })
  context.after(() => sync.stop())
  sync.start()
  await waitFor(() => sync.loaded && sync.host?.capabilities)
  const api = listProjects(sync.view(), sync.host.capabilities.recentProjects).find((project) => project.name === 'API')
  assert.equal(api.origin, 'host')
  const chat = createChat({ projectId: api.id, provider: 'codex', prompt: 'Add a health endpoint' })
  const message = createUserMessage('Add a health endpoint', 'codex')
  sync.send({ chat, project: api, newProject: { id: api.id, name: api.name, path: api.path, host: 'local', color: '' }, message, request: turnRequest({ chat, project: api, provider: 'codex', prompt: message.content, messageId: message.id }) })
  await waitFor(() => sync.jobs[0]?.submitted)
  const pulled = await host.pull()
  assert.ok(pulled.state.projects.some((project) => project.id === api.id && project.path === '/Users/me/api'))
  const created = pulled.state.chats.find((item) => item.id === chat.id)
  assert.equal(created.title, 'Add a health endpoint')
  assert.equal(created.messages[0].content, 'Add a health endpoint')
  const [job] = await host.pollBrokerHostJobs()
  assert.equal(job.request.workspaceKey, `conversation:${chat.id}`)
  assert.equal(job.request.sessionId, undefined)
})

test('pending phone edits never resurrect chats the desktop deleted', () => {
  const base = { ...SEEDED, chats: [] }
  const message = createUserMessage('hi', 'codex')
  const next = applyPendingOps(base, [{ chatId: 'chat-gone', chat: null, message }])
  assert.equal(next.chats.length, 0)
})
