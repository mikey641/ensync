import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AgentConnectorService } from './agent-connector.mjs'
import { DaemonLeaseService } from './daemon-lifecycle.mjs'
import { createEnsyncHost } from './server.mjs'

const TOKEN = 'c'.repeat(64)
const OWNER = 'shell_2222222222222222'
const PROJECT = '/tmp/ensync-connector-api'

function readyProvider(id, name, usedPercent) {
  return {
    id,
    name,
    installed: true,
    executable: `/usr/local/bin/${id}`,
    routeKind: 'subscription',
    connectionState: 'ready',
    chatExecution: 'supported',
    authentication: { state: 'authenticated', reason: 'Signed in.' },
    usage: { usedPercent, plan: 'Pro', model: null, reason: 'Verified.' },
  }
}

async function connectorHost(context) {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-connector-api-'))
  const leases = new DaemonLeaseService()
  const server = createEnsyncHost({
    authToken: TOKEN,
    daemonLeaseService: leases,
    statusService: {
      list: async () => [readyProvider('codex', 'Codex', 100), readyProvider('claude', 'Claude Code', 12)],
    },
    agentConnectorService: new AgentConnectorService({
      preferencesPath: join(directory, 'connector.json'),
      statusService: {
        list: async () => [readyProvider('codex', 'Codex', 100), readyProvider('claude', 'Claude Code', 12)],
      },
      now: () => '2026-08-18T09:00:00.000Z',
    }),
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, leases }
}

test('a bot with no window can read routing, because it can hold no native-shell lease', async (context) => {
  const { baseUrl } = await connectorHost(context)

  // The lease gate still guards everything that acts on this machine.
  assert.equal((await fetch(`${baseUrl}/api/providers`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).status, 403)

  const plan = await fetch(
    `${baseUrl}/api/agent-connector/plan?cwd=${encodeURIComponent(PROJECT)}&tools=workspace-write&size=medium`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  )
  assert.equal(plan.status, 200)
  const payload = await plan.json()
  assert.deepEqual(payload.sequence.map((entry) => entry.id), ['claude'])
  assert.equal(payload.effort, 'medium')
  assert.match(payload.skipped.find((entry) => entry.id === 'codex').reason, /100%/)

  // ...but not without the Host token.
  assert.equal((await fetch(`${baseUrl}/api/agent-connector/plan?cwd=${encodeURIComponent(PROJECT)}`)).status, 401)
})

test('reordering routing needs the app; a bot may only read the result', async (context) => {
  const { baseUrl, leases } = await connectorHost(context)

  const unleased = await fetch(`${baseUrl}/api/agent-connector/preferences`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: ['claude', 'codex'] }),
  })
  assert.equal(unleased.status, 403)

  leases.claim(OWNER)
  const saved = await fetch(`${baseUrl}/api/agent-connector/preferences`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Ensync-Owner': OWNER, 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: ['claude', 'codex'] }),
  })
  assert.equal(saved.status, 200)
  assert.deepEqual((await saved.json()).order, ['claude', 'codex', 'droid'])

  const read = await fetch(`${baseUrl}/api/agent-connector/preferences`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  assert.deepEqual((await read.json()).order, ['claude', 'codex', 'droid'])
})

test('invalid connector requests are refused with their reason, not a 500', async (context) => {
  const { baseUrl } = await connectorHost(context)
  const relative = await fetch(`${baseUrl}/api/agent-connector/plan?cwd=relative`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(relative.status, 400)
  assert.equal((await relative.json()).code, 'connector_cwd_invalid')

  const level = await fetch(`${baseUrl}/api/agent-connector/plan?cwd=${encodeURIComponent(PROJECT)}&tools=root`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(level.status, 400)
  assert.equal((await level.json()).code, 'connector_tool_level_invalid')
})
