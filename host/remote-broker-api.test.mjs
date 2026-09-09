import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AccountSyncService } from './account-sync.mjs'
import { ChatJobService } from './chat-jobs.mjs'
import { createEnsyncHost } from './server.mjs'
import { createEnsyncSyncServer, MemorySyncStore } from '../sync-service/server.mjs'

const CAPABILITY_PASSWORD = 'a strong sync capability password'

async function eventually(check, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      return await check()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError ?? new Error('Condition was not reached.')
}

async function startSyncServer(context) {
  const server = createEnsyncSyncServer({ store: new MemorySyncStore() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  assert.equal(typeof address, 'object')
  return `http://127.0.0.1:${address.port}`
}

async function startHostServer(context, options = {}) {
  const server = createEnsyncHost({
    statusService: { list: async () => [], get: async () => null },
    chatService: { run: async () => ({ response: 'unused' }) },
    projectService: {},
    supportRepairService: { run: async () => ({ status: 'unused' }) },
    supportService: {
      status: () => ({}),
      preview: async () => ({}),
      prepareGitHubIssue: () => ({}),
    },
    gitService: {},
    ...options,
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => new Promise((resolve) => server.close(resolve)))
  const address = server.address()
  assert.equal(typeof address, 'object')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function rawJson(baseUrl, path, options = {}) {
  const headers = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.sessionToken) headers.Authorization = `Bearer ${options.sessionToken}`
  if (options.deviceId) headers['X-Ensync-Device-Id'] = options.deviceId
  if (options.deviceToken) headers['X-Ensync-Device-Token'] = options.deviceToken
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return {
    status: response.status,
    payload: await response.json().catch(() => ({})),
  }
}

test('remote broker API starts a Host, publishes capabilities, and runs an encrypted job end-to-end', async (context) => {
  const syncBase = await startSyncServer(context)
  const credentials = { username: 'remote-broker', password: 'a secure remote broker password' }

  const hostAccount = new AccountSyncService({ baseUrl: syncBase })
  await hostAccount.register(credentials)
  const clientAccount = new AccountSyncService({ baseUrl: syncBase })
  await clientAccount.login(credentials)

  const recentDir = await mkdtemp(join(tmpdir(), 'ensync-remote-broker-'))
  context.after(() => rm(recentDir, { recursive: true, force: true }))
  const recentProjectsPath = join(recentDir, 'global-recent-projects-v1.json')
  await writeFile(recentProjectsPath, JSON.stringify({
    payload: JSON.stringify({
      projects: [
        { path: '/repos/alpha', name: 'Alpha' },
        { path: '/repos/beta' },
      ],
    }),
  }))

  let releaseRun
  const chatJobs = new ChatJobService({
    runLocal: async (request, options) => {
      options.onEvent({ type: 'started', provider: request.provider, at: '2026-08-08T11:00:00.000Z' })
      await new Promise((resolve) => { releaseRun = resolve })
      return { provider: request.provider, response: `Finished ${request.prompt}`, sessionId: null, usage: null }
    },
    runRemote: async () => ({ response: 'unused' }),
    steerLocal: async (jobId, input) => ({ jobId, prompt: input.prompt }),
    canSteerLocal: () => true,
  })

  const statusService = {
    list: async () => [
      { id: 'codex', name: 'Codex', installed: true, connectionState: 'ready', chatExecution: 'supported', token: 'SECRET' },
      { id: 'claude', name: 'Claude Code', installed: true, connectionState: 'unavailable', chatExecution: 'supported', apiKey: 'SECRET' },
      { id: 'kimi', name: 'Kimi Code', installed: true, connectionState: 'ready', chatExecution: 'discovery_only' },
    ],
    get: async () => null,
  }

  const host = await startHostServer(context, {
    accountSyncService: hostAccount,
    chatJobService: chatJobs,
    statusService,
    recentProjectsPath,
    syncBrokerPollIntervalMs: 60_000,
  })
  const client = await startHostServer(context, { accountSyncService: clientAccount })

  // Every broker route requires the signed-in account session.
  const anonymous = await startHostServer(context, {
    accountSyncService: new AccountSyncService({ baseUrl: syncBase }),
  })
  const guarded = await fetch(`${anonymous.baseUrl}/api/remote/broker/status`)
  assert.equal(guarded.status, 401)
  assert.equal((await guarded.json()).code, 'sync_login_required')

  const startResponse = await fetch(`${host.baseUrl}/api/remote/broker/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Test Host' }),
  })
  assert.equal(startResponse.status, 200)
  const startStatus = await startResponse.json()
  assert.equal(startStatus.state, 'connected')
  assert.equal(startStatus.host.role, 'host')
  const hostId = startStatus.host.id

  const statusResponse = await fetch(`${host.baseUrl}/api/remote/broker/status`)
  assert.equal(statusResponse.status, 200)
  const statusBody = await statusResponse.json()
  assert.deepEqual(statusBody.brokerDevice, { id: hostId, role: 'host' })

  const capabilitiesResponse = await fetch(`${host.baseUrl}/api/remote/broker/capabilities`, {
    method: 'POST',
  })
  assert.equal(capabilitiesResponse.status, 200)
  const capabilitiesBody = await capabilitiesResponse.json()
  assert.deepEqual(capabilitiesBody.capabilities.providers, [
    { id: 'codex', name: 'Codex', available: true },
    { id: 'claude', name: 'Claude Code', available: false },
  ])
  assert.deepEqual(capabilitiesBody.capabilities.recentProjects, [
    { path: '/repos/alpha', name: 'Alpha' },
    { path: '/repos/beta' },
  ])

  const pairingResponse = await fetch(`${host.baseUrl}/api/remote/broker/pairing`, { method: 'POST' })
  assert.equal(pairingResponse.status, 200)
  const pairing = await pairingResponse.json()
  assert.equal(typeof pairing.code, 'string')
  assert.equal(pairing.pairing.host.id, hostId)
  assert.deepEqual(pairing.pairing.host.capabilities, capabilitiesBody.capabilities)

  const registerResponse = await fetch(`${client.baseUrl}/api/remote/broker/client/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Test Client' }),
  })
  assert.equal(registerResponse.status, 200)
  const clientDevice = (await registerResponse.json()).device
  assert.equal(clientDevice.role, 'client')
  assert.match(clientDevice.id, /^client_/)
  const clientId = clientDevice.id

  // Registering again reuses the stable per-process client id.
  const reRegisterResponse = await fetch(`${client.baseUrl}/api/remote/broker/client/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Test Client Renamed' }),
  })
  assert.equal(reRegisterResponse.status, 200)
  assert.equal((await reRegisterResponse.json()).device.id, clientId)

  const claimResponse = await fetch(`${client.baseUrl}/api/remote/broker/client/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: pairing.code }),
  })
  assert.equal(claimResponse.status, 200)
  const claimed = await claimResponse.json()
  assert.equal(claimed.pairing.host.id, hostId)
  assert.equal(claimed.pairing.client.id, clientId)

  const hostsResponse = await fetch(`${client.baseUrl}/api/remote/broker/client/hosts`)
  assert.equal(hostsResponse.status, 200)
  const hostsBody = await hostsResponse.json()
  assert.equal(hostsBody.hosts.length, 1)
  assert.equal(hostsBody.hosts[0].id, hostId)
  assert.deepEqual(hostsBody.hosts[0].capabilities, capabilitiesBody.capabilities)

  const submitResponse = await fetch(`${client.baseUrl}/api/remote/broker/client/job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostId, provider: 'codex', projectPath: '/verified/project', prompt: 'remote task' }),
  })
  assert.equal(submitResponse.status, 202)
  const submitted = await submitResponse.json()
  const jobId = submitted.job.id
  assert.equal(submitted.job.state, 'queued')

  const clientJobUrl = (after = 0) =>
    `${client.baseUrl}/api/remote/broker/client/job?jobId=${encodeURIComponent(jobId)}&after=${after}`

  const hostWorker = host.server.ensyncServices.syncBrokerHost
  await hostWorker.pollOnce()
  await eventually(async () => {
    const response = await fetch(clientJobUrl())
    assert.equal(response.status, 200)
    const body = await response.json()
    if (body.job.state !== 'running') throw new Error('job is not running yet')
  })

  const commandResponse = await fetch(`${client.baseUrl}/api/remote/broker/client/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId,
      type: 'steer',
      payload: { idempotencyKey: 'steer-0000000001', prompt: 'steer instruction' },
    }),
  })
  assert.equal(commandResponse.status, 202)
  const commandBody = await commandResponse.json()
  assert.equal(commandBody.command.type, 'steer')

  await hostWorker.pollOnce()

  releaseRun()
  let completedJob
  await eventually(async () => {
    await hostWorker.pollOnce()
    const response = await fetch(clientJobUrl())
    assert.equal(response.status, 200)
    const body = await response.json()
    if (body.job.state !== 'completed') throw new Error('job is not completed yet')
    completedJob = body.job
  })

  assert.deepEqual(completedJob.events.map((item) => item.event.type), ['started', 'completed'])
  assert.equal(completedJob.events[1].event.result.response, 'Finished remote task')
  const command = completedJob.commands[0]
  assert.equal(command.type, 'steer')
  assert.equal(command.acknowledgement.acknowledgement.accepted, true)
})

test('sync service sanitizes and round-trips broker host capabilities behind the host-auth routes', async (context) => {
  const baseUrl = await startSyncServer(context)
  const created = await rawJson(baseUrl, '/v1/accounts', {
    method: 'POST',
    body: { username: 'capabilities', password: CAPABILITY_PASSWORD },
  })
  assert.equal(created.status, 201)
  const sessionToken = created.payload.token

  const hostId = 'host_capabilities_0001'
  const hostRegistration = await rawJson(baseUrl, '/v1/broker/devices', {
    method: 'POST',
    sessionToken,
    body: { deviceId: hostId, role: 'host', label: 'Capability Host' },
  })
  assert.equal(hostRegistration.status, 201)
  const hostToken = hostRegistration.payload.token

  const putCapabilities = (capabilities) => rawJson(baseUrl, `/v1/broker/hosts/${hostId}/capabilities`, {
    method: 'PUT',
    sessionToken,
    deviceId: hostId,
    deviceToken: hostToken,
    body: { capabilities },
  })

  const put = await putCapabilities({
    providers: [{ id: ' claude ', name: ' Claude Code ', available: true, apiKey: 'SECRET' }],
    recentProjects: [{ path: ' /repos/alpha ', name: ' Alpha ', owner: 'SECRET' }],
    credentials: { token: 'SECRET' },
  })
  assert.equal(put.status, 200)
  assert.deepEqual(put.payload.device.capabilities, {
    providers: [{ id: 'claude', name: 'Claude Code', available: true }],
    recentProjects: [{ path: '/repos/alpha', name: 'Alpha' }],
  })

  const clientLogin = await rawJson(baseUrl, '/v1/sessions', {
    method: 'POST',
    body: { username: 'capabilities', password: CAPABILITY_PASSWORD },
  })
  assert.equal(clientLogin.status, 200)
  const clientToken = clientLogin.payload.token

  const clientId = 'client_capabilities_01'
  const clientRegistration = await rawJson(baseUrl, '/v1/broker/devices', {
    method: 'POST',
    sessionToken: clientToken,
    body: { deviceId: clientId, role: 'client', label: 'Capability Client' },
  })
  assert.equal(clientRegistration.status, 201)
  const clientDeviceToken = clientRegistration.payload.token

  const pairing = await rawJson(baseUrl, '/v1/broker/pairings', {
    method: 'POST',
    sessionToken,
    deviceId: hostId,
    deviceToken: hostToken,
    body: {},
  })
  assert.equal(pairing.status, 201)
  assert.deepEqual(pairing.payload.pairing.host.capabilities, put.payload.device.capabilities)

  const claimed = await rawJson(baseUrl, '/v1/broker/pairings/claim', {
    method: 'POST',
    sessionToken: clientToken,
    deviceId: clientId,
    deviceToken: clientDeviceToken,
    body: { code: pairing.payload.code },
  })
  assert.equal(claimed.status, 200)

  const hosts = await rawJson(baseUrl, '/v1/broker/hosts', {
    method: 'GET',
    sessionToken: clientToken,
    deviceId: clientId,
    deviceToken: clientDeviceToken,
  })
  assert.equal(hosts.status, 200)
  assert.equal(hosts.payload.hosts.length, 1)
  assert.deepEqual(hosts.payload.hosts[0].capabilities, put.payload.device.capabilities)

  const cleared = await putCapabilities(null)
  assert.equal(cleared.status, 200)
  assert.equal(cleared.payload.device.capabilities, null)
})

test('sync service rejects malformed, oversized, or mis-authed broker capabilities', async (context) => {
  const baseUrl = await startSyncServer(context)
  const created = await rawJson(baseUrl, '/v1/accounts', {
    method: 'POST',
    body: { username: 'capvalidation', password: CAPABILITY_PASSWORD },
  })
  assert.equal(created.status, 201)
  const sessionToken = created.payload.token

  const hostId = 'host_capabilities_0002'
  const hostRegistration = await rawJson(baseUrl, '/v1/broker/devices', {
    method: 'POST',
    sessionToken,
    body: { deviceId: hostId, role: 'host', label: 'Validation Host' },
  })
  assert.equal(hostRegistration.status, 201)
  const hostToken = hostRegistration.payload.token

  const putCapabilities = (capabilities) => rawJson(baseUrl, `/v1/broker/hosts/${hostId}/capabilities`, {
    method: 'PUT',
    sessionToken,
    deviceId: hostId,
    deviceToken: hostToken,
    body: { capabilities },
  })

  const manyProviders = Array.from({ length: 101 }, (_, index) => ({
    id: `provider-${index}`, name: `Provider ${index}`, available: true,
  }))
  assert.equal((await putCapabilities({ providers: manyProviders, recentProjects: [] })).status, 400)

  const manyProjects = Array.from({ length: 201 }, (_, index) => ({ path: `/repos/${index}` }))
  assert.equal((await putCapabilities({ providers: [], recentProjects: manyProjects })).status, 400)

  assert.equal((await putCapabilities({
    providers: [{ id: ' ', name: 'Codex', available: true }], recentProjects: [],
  })).status, 400)

  assert.equal((await putCapabilities({
    providers: [{ id: 'x'.repeat(129), name: 'Codex', available: true }], recentProjects: [],
  })).status, 400)

  assert.equal((await putCapabilities({
    providers: [{ id: 'codex', name: 'Codex', available: 'yes' }], recentProjects: [],
  })).status, 400)

  assert.equal((await putCapabilities({
    providers: [], recentProjects: [{ path: 'x'.repeat(1025) }],
  })).status, 400)

  assert.equal((await putCapabilities('not-an-object')).status, 400)

  const clientRegistration = await rawJson(baseUrl, '/v1/broker/devices', {
    method: 'POST',
    sessionToken,
    body: { deviceId: 'client_capabilities_02', role: 'client', label: 'Client' },
  })
  assert.equal(clientRegistration.status, 201)
  const clientDeviceToken = clientRegistration.payload.token

  const wrongRole = await rawJson(baseUrl, `/v1/broker/hosts/${hostId}/capabilities`, {
    method: 'PUT',
    sessionToken,
    deviceId: 'client_capabilities_02',
    deviceToken: clientDeviceToken,
    body: { capabilities: { providers: [], recentProjects: [] } },
  })
  assert.equal(wrongRole.status, 403)

  const mismatchedHost = await rawJson(baseUrl, '/v1/broker/hosts/host_capabilities_0999/capabilities', {
    method: 'PUT',
    sessionToken,
    deviceId: hostId,
    deviceToken: hostToken,
    body: { capabilities: { providers: [], recentProjects: [] } },
  })
  assert.equal(mismatchedHost.status, 403)
})
