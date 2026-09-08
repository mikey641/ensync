import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DaemonLeaseService } from './daemon-lifecycle.mjs'
import { getMcpProviderConfig, listMcpProviderConfigs } from './mcp-provider-config.mjs'
import {
  MCP_SECRET_MASK,
  McpRegistryError,
  McpRegistryService,
  normalizeMcpServerInput,
  parseMcpServersJson,
  publicMcpServer,
  readMcpRegistry,
} from './mcp-registry.mjs'
import { createEnsyncHost } from './server.mjs'

const NOW = '2026-09-06T10:00:00.000Z'

function statusService(installed) {
  return {
    list: async () => listMcpProviderConfigs().map((config) => ({
      id: config.id,
      name: config.name,
      installed: installed.includes(config.id),
    })),
  }
}

const CATALOG = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'cursor', name: 'Cursor Agent' },
  { id: 'amp', name: 'Amp' },
  { id: 'gitlab_duo', name: 'GitLab Duo CLI' },
  { id: 'jules', name: 'Google Jules' },
]

async function registry(context, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-mcp-registry-'))
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  const busy = { value: false }
  const service = new McpRegistryService({
    registryPath: join(directory, 'registry.json'),
    home,
    env: {},
    platform: 'darwin',
    statusService: statusService(['claude', 'codex', 'cursor', 'amp']),
    catalog: CATALOG,
    isBusy: () => busy.value,
    now: () => NOW,
    retryDelayMs: 20,
    ...overrides,
  })
  context.after(async () => {
    service.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { service, directory, home, busy }
}

const github = {
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: 'ghp_secret' },
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function providerReport(snapshot, id) {
  return snapshot.providers.find((provider) => provider.id === id)
}

test('normalizeMcpServerInput validates names, commands, and URLs', () => {
  assert.throws(() => normalizeMcpServerInput({ name: 'my server', command: 'x' }), McpRegistryError)
  assert.throws(() => normalizeMcpServerInput({ name: 'a.b', command: 'x' }), McpRegistryError)
  assert.throws(() => normalizeMcpServerInput({ name: 'ok', transport: 'stdio' }), McpRegistryError)
  assert.throws(() => normalizeMcpServerInput({ name: 'ok', transport: 'http', url: 'ftp://x' }), McpRegistryError)
  assert.throws(() => normalizeMcpServerInput({ name: 'ok', transport: 'ws', url: 'https://x' }), McpRegistryError)
  assert.throws(() => normalizeMcpServerInput({ name: 'ok', command: 'x', env: { 'BAD KEY': 'v' } }), McpRegistryError)
  assert.throws(() => normalizeMcpServerInput({ name: 'ok', command: 'x', env: { KEY: MCP_SECRET_MASK } }), McpRegistryError)

  const stdio = normalizeMcpServerInput({ name: ' github ', command: ' npx ', args: ['-y'], env: { TOKEN: 'a' } })
  assert.deepEqual(stdio, {
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y'],
    env: { TOKEN: 'a' },
    url: null,
    headers: {},
    enabled: true,
  })

  const inferredHttp = normalizeMcpServerInput({ name: 'linear', url: 'https://mcp.linear.app/mcp' })
  assert.equal(inferredHttp.transport, 'http')
  const copilotLocal = normalizeMcpServerInput({ name: 'x', type: 'local', command: 'x' })
  assert.equal(copilotLocal.transport, 'stdio')
  const sse = normalizeMcpServerInput({ name: 'x', type: 'sse', url: 'https://x/sse', headers: { Authorization: 'Bearer t' } })
  assert.equal(sse.transport, 'sse')
  assert.deepEqual(sse.headers, { Authorization: 'Bearer t' })
})

test('masked secrets are retained on edit and never leave the Host', () => {
  const existing = normalizeMcpServerInput({ name: 'x', command: 'x', env: { TOKEN: 'real' } })
  const updated = normalizeMcpServerInput({ name: 'x', command: 'y', env: { TOKEN: MCP_SECRET_MASK, OTHER: 'new' } }, existing)
  assert.deepEqual(updated.env, { TOKEN: 'real', OTHER: 'new' })

  const visible = publicMcpServer({ id: 'mcp_1', ...updated, createdAt: NOW, updatedAt: NOW })
  assert.deepEqual(visible.env, { TOKEN: MCP_SECRET_MASK, OTHER: MCP_SECRET_MASK })
  assert.equal(visible.command, 'y')
})

test('parseMcpServersJson understands README snippets from several providers', () => {
  const servers = parseMcpServersJson(JSON.stringify({
    mcpServers: {
      github: { command: 'npx', args: ['-y', 'x'], env: { T: '1' } },
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer 1' } },
      legacy: { type: 'sse', url: 'https://x/sse', disabled: true },
      copilot: { type: 'local', command: 'node', tools: ['*'] },
    },
  }))
  assert.deepEqual(servers.map((server) => [server.name, server.transport, server.enabled]), [
    ['github', 'stdio', true],
    ['linear', 'http', true],
    ['legacy', 'sse', false],
    ['copilot', 'stdio', true],
  ])
  assert.throws(() => parseMcpServersJson('{"command": "npx"}'), /Wrap the definition/)
  assert.throws(() => parseMcpServersJson('{"mcpServers": {}}'), McpRegistryError)
  assert.throws(() => parseMcpServersJson('nope'), McpRegistryError)
})

test('adding a server writes every installed supported provider in its own format', async (context) => {
  const { service, home } = await registry(context)
  await writeFile(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { id: 'me' }, projects: { '/p': { allowedTools: [] } } }))
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex', 'config.toml'), '# mine\nmodel = "gpt-5"\n')

  const snapshot = await service.add(github)

  assert.equal(snapshot.servers.length, 1)
  assert.equal(snapshot.servers[0].name, 'github')
  assert.deepEqual(snapshot.servers[0].env, { GITHUB_TOKEN: MCP_SECRET_MASK })

  const claude = await json(join(home, '.claude.json'))
  assert.deepEqual(claude.oauthAccount, { id: 'me' })
  assert.deepEqual(claude.projects, { '/p': { allowedTools: [] } })
  assert.deepEqual(claude.mcpServers.github, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: 'ghp_secret' },
  })

  const codex = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
  assert.equal(codex, [
    '# mine',
    'model = "gpt-5"',
    '',
    '[mcp_servers.github]',
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-github"]',
    '',
    '[mcp_servers.github.env]',
    'GITHUB_TOKEN = "ghp_secret"',
    '',
  ].join('\n'))

  const cursor = await json(join(home, '.cursor', 'mcp.json'))
  assert.deepEqual(cursor, {
    mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'ghp_secret' } } },
  })

  const amp = await json(join(home, '.config', 'amp', 'settings.json'))
  assert.deepEqual(Object.keys(amp), ['amp.mcpServers'])
  assert.deepEqual(Object.keys(amp['amp.mcpServers']), ['github'])

  for (const id of ['claude', 'codex', 'cursor', 'amp']) {
    const report = providerReport(snapshot, id)
    assert.equal(report.state, 'synced', id)
    assert.deepEqual(report.managedNames, ['github'], id)
    assert.equal(report.installed, true, id)
  }
  const duo = providerReport(snapshot, 'gitlab_duo')
  assert.equal(duo.state, 'skipped')
  assert.match(duo.reason, /not installed/)
  const jules = providerReport(snapshot, 'jules')
  assert.equal(jules.state, 'unavailable')
  assert.equal(jules.capability, 'unavailable')
  assert.equal(snapshot.lastSyncAt, NOW)
})

test('a provider-owned server with the same name is reported as a conflict and left alone', async (context) => {
  const { service, home } = await registry(context)
  await mkdir(join(home, '.cursor'), { recursive: true })
  await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'my-own' } } }))

  const snapshot = await service.add(github)
  const cursor = await json(join(home, '.cursor', 'mcp.json'))
  assert.deepEqual(cursor.mcpServers.github, { command: 'my-own' })
  const report = providerReport(snapshot, 'cursor')
  assert.equal(report.state, 'synced')
  assert.deepEqual(report.conflicts, ['github'])
  assert.deepEqual(report.managedNames, [])
  assert.match(report.reason, /already defines "github"/)
  assert.equal(providerReport(snapshot, 'claude').conflicts.length, 0)
})

test('editing, disabling, and removing keep every provider in step without touching other keys', async (context) => {
  const { service, home } = await registry(context)
  await writeFile(join(home, '.claude.json'), JSON.stringify({ theme: 'dark', mcpServers: { mine: { command: 'user' } } }))
  const added = await service.add(github)
  const id = added.servers[0].id

  await service.update(id, { ...github, command: 'node', env: { GITHUB_TOKEN: MCP_SECRET_MASK, EXTRA: 'v' } })
  let claude = await json(join(home, '.claude.json'))
  assert.equal(claude.theme, 'dark')
  assert.deepEqual(claude.mcpServers.mine, { command: 'user' })
  assert.equal(claude.mcpServers.github.command, 'node')
  assert.deepEqual(claude.mcpServers.github.env, { GITHUB_TOKEN: 'ghp_secret', EXTRA: 'v' })

  const disabled = await service.setEnabled(id, false)
  assert.equal(disabled.servers[0].enabled, false)
  claude = await json(join(home, '.claude.json'))
  assert.equal(claude.mcpServers.github, undefined)
  assert.deepEqual(claude.mcpServers.mine, { command: 'user' })
  assert.match(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), /^\s*$/)
  assert.deepEqual(providerReport(disabled, 'claude').managedNames, [])

  await service.setEnabled(id, true)
  claude = await json(join(home, '.claude.json'))
  assert.equal(claude.mcpServers.github.command, 'node')

  const removed = await service.remove(id)
  assert.deepEqual(removed.servers, [])
  claude = await json(join(home, '.claude.json'))
  assert.deepEqual(claude, { theme: 'dark', mcpServers: { mine: { command: 'user' } } })
  assert.deepEqual((await json(join(home, '.cursor', 'mcp.json'))).mcpServers, {})
})

test('transports a provider cannot express are skipped for that provider only', async (context) => {
  const { service, home } = await registry(context)
  const snapshot = await service.add({ name: 'events', transport: 'sse', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer t' } })

  const claude = await json(join(home, '.claude.json'))
  assert.deepEqual(claude.mcpServers.events, { type: 'sse', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer t' } })
  const codex = providerReport(snapshot, 'codex')
  assert.deepEqual(codex.managedNames, [])
  assert.deepEqual(codex.skipped, [{ name: 'events', reason: 'SSE transport is not supported; use streamable HTTP.' }])
  assert.match(codex.reason, /1 not supported by Codex/)
  const cursor = await json(join(home, '.cursor', 'mcp.json'))
  assert.deepEqual(cursor.mcpServers.events, { url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer t' } })
})

test('remote servers are serialized per provider schema', async (context) => {
  const { service, home } = await registry(context, {
    statusService: statusService(['claude', 'codex', 'gitlab_duo']),
  })
  const snapshot = await service.add({ name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer t' } })

  const codex = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
  assert.equal(codex, '[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n\n[mcp_servers.linear.http_headers]\nAuthorization = "Bearer t"\n')
  const duo = providerReport(snapshot, 'gitlab_duo')
  assert.deepEqual(duo.skipped, [{ name: 'linear', reason: 'Custom headers are not supported for remote servers.' }])
  assert.equal(duo.configPath, join(home, '.gitlab', 'duo', 'mcp.json'))

  await service.add({ name: 'docs', transport: 'http', url: 'https://docs.example.com/mcp' })
  const duoFile = await json(join(home, '.gitlab', 'duo', 'mcp.json'))
  assert.deepEqual(duoFile.mcpServers, { docs: { type: 'http', url: 'https://docs.example.com/mcp' } })
})

test('provider files are not edited while agent runs are active, then catch up', async (context) => {
  const { service, home, busy } = await registry(context)
  busy.value = true
  const deferred = await service.add(github)
  assert.equal(deferred.syncPending, true)
  assert.equal(providerReport(deferred, 'claude').state, 'deferred')
  await assert.rejects(readFile(join(home, '.claude.json')), { code: 'ENOENT' })

  busy.value = false
  await new Promise((resolve) => setTimeout(resolve, 80))
  const settled = await service.snapshot()
  assert.equal(settled.syncPending, false)
  assert.equal(providerReport(settled, 'claude').state, 'synced')
  assert.equal((await json(join(home, '.claude.json'))).mcpServers.github.command, 'npx')
})

test('an unparsable provider file is reported and left untouched', async (context) => {
  const { service, home } = await registry(context)
  await mkdir(join(home, '.cursor'), { recursive: true })
  await writeFile(join(home, '.cursor', 'mcp.json'), '{ not json')

  const snapshot = await service.add(github)
  const cursor = providerReport(snapshot, 'cursor')
  assert.equal(cursor.state, 'error')
  assert.match(cursor.reason, /not valid JSON/)
  assert.match(cursor.reason, /not modified/)
  assert.equal(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8'), '{ not json')
  assert.equal(providerReport(snapshot, 'claude').state, 'synced')
})

test('registry rejects duplicates and unknown ids, and survives a restart', async (context) => {
  const { service, directory, home } = await registry(context)
  await service.add(github)
  await assert.rejects(service.add({ ...github, name: 'GitHub' }), { code: 'mcp_server_duplicate' })
  await assert.rejects(service.remove('mcp_missing'), { code: 'mcp_server_not_found' })

  const reopened = new McpRegistryService({
    registryPath: join(directory, 'registry.json'),
    home,
    env: {},
    platform: 'darwin',
    statusService: statusService(['claude']),
    catalog: CATALOG,
    now: () => NOW,
  })
  context.after(() => reopened.close())
  const snapshot = await reopened.snapshot()
  assert.equal(snapshot.servers[0].name, 'github')
  assert.deepEqual(providerReport(snapshot, 'claude').managedNames, ['github'])

  const stored = await readMcpRegistry(join(directory, 'registry.json'))
  assert.equal(stored.readable, true)
  assert.equal(stored.state.servers[0].env.GITHUB_TOKEN, 'ghp_secret')
})

test('a corrupt registry file is surfaced and refuses writes instead of being overwritten', async (context) => {
  const { service, directory } = await registry(context)
  await writeFile(join(directory, 'registry.json'), '{ broken')
  const snapshot = await service.snapshot()
  assert.equal(snapshot.readable, false)
  assert.deepEqual(snapshot.servers, [])
  await assert.rejects(service.add(github), { code: 'mcp_registry_unreadable' })
  assert.equal(await readFile(join(directory, 'registry.json'), 'utf8'), '{ broken')
})

test('startup sync does nothing when nothing is managed', async (context) => {
  const { service, home } = await registry(context)
  assert.equal(await service.startupSync(), null)
  await assert.rejects(readFile(join(home, '.claude.json')), { code: 'ENOENT' })
})

test('every catalog provider has an explicit MCP capability with a reason', () => {
  const ids = [
    'codex', 'claude', 'copilot', 'cursor', 'antigravity', 'jules',
    'kimi', 'kiro', 'junie', 'gitlab_duo', 'oz', 'droid', 'amp',
    'auggie', 'qoder', 'codebuddy', 'ollama',
  ]
  for (const id of ids) {
    const config = getMcpProviderConfig(id)
    assert.ok(config, `${id} must have an MCP entry`)
    assert.ok(['supported', 'unavailable'].includes(config.sync), id)
    assert.ok(config.reason.length > 20, id)
    if (config.sync === 'supported') {
      assert.equal(typeof config.merge, 'function', id)
      assert.equal(typeof config.read, 'function', `${id} must define a discovery reader`)
    } else {
      assert.equal(config.merge, null, id)
    }
  }
})

test('CodeBuddy writes to the first existing user file so nothing is shadowed', async (context) => {
  const { home } = await registry(context)
  const config = getMcpProviderConfig('codebuddy')
  assert.equal(await config.configPath({}, home), join(home, '.codebuddy', '.mcp.json'))
  await writeFile(join(home, '.codebuddy.json'), '{}')
  assert.equal(await config.configPath({}, home), join(home, '.codebuddy.json'))
  await mkdir(join(home, '.codebuddy'), { recursive: true })
  await writeFile(join(home, '.codebuddy', 'mcp.json'), '{}')
  assert.equal(await config.configPath({}, home), join(home, '.codebuddy', 'mcp.json'))
})

test('platform-specific paths resolve from the environment', () => {
  assert.equal(getMcpProviderConfig('gitlab_duo').configPath({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me', 'win32'), join('C:\\Users\\me\\AppData\\Roaming', 'GitLab', 'duo', 'mcp.json'))
  assert.equal(getMcpProviderConfig('codex').configPath({ CODEX_HOME: '/opt/codex' }, '/home/me'), join('/opt/codex', 'config.toml'))
  assert.equal(getMcpProviderConfig('amp').configPath({ AMP_SETTINGS_FILE: '/x/settings.json' }, '/home/me'), '/x/settings.json')
  assert.equal(getMcpProviderConfig('antigravity').configPath({}, '/home/me'), join('/home/me', '.gemini', 'config', 'mcp_config.json'))
})

// --- HTTP surface -----------------------------------------------------------

const TOKEN = 'c'.repeat(64)
const OWNER = 'shell_2222222222222222'

async function mcpHost(context) {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-mcp-api-'))
  const home = join(directory, 'home')
  await mkdir(home, { recursive: true })
  const leases = new DaemonLeaseService()
  const statuses = statusService(['claude'])
  const service = new McpRegistryService({
    registryPath: join(directory, 'registry.json'),
    home,
    env: {},
    platform: 'darwin',
    statusService: statuses,
    catalog: CATALOG,
    now: () => NOW,
  })
  const server = createEnsyncHost({
    authToken: TOKEN,
    daemonLeaseService: leases,
    statusService: statuses,
    mcpRegistryService: service,
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(async () => {
    service.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  leases.claim(OWNER)
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const call = (path, init = {}) => fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'X-Ensync-Owner': OWNER,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  return { baseUrl, call, home }
}

test('autoAdopt imports Claude and Codex servers into the registry and fans them out idempotently', async (context) => {
  const { service, home } = await registry(context)
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { id: 'me' },
    mcpServers: {
      'mcp-gsuite': { type: 'stdio', command: 'gsuite-mcp', args: ['serve'], env: { CLIENT_ID: 'abc' } },
    },
  }))
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex', 'config.toml'), [
    'model = "gpt-5"',
    '',
    '[mcp_servers.openaiDeveloperDocs]',
    'url = "https://developers.openai.com/mcp"',
    '',
  ].join('\n'))

  const first = await service.autoAdopt()

  assert.deepEqual(first.adopted.sort(), ['mcp-gsuite', 'openaiDeveloperDocs'])
  assert.deepEqual(first.servers.map((server) => server.name).sort(), ['mcp-gsuite', 'openaiDeveloperDocs'])
  const gsuite = first.servers.find((server) => server.name === 'mcp-gsuite')
  assert.equal(gsuite.adoptedFrom, 'claude')
  assert.deepEqual(gsuite.env, { CLIENT_ID: MCP_SECRET_MASK })
  const docs = first.servers.find((server) => server.name === 'openaiDeveloperDocs')
  assert.equal(docs.adoptedFrom, 'codex')

  // The managed registry now mirrors into the other installed providers.
  const cursor = await json(join(home, '.cursor', 'mcp.json'))
  assert.deepEqual(Object.keys(cursor.mcpServers).sort(), ['mcp-gsuite', 'openaiDeveloperDocs'])
  const amp = await json(join(home, '.config', 'amp', 'settings.json'))
  assert.deepEqual(Object.keys(amp['amp.mcpServers']).sort(), ['mcp-gsuite', 'openaiDeveloperDocs'])

  // The source provider already defines its own adopted names, so those are
  // satisfied in place rather than reported as conflicts.
  assert.deepEqual(providerReport(first, 'claude').conflicts, [])
  assert.deepEqual(providerReport(first, 'codex').conflicts, [])

  // The source files are untouched, and a second scan adopts nothing new.
  assert.deepEqual((await json(join(home, '.claude.json'))).mcpServers['mcp-gsuite'].env, { CLIENT_ID: 'abc' })
  const codex = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
  assert.ok(codex.includes('url = "https://developers.openai.com/mcp"'))

  const second = await service.autoAdopt()
  assert.deepEqual(second.adopted, [])
  assert.equal(second.servers.length, 2)
})

test('autoAdopt remembers a removal so the server is not re-adopted', async (context) => {
  const { service, home } = await registry(context)
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'mcp-gsuite': { type: 'stdio', command: 'gsuite-mcp', args: [] } },
  }))

  const first = await service.autoAdopt()
  assert.deepEqual(first.adopted, ['mcp-gsuite'])
  const id = first.servers[0].id

  await service.remove(id)
  const scan = await service.autoAdopt()
  assert.deepEqual(scan.adopted, [])
  assert.deepEqual(scan.servers, [])
})

test('autoAdopt discovers servers from every supported provider file it finds', async (context) => {
  const { service, home } = await registry(context)
  await mkdir(join(home, '.cursor'), { recursive: true })
  await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { cursorDb: { type: 'http', url: 'https://cursor.example/mcp' } },
  }))
  await mkdir(join(home, '.factory'), { recursive: true })
  await writeFile(join(home, '.factory', 'mcp.json'), JSON.stringify({
    mcpServers: { droidTools: { type: 'stdio', command: 'droid-mcp', args: [] } },
  }))

  const result = await service.autoAdopt()

  assert.deepEqual(result.adopted.sort(), ['cursorDb', 'droidTools'])
  assert.deepEqual(result.servers.map((server) => server.name).sort(), ['cursorDb', 'droidTools'])
  assert.equal(result.servers.find((server) => server.name === 'cursorDb').adoptedFrom, 'cursor')
  assert.equal(result.servers.find((server) => server.name === 'droidTools').adoptedFrom, 'droid')
})

test('an adopted server is satisfied in its source provider even after it diverges in the registry', async (context) => {
  const { service, home } = await registry(context)
  await mkdir(join(home, '.codex'), { recursive: true })
  await writeFile(join(home, '.codex', 'config.toml'), [
    '[mcp_servers.computer-use]',
    'command = "./Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient"',
    'args = ["mcp"]',
    'cwd = "."',
    '',
  ].join('\n'))

  const first = await service.autoAdopt()
  assert.deepEqual(first.adopted, ['computer-use'])
  const id = first.servers[0].id

  // The registry copy diverges from Codex's own entry, but Codex is the source,
  // so its provider-owned definition still satisfies Ensync and is preserved.
  const updated = await service.update(id, {
    name: 'computer-use',
    transport: 'stdio',
    command: '/absolute/SkyComputerUseClient',
    args: ['mcp'],
    env: {},
  })
  assert.deepEqual(providerReport(updated, 'codex').conflicts, [])
  const content = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
  assert.ok(content.includes('command = "./Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient"'))
  assert.ok(content.includes('cwd = "."'))
})

test('a provider entry that already matches the registry is satisfied, not a conflict', async (context) => {
  const { service, home } = await registry(context, {
    catalog: [...CATALOG, { id: 'junie', name: 'Junie CLI' }],
    statusService: statusService(['claude', 'codex', 'cursor', 'amp', 'junie']),
  })
  await writeFile(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { 'mcp-gsuite': { type: 'stdio', command: 'gsuite-mcp', args: ['serve'] } },
  }))
  await mkdir(join(home, '.junie', 'mcp'), { recursive: true })
  await writeFile(join(home, '.junie', 'mcp', 'mcp.json'), JSON.stringify({
    mcpServers: { 'mcp-gsuite': { type: 'stdio', command: 'gsuite-mcp', args: ['serve'] } },
  }))

  const result = await service.autoAdopt()
  assert.deepEqual(result.adopted, ['mcp-gsuite'])

  const junie = providerReport(result, 'junie')
  assert.equal(junie.state, 'synced')
  assert.deepEqual(junie.conflicts, [])
  assert.deepEqual(junie.managedNames, [])
  assert.match(junie.reason, /already has a matching "mcp-gsuite"/)

  const claude = providerReport(result, 'claude')
  assert.deepEqual(claude.conflicts, [])
})

test('a provider entry that differs under the same name is still a real conflict', async (context) => {
  const { service, home } = await registry(context)
  await mkdir(join(home, '.cursor'), { recursive: true })
  await writeFile(join(home, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { github: { type: 'http', url: 'https://mine.example/mcp' } },
  }))

  const snapshot = await service.add(github)

  const cursor = providerReport(snapshot, 'cursor')
  assert.equal(cursor.state, 'synced')
  assert.deepEqual(cursor.conflicts, ['github'])
  assert.deepEqual(cursor.managedNames, [])
  assert.match(cursor.reason, /already defines "github"/)
})

test('MCP routes add, import, toggle, edit, sync, and remove behind the native-shell lease', async (context) => {
  const { baseUrl, call, home } = await mcpHost(context)

  const unleased = await fetch(`${baseUrl}/api/mcp/servers`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  assert.equal(unleased.status, 403)

  const empty = await call('/api/mcp/servers')
  assert.equal(empty.status, 200)
  assert.deepEqual((await empty.json()).servers, [])

  const invalid = await call('/api/mcp/servers', { method: 'POST', body: JSON.stringify({ server: { name: 'bad name', command: 'x' } }) })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).code, 'mcp_server_invalid')

  const created = await call('/api/mcp/servers', { method: 'POST', body: JSON.stringify({ server: github }) })
  assert.equal(created.status, 201)
  const createdBody = await created.json()
  const id = createdBody.servers[0].id
  assert.deepEqual(createdBody.servers[0].env, { GITHUB_TOKEN: MCP_SECRET_MASK })
  assert.equal(providerReport(createdBody, 'claude').state, 'synced')
  assert.equal((await json(join(home, '.claude.json'))).mcpServers.github.env.GITHUB_TOKEN, 'ghp_secret')

  const imported = await call('/api/mcp/servers/import', {
    method: 'POST',
    body: JSON.stringify({ json: JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } }) }),
  })
  assert.equal(imported.status, 201)
  const importedBody = await imported.json()
  assert.deepEqual(importedBody.imported, ['linear'])
  assert.equal(importedBody.servers.length, 2)

  const duplicate = await call('/api/mcp/servers', { method: 'POST', body: JSON.stringify({ server: github }) })
  assert.equal(duplicate.status, 409)

  const toggled = await call(`/api/mcp/servers/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) })
  assert.equal(toggled.status, 200)
  assert.equal((await toggled.json()).servers.find((server) => server.id === id).enabled, false)
  assert.equal((await json(join(home, '.claude.json'))).mcpServers.github, undefined)

  const edited = await call(`/api/mcp/servers/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ server: { ...github, enabled: true, env: { GITHUB_TOKEN: MCP_SECRET_MASK } } }),
  })
  assert.equal(edited.status, 200)
  assert.equal((await json(join(home, '.claude.json'))).mcpServers.github.env.GITHUB_TOKEN, 'ghp_secret')

  const synced = await call('/api/mcp/sync', { method: 'POST' })
  assert.equal(synced.status, 200)
  assert.equal((await synced.json()).lastSyncAt, NOW)

  const missing = await call('/api/mcp/servers/mcp_nope', { method: 'DELETE' })
  assert.equal(missing.status, 404)

  const removed = await call(`/api/mcp/servers/${id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  const removedBody = await removed.json()
  assert.deepEqual(removedBody.servers.map((server) => server.name), ['linear'])
  const claude = await json(join(home, '.claude.json'))
  assert.deepEqual(Object.keys(claude.mcpServers), ['linear'])
})
