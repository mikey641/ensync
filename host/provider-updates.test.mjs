import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createEnsyncHost } from './server.mjs'

function providerStatus(id, overrides = {}) {
  return {
    id,
    name: id === 'codex' ? 'Codex' : 'Kimi Code',
    installed: true,
    executable: process.platform === 'win32' ? `C:\\Tools\\${id}.cmd` : `/opt/tools/${id}`,
    version: `${id} 1.2.3`,
    updateReason: id === 'codex'
      ? 'Codex provides a verified self-update command.'
      : 'Use the official installation and update guide.',
    ...overrides,
  }
}

function statusService(status) {
  return {
    invalidations: 0,
    async get(id) {
      return id === status.id ? status : null
    },
    async list() {
      return [status]
    },
    invalidate() {
      this.invalidations += 1
    },
  }
}

async function startTestHost(context, options) {
  const server = createEnsyncHost(options)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())
  const address = server.address()
  assert.equal(typeof address, 'object')
  return `http://127.0.0.1:${address.port}`
}

test('provider update preview returns only the fixed allowlisted self-update command', async (context) => {
  const statuses = statusService(providerStatus('codex'))
  let launchCalls = 0
  const baseUrl = await startTestHost(context, {
    statusService: statuses,
    terminalLauncher: async () => {
      launchCalls += 1
      return { started: true, launchMode: 'terminal' }
    },
  })

  const response = await fetch(`${baseUrl}/api/providers/codex/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: false, executable: '/tmp/not-codex', args: ['login'] }),
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.started, false)
  assert.deepEqual(payload.command.args, ['update'])
  assert.equal(payload.command.executable, providerStatus('codex').executable)
  assert.equal(payload.previousVersion, 'codex 1.2.3')
  assert.equal(launchCalls, 0)
  assert.equal(statuses.invalidations, 0)
})

test('provider update launches the verified command and invalidates cached status', async (context) => {
  const statuses = statusService(providerStatus('codex'))
  const launches = []
  const baseUrl = await startTestHost(context, {
    statusService: statuses,
    terminalLauncher: async (executable, args) => {
      launches.push({ executable, args })
      return { started: true, launchMode: 'terminal' }
    },
  })

  const response = await fetch(`${baseUrl}/api/providers/codex/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: true }),
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(launches, [{ executable: providerStatus('codex').executable, args: ['update'] }])
  assert.equal(statuses.invalidations, 1)
  assert.match(payload.message, /Update opened in a terminal/)
})

test('provider updates refuse unverified commands and active agent runs', async (context) => {
  const unsupportedBaseUrl = await startTestHost(context, {
    statusService: statusService(providerStatus('jules')),
  })
  const unsupported = await fetch(`${unsupportedBaseUrl}/api/providers/jules/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: true }),
  })
  assert.equal(unsupported.status, 409)
  assert.match((await unsupported.json()).error, /official installation and update guide/)

  const launches = []
  const busyBaseUrl = await startTestHost(context, {
    statusService: statusService(providerStatus('codex')),
    chatJobService: { hasRunningJobs: () => true },
    terminalLauncher: async (...args) => {
      launches.push(args)
      return { started: true, launchMode: 'terminal' }
    },
  })
  const busy = await fetch(`${busyBaseUrl}/api/providers/codex/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: true }),
  })
  const busyPayload = await busy.json()
  assert.equal(busy.status, 409)
  assert.equal(busyPayload.code, 'provider_update_busy')
  assert.deepEqual(launches, [])
})

test('provider update route uses each provider-owned command instead of caller arguments', async (context) => {
  const statuses = statusService(providerStatus('auggie'))
  const baseUrl = await startTestHost(context, { statusService: statuses })
  const response = await fetch(`${baseUrl}/api/providers/auggie/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: false, args: ['login'], executable: '/tmp/not-auggie' }),
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.command.executable, providerStatus('auggie').executable)
  assert.deepEqual(payload.command.args, ['upgrade'])
})

test('provider update launch intent must be explicit and legacy direct runs also block updates', async (context) => {
  const statuses = statusService(providerStatus('codex'))
  const baseUrl = await startTestHost(context, {
    statusService: statuses,
    chatService: {
      hasRunningRuns: () => true,
      run: async () => { throw new Error('not used') },
      steer: async () => { throw new Error('not used') },
    },
  })

  const invalid = await fetch(`${baseUrl}/api/providers/codex/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).code, 'invalid_provider_update_request')

  const busy = await fetch(`${baseUrl}/api/providers/codex/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: true }),
  })
  assert.equal(busy.status, 409)
  assert.equal((await busy.json()).code, 'provider_update_busy')
})

test('automatic provider updates require launch, deduplicate native windows, and keep fixed commands', async (context) => {
  const statuses = statusService(providerStatus('codex'))
  const launches = []
  const baseUrl = await startTestHost(context, {
    statusService: statuses,
    terminalLauncher: async (executable, args) => {
      launches.push({ executable, args })
      return { started: true, launchMode: 'terminal' }
    },
  })

  const invalid = await fetch(`${baseUrl}/api/providers/codex/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: false, trigger: 'automatic' }),
  })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).code, 'invalid_provider_update_request')

  const first = await fetch(`${baseUrl}/api/providers/codex/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: true, trigger: 'automatic', args: ['login'] }),
  })
  assert.equal(first.status, 200)
  assert.equal((await first.json()).started, true)

  const duplicate = await fetch(`${baseUrl}/api/providers/codex/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: true, trigger: 'automatic' }),
  })
  const duplicatePayload = await duplicate.json()
  assert.equal(duplicate.status, 200)
  assert.equal(duplicatePayload.started, false)
  assert.equal(duplicatePayload.deduplicated, true)
  assert.deepEqual(launches, [{ executable: providerStatus('codex').executable, args: ['update'] }])
})
