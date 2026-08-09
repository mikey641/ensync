import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createEnsyncHost } from './server.mjs'
import { getInstallCommand, hasInstallCommand } from './provider-install.mjs'
import { probeMcpConfig } from './provider-mcp.mjs'

function providerStatus(id, overrides = {}) {
  return {
    id,
    name: id === 'codex' ? 'Codex' : id.charAt(0).toUpperCase() + id.slice(1),
    installed: true,
    executable: process.platform === 'win32' ? `C:\\Tools\\${id}.cmd` : `/opt/tools/${id}`,
    version: `${id} 1.2.3`,
    updateReason: 'Use the official installation and update guide.',
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

test('install command data exists for every catalog provider', () => {
  const allIds = [
    'codex', 'claude', 'copilot', 'cursor', 'antigravity', 'jules',
    'kimi', 'kiro', 'junie', 'gitlab_duo', 'oz', 'droid', 'amp',
    'auggie', 'qoder', 'codebuddy', 'ollama',
  ]
  for (const id of allIds) {
    assert.equal(hasInstallCommand(id), true, `${id} should have an install command`)
    const cmd = getInstallCommand(id)
    assert.ok(cmd, `${id} install command should not be null`)
    assert.ok(typeof cmd.command === 'string' && cmd.command.length > 0, `${id} install command should be a non-empty string`)
    assert.ok(typeof cmd.source === 'string' && cmd.source.startsWith('http'), `${id} install source should be a URL`)
  }
})

test('install preview returns the official curl command without launching', async (context) => {
  const statuses = statusService(providerStatus('codex'))
  let launchCalls = 0
  const baseUrl = await startTestHost(context, {
    statusService: statuses,
    terminalLauncher: async () => {
      launchCalls += 1
      return { started: true, launchMode: 'terminal' }
    },
  })

  const response = await fetch(`${baseUrl}/api/providers/codex/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: false }),
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.started, false)
  assert.equal(payload.launchMode, 'manual')
  assert.ok(payload.command.command.includes('curl'))
  assert.ok(payload.command.source.includes('github.com/openai/codex'))
  assert.equal(launchCalls, 0)
  assert.equal(statuses.invalidations, 0)
})

test('install launch opens a terminal and invalidates cached status', async (context) => {
  const statuses = statusService(providerStatus('claude'))
  const launches = []
  const baseUrl = await startTestHost(context, {
    statusService: statuses,
    terminalLauncher: async (executable, args) => {
      launches.push({ executable, args })
      return { started: true, launchMode: 'terminal' }
    },
  })

  const response = await fetch(`${baseUrl}/api/providers/claude/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: true }),
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.started, true)
  assert.equal(payload.launchMode, 'terminal')
  assert.ok(payload.command.command.includes('curl'))
  assert.ok(payload.command.command.includes('claude.ai'))
  assert.equal(launches.length, 1)
  assert.equal(statuses.invalidations, 1)
})

test('install refuses a provider without a verified curl command', async (context) => {
  const baseUrl = await startTestHost(context, {
    statusService: statusService(providerStatus('codex')),
    terminalLauncher: async () => ({ started: true, launchMode: 'terminal' }),
  })

  const response = await fetch(`${baseUrl}/api/providers/nonexistent/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: false }),
  })
  const payload = await response.json()

  assert.equal(response.status, 404)
  assert.match(payload.error, /Unknown provider/)
})

test('install requires an explicit launch boolean', async (context) => {
  const baseUrl = await startTestHost(context, {
    statusService: statusService(providerStatus('codex')),
    terminalLauncher: async () => ({ started: true, launchMode: 'terminal' }),
  })

  const response = await fetch(`${baseUrl}/api/providers/codex/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.equal(payload.code, 'invalid_provider_install_request')
})

test('install is refused while agent runs are active', async (context) => {
  const baseUrl = await startTestHost(context, {
    statusService: statusService(providerStatus('codex')),
    terminalLauncher: async () => ({ started: true, launchMode: 'terminal' }),
    chatJobService: { hasRunningJobs: () => true },
    chatService: {
      hasRunningRuns: () => true,
      run: async () => { throw new Error('not used') },
      steer: async () => { throw new Error('not used') },
    },
  })

  const response = await fetch(`${baseUrl}/api/providers/codex/install`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launch: true }),
  })
  const payload = await response.json()

  assert.equal(response.status, 409)
  assert.equal(payload.code, 'provider_install_busy')
})

test('MCP probe reports no config for providers without MCP support', async () => {
  const result = await probeMcpConfig('jules')
  assert.equal(result.configured, false)
  assert.equal(result.configPath, null)
  assert.equal(result.exists, false)
  assert.equal(result.serverCount, 0)
  assert.deepEqual(result.serverNames, [])
})

test('MCP probe reports no config for a missing config file', async () => {
  const result = await probeMcpConfig('cursor', {
    configPath: '/tmp/nonexistent-mcp-config-test.json',
  })
  assert.equal(result.configured, false)
  assert.equal(result.exists, false)
  assert.equal(result.serverCount, 0)
  assert.deepEqual(result.serverNames, [])
  assert.match(result.reason, /No MCP configuration file found/)
})

test('MCP probe parses JSON mcpServers and returns only server names', async () => {
  const tmpDir = `/tmp/ensync-mcp-test-${Date.now()}`
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  mkdirSync(tmpDir, { recursive: true })
  const configPath = join(tmpDir, 'mcp.json')
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      linear: { command: 'npx', args: ['linear-mcp'] },
      github: { command: 'npx', args: ['github-mcp'] },
    },
  }))
  try {
    const result = await probeMcpConfig('cursor', { configPath })
    assert.equal(result.configured, true)
    assert.equal(result.exists, true)
    assert.equal(result.serverCount, 2)
    assert.ok(result.serverNames.includes('linear'))
    assert.ok(result.serverNames.includes('github'))
  } finally {
    const { rmSync } = await import('node:fs')
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('MCP probe parses Codex TOML mcp_servers sections', async () => {
  const tmpDir = `/tmp/ensync-mcp-toml-test-${Date.now()}`
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  mkdirSync(tmpDir, { recursive: true })
  const configPath = join(tmpDir, 'config.toml')
  writeFileSync(configPath, `
[mcp_servers.node_repl]
command = "/usr/bin/node"

[mcp_servers.node_repl.env]
FOO = "bar"

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"
`)
  try {
    const result = await probeMcpConfig('codex', { configPath })
    assert.equal(result.configured, true)
    assert.equal(result.serverCount, 2)
    assert.ok(result.serverNames.includes('node_repl'))
    assert.ok(result.serverNames.includes('openaiDeveloperDocs'))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('MCP probe parses Claude global and per-project mcpServers', async () => {
  const tmpDir = `/tmp/ensync-mcp-claude-test-${Date.now()}`
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  mkdirSync(tmpDir, { recursive: true })
  const configPath = join(tmpDir, '.claude.json')
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      'mcp-gsuite': { command: 'npx', args: ['mcp-gsuite'] },
    },
    projects: {
      '/home/user/project-a': {
        mcpServers: { linear: { command: 'npx', args: ['linear-mcp'] } },
      },
      '/home/user/project-b': {
        mcpServers: {},
      },
    },
  }))
  try {
    const result = await probeMcpConfig('claude', { configPath })
    assert.equal(result.configured, true)
    assert.equal(result.serverCount, 1)
    assert.ok(result.serverNames.includes('mcp-gsuite'))
    assert.ok(result.projects)
    assert.ok(result.projects['/home/user/project-a'].includes('linear'))
    assert.ok(!result.projects['/home/user/project-b'])
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})
