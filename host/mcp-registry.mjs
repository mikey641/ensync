import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { userDataDirectory } from './agent-connector.mjs'
import { McpConfigParseError } from './mcp-config-writers.mjs'
import { getMcpProviderConfig, listMcpProviderConfigs } from './mcp-provider-config.mjs'

// One Host-owned list of MCP (Model Context Protocol) servers, mirrored into
// the native configuration of every installed catalog provider whose format is
// verified in `mcp-provider-config.mjs`.
//
// The registry is the source of truth for what Ensync manages. A sync ledger
// remembers, per provider, exactly which server names Ensync wrote into which
// file, so a later sync can rewrite or remove those names and nothing else.
// A same-named server the person configured through the provider itself is
// never overwritten; it is reported as a conflict instead.

export const MCP_REGISTRY_VERSION = 1
export const MCP_REGISTRY_FILENAME = 'ensync-mcp-servers-v1.json'
export const MCP_SECRET_MASK = '••••••••'
export const MCP_TRANSPORTS = Object.freeze(['stdio', 'http', 'sse'])
export const MAX_MCP_SERVERS = 64

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_KEY_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
const MAX_ARGS = 64
const MAX_TEXT = 4096
const MAX_MAP_ENTRIES = 64
const DEFAULT_RETRY_DELAY_MS = 15_000

// Provider files Ensync reads to adopt servers a person already configured in
// a CLI. Each source is read-only during adoption; the parsed entries are fed
// through `normalizeMcpServerInput` before they enter the managed registry.
// Discovery is derived from the same catalog used for sync, so every provider
// with a local MCP file is both read and written through one format map.
const MCP_PROVIDER_IDS = new Set(listMcpProviderConfigs().map((config) => config.id))
const MCP_DISCOVERY_SOURCES = Object.freeze(
  listMcpProviderConfigs()
    .filter((entry) => entry.sync === 'supported')
    .map((entry) => {
      const config = getMcpProviderConfig(entry.id)
      return typeof config?.read === 'function' ? { id: entry.id, parse: config.read } : null
    })
    .filter(Boolean),
)

export class McpRegistryError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'McpRegistryError'
    this.code = code
    this.status = status
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value, field, { required = false, allowNewlines = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new McpRegistryError('mcp_server_invalid', `${field} is required.`)
    return null
  }
  if (typeof value !== 'string') {
    throw new McpRegistryError('mcp_server_invalid', `${field} must be a string.`)
  }
  const text = allowNewlines ? value : value.trim()
  if (text.includes('\0')) {
    throw new McpRegistryError('mcp_server_invalid', `${field} contains a null byte.`)
  }
  if (!allowNewlines && /[\r\n]/.test(text)) {
    throw new McpRegistryError('mcp_server_invalid', `${field} cannot span multiple lines.`)
  }
  if (text.length > MAX_TEXT) {
    throw new McpRegistryError('mcp_server_invalid', `${field} is longer than ${MAX_TEXT} characters.`)
  }
  if (required && text === '') {
    throw new McpRegistryError('mcp_server_invalid', `${field} is required.`)
  }
  return text === '' ? null : text
}

function cleanMap(value, field, keyPattern, existing) {
  if (value === undefined || value === null) return {}
  if (!isPlainObject(value)) {
    throw new McpRegistryError('mcp_server_invalid', `${field} must be an object of string values.`)
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_MAP_ENTRIES) {
    throw new McpRegistryError('mcp_server_invalid', `${field} has more than ${MAX_MAP_ENTRIES} entries.`)
  }
  const result = {}
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim()
    if (!keyPattern.test(key)) {
      throw new McpRegistryError('mcp_server_invalid', `${field} key "${rawKey}" is not valid.`)
    }
    if (typeof rawValue !== 'string') {
      throw new McpRegistryError('mcp_server_invalid', `${field} value for "${key}" must be a string.`)
    }
    if (rawValue.includes('\0') || rawValue.length > MAX_TEXT) {
      throw new McpRegistryError('mcp_server_invalid', `${field} value for "${key}" is not valid.`)
    }
    if (rawValue === MCP_SECRET_MASK) {
      // The renderer only ever sees masked values; sending the mask back means
      // "keep what the Host already has".
      const retained = existing?.[key]
      if (typeof retained !== 'string') {
        throw new McpRegistryError('mcp_server_invalid', `Enter a value for ${field} "${key}".`)
      }
      result[key] = retained
    } else {
      result[key] = rawValue
    }
  }
  return result
}

function inferTransport(input) {
  if (typeof input.transport === 'string' && input.transport.trim() !== '') return input.transport.trim().toLowerCase()
  if (typeof input.type === 'string' && input.type.trim() !== '') {
    const type = input.type.trim().toLowerCase()
    if (type === 'local' || type === 'stdio') return 'stdio'
    if (type === 'streamable-http' || type === 'streamable_http' || type === 'http') return 'http'
    return type
  }
  if (typeof input.url === 'string' && input.url.trim() !== '') return 'http'
  return 'stdio'
}

/**
 * Validate one server definition into the canonical shape. `existing` is the
 * stored server when this is an edit, so masked secrets can be retained.
 */
export function normalizeMcpServerInput(input, existing = null) {
  if (!isPlainObject(input)) {
    throw new McpRegistryError('mcp_server_invalid', 'A server definition must be an object.')
  }
  const name = cleanText(input.name, 'Name', { required: true })
  if (!NAME_PATTERN.test(name)) {
    throw new McpRegistryError(
      'mcp_server_invalid',
      'Name must start with a letter or digit and contain only letters, digits, "-" or "_" (max 64 characters).',
    )
  }
  const transport = inferTransport(input)
  if (!MCP_TRANSPORTS.includes(transport)) {
    throw new McpRegistryError('mcp_server_invalid', `Transport must be one of ${MCP_TRANSPORTS.join(', ')}.`)
  }

  const server = {
    name,
    transport,
    command: null,
    args: [],
    env: {},
    url: null,
    headers: {},
    enabled: input.enabled === undefined ? (existing?.enabled ?? true) : input.enabled === true,
  }

  if (transport === 'stdio') {
    server.command = cleanText(input.command, 'Command', { required: true })
    const args = input.args === undefined || input.args === null ? [] : input.args
    if (!Array.isArray(args)) {
      throw new McpRegistryError('mcp_server_invalid', 'Arguments must be a list of strings.')
    }
    if (args.length > MAX_ARGS) {
      throw new McpRegistryError('mcp_server_invalid', `More than ${MAX_ARGS} arguments is not supported.`)
    }
    server.args = args.map((arg, index) => {
      if (typeof arg !== 'string' || arg.includes('\0') || arg.length > MAX_TEXT) {
        throw new McpRegistryError('mcp_server_invalid', `Argument ${index + 1} is not valid.`)
      }
      return arg
    })
    server.env = cleanMap(input.env, 'Environment', ENV_KEY_PATTERN, existing?.env)
  } else {
    const url = cleanText(input.url, 'URL', { required: true })
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new McpRegistryError('mcp_server_invalid', 'URL must be an absolute http(s) URL.')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new McpRegistryError('mcp_server_invalid', 'URL must use http or https.')
    }
    server.url = url
    server.headers = cleanMap(input.headers, 'Headers', HEADER_KEY_PATTERN, existing?.headers)
  }

  return server
}

function sameStringMap(a, b) {
  const left = a ?? {}
  const right = b ?? {}
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => right[key] === left[key])
}

/** Compare the behavior-defining fields; provenance and timestamps are ignored. */
function sameMcpServer(a, b) {
  if (!a || !b) return false
  return a.name === b.name
    && a.transport === b.transport
    && (a.command ?? null) === (b.command ?? null)
    && (a.url ?? null) === (b.url ?? null)
    && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? [])
    && sameStringMap(a.env, b.env)
    && sameStringMap(a.headers, b.headers)
}

/**
 * Whether the provider's own `name` entry already matches the registry server,
 * using the same provider reader that adoption uses. This names a satisfied
 * copy (leave it untouched, no conflict), never a license to rewrite it.
 */
function providerEntrySatisfies(read, content, name, server) {
  if (typeof read !== 'function') return false
  let entries
  try {
    entries = read(content)
  } catch {
    return false
  }
  const match = (Array.isArray(entries) ? entries : []).find((entry) => (
    isPlainObject(entry) && typeof entry.name === 'string' && entry.name.toLowerCase() === name.toLowerCase()
  ))
  if (!match) return false
  try {
    return sameMcpServer(normalizeMcpServerInput(match), server)
  } catch {
    return false
  }
}

/**
 * Accept the `{"mcpServers": {...}}` snippet that most MCP server READMEs
 * publish (also `servers`, or a bare name -> definition map) and return the
 * canonical definitions it describes. Names come from the object keys.
 */
export function parseMcpServersJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new McpRegistryError('mcp_import_invalid', 'Paste an MCP server JSON snippet first.')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new McpRegistryError('mcp_import_invalid', `The snippet is not valid JSON (${error.message}).`)
  }
  if (!isPlainObject(parsed)) {
    throw new McpRegistryError('mcp_import_invalid', 'The snippet must be a JSON object.')
  }
  let map = parsed
  if (isPlainObject(parsed.mcpServers)) map = parsed.mcpServers
  else if (isPlainObject(parsed.servers)) map = parsed.servers
  else if (isPlainObject(parsed.mcp_servers)) map = parsed.mcp_servers
  else if (typeof parsed.command === 'string' || typeof parsed.url === 'string') {
    throw new McpRegistryError(
      'mcp_import_invalid',
      'Wrap the definition in {"mcpServers": {"<name>": {...}}} so the server has a name.',
    )
  }
  const entries = Object.entries(map)
  if (entries.length === 0) {
    throw new McpRegistryError('mcp_import_invalid', 'The snippet does not define any servers.')
  }
  return entries.map(([name, definition]) => {
    if (!isPlainObject(definition)) {
      throw new McpRegistryError('mcp_import_invalid', `Server "${name}" must be an object.`)
    }
    return normalizeMcpServerInput({
      name,
      transport: definition.transport,
      type: definition.type,
      command: definition.command,
      args: definition.args,
      env: definition.env,
      url: definition.url ?? definition.serverUrl ?? definition.httpUrl,
      headers: definition.headers ?? definition.http_headers,
      enabled: definition.enabled === false || definition.disabled === true ? false : true,
    })
  })
}

function maskValues(map) {
  const masked = {}
  for (const key of Object.keys(map ?? {})) masked[key] = MCP_SECRET_MASK
  return masked
}

/** The registry entry as the renderer may see it: secrets masked, nothing else hidden. */
export function publicMcpServer(server) {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: [...server.args],
    env: maskValues(server.env),
    url: server.url,
    headers: maskValues(server.headers),
    enabled: server.enabled,
    adoptedFrom: server.adoptedFrom ?? null,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  }
}

export function defaultMcpRegistryPath(env = process.env, platform = process.platform, home = homedir()) {
  const explicit = env.ENSYNC_HOST_MCP_REGISTRY_FILE
  if (typeof explicit === 'string' && isAbsolute(explicit)) return explicit
  const stateFile = env.ENSYNC_HOST_STATE_FILE
  if (typeof stateFile === 'string' && isAbsolute(stateFile)) {
    return join(dirname(stateFile), MCP_REGISTRY_FILENAME)
  }
  return join(userDataDirectory(env, platform, home), MCP_REGISTRY_FILENAME)
}

function newServerId() {
  return `mcp_${randomBytes(6).toString('hex')}`
}

function emptyState() {
  return {
    version: MCP_REGISTRY_VERSION,
    servers: [],
    tombstones: [],
    sync: { lastSyncAt: null, providers: {} },
    updatedAt: null,
  }
}

function normalizeStoredServer(raw) {
  if (!isPlainObject(raw)) return null
  try {
    const server = normalizeMcpServerInput(raw)
    const adoptedFrom = MCP_PROVIDER_IDS.has(raw.adoptedFrom) ? raw.adoptedFrom : null
    return {
      id: typeof raw.id === 'string' && raw.id.startsWith('mcp_') ? raw.id : newServerId(),
      ...server,
      adoptedFrom,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  } catch {
    return null
  }
}

function normalizeLedger(raw) {
  const providers = {}
  if (isPlainObject(raw?.providers)) {
    for (const [providerId, entry] of Object.entries(raw.providers)) {
      if (!isPlainObject(entry)) continue
      providers[providerId] = {
        configPath: typeof entry.configPath === 'string' ? entry.configPath : null,
        managedNames: Array.isArray(entry.managedNames)
          ? entry.managedNames.filter((name) => typeof name === 'string')
          : [],
        syncedAt: typeof entry.syncedAt === 'string' ? entry.syncedAt : null,
        state: typeof entry.state === 'string' ? entry.state : 'never',
        reason: typeof entry.reason === 'string' ? entry.reason : null,
        conflicts: Array.isArray(entry.conflicts) ? entry.conflicts.filter((name) => typeof name === 'string') : [],
        skipped: Array.isArray(entry.skipped) ? entry.skipped.filter(isPlainObject) : [],
      }
    }
  }
  return { lastSyncAt: typeof raw?.lastSyncAt === 'string' ? raw.lastSyncAt : null, providers }
}

function normalizeTombstones(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const tombstones = []
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue
    if (typeof entry.name !== 'string') continue
    if (!MCP_PROVIDER_IDS.has(entry.source)) continue
    const key = `${entry.source}:${entry.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    tombstones.push({ name: entry.name, source: entry.source })
  }
  return tombstones
}

export async function readMcpRegistry(path) {
  let content
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: emptyState(), readable: true }
    return { state: emptyState(), readable: false, reason: error?.message ?? 'unreadable' }
  }
  try {
    const parsed = JSON.parse(content)
    if (!isPlainObject(parsed) || parsed.version !== MCP_REGISTRY_VERSION || !Array.isArray(parsed.servers)) {
      return { state: emptyState(), readable: false, reason: 'unrecognized registry format' }
    }
    const servers = parsed.servers.map(normalizeStoredServer).filter(Boolean)
    return {
      state: {
        version: MCP_REGISTRY_VERSION,
        servers,
        tombstones: normalizeTombstones(parsed.tombstones),
        sync: normalizeLedger(parsed.sync),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      },
      readable: true,
    }
  } catch (error) {
    return { state: emptyState(), readable: false, reason: error?.message ?? 'invalid JSON' }
  }
}

export async function writeMcpRegistry(path, state) {
  const staging = `${path}.${process.pid}.staging`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(staging, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(staging, path)
}

async function readProviderFile(path) {
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      throw new McpConfigParseError('The configuration path exists but is not a regular file.')
    }
    return { content: await readFile(path, 'utf8'), exists: true, mode: info.mode & 0o777 }
  } catch (error) {
    if (error?.code === 'ENOENT') return { content: '', exists: false, mode: 0o600 }
    throw error
  }
}

async function writeProviderFile(path, content, mode) {
  const staging = `${path}.ensync-${process.pid}.staging`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(staging, content, { encoding: 'utf8', mode })
  await rename(staging, path)
}

export class McpRegistryService {
  #registryPath
  #statusService
  #catalog
  #isBusy
  #now
  #env
  #home
  #platform
  #retryDelayMs
  #state = null
  #readable = true
  #unreadableReason = null
  #loading = null
  #syncing = null
  #retryTimer = null
  #syncPending = false

  constructor(options = {}) {
    this.#env = options.env ?? process.env
    this.#home = options.home ?? homedir()
    this.#platform = options.platform ?? process.platform
    this.#registryPath = options.registryPath ?? defaultMcpRegistryPath(this.#env, this.#platform, this.#home)
    this.#statusService = options.statusService ?? null
    this.#catalog = options.catalog ?? null
    this.#isBusy = options.isBusy ?? (() => false)
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  }

  get registryPath() {
    return this.#registryPath
  }

  async #load() {
    if (this.#state) return this.#state
    this.#loading ??= readMcpRegistry(this.#registryPath).then((result) => {
      this.#state = result.state
      this.#readable = result.readable
      this.#unreadableReason = result.reason ?? null
      return this.#state
    })
    return this.#loading
  }

  async #persist() {
    if (!this.#readable) {
      throw new McpRegistryError(
        'mcp_registry_unreadable',
        `The MCP registry at ${this.#registryPath} could not be read (${this.#unreadableReason}). Fix or remove it before making changes.`,
        409,
      )
    }
    this.#state.updatedAt = this.#now()
    await writeMcpRegistry(this.#registryPath, this.#state)
  }

  async #providerStatuses() {
    if (!this.#statusService) return new Map()
    try {
      const list = await this.#statusService.list()
      return new Map((Array.isArray(list) ? list : []).map((provider) => [provider.id, provider]))
    } catch {
      return new Map()
    }
  }

  #catalogEntries() {
    if (this.#catalog) return this.#catalog
    return listMcpProviderConfigs().map((config) => ({ id: config.id, name: config.name }))
  }

  async #configPathFor(config) {
    return config.configPath(this.#env, this.#home, this.#platform)
  }

  async #discoverProviderServers() {
    const discovered = []
    for (const source of MCP_DISCOVERY_SOURCES) {
      const config = getMcpProviderConfig(source.id)
      if (!config) continue
      const configPath = await this.#configPathFor(config)
      if (!configPath) continue
      const file = await readProviderFile(configPath)
      if (!file.exists) continue
      try {
        for (const entry of source.parse(file.content)) {
          if (!isPlainObject(entry) || typeof entry.name !== 'string') continue
          discovered.push({ source: source.id, entry })
        }
      } catch {
        // A provider file Ensync cannot parse is left untouched; adoption just
        // skips that source rather than failing the panel.
      }
    }
    return discovered
  }

  async #describeProviders(state) {
    const statuses = await this.#providerStatuses()
    const described = []
    for (const entry of this.#catalogEntries()) {
      const config = getMcpProviderConfig(entry.id)
      const status = statuses.get(entry.id) ?? null
      const ledger = state.sync.providers[entry.id] ?? null
      const base = {
        id: entry.id,
        name: entry.name,
        capability: config?.sync ?? 'unavailable',
        installed: status ? status.installed === true : null,
        configPath: config?.sync === 'supported'
          ? (ledger?.configPath ?? await this.#configPathFor(config))
          : null,
        state: 'never',
        reason: config?.reason ?? 'No MCP configuration is known for this provider.',
        managedNames: ledger?.managedNames ?? [],
        conflicts: ledger?.conflicts ?? [],
        skipped: ledger?.skipped ?? [],
        syncedAt: ledger?.syncedAt ?? null,
        documentationUrl: config?.documentationUrl ?? null,
      }
      if (config?.sync === 'unavailable') described.push({ ...base, state: 'unavailable' })
      else if (config?.sync !== 'supported') described.push({ ...base, state: 'unsupported' })
      else if (ledger) described.push({ ...base, state: ledger.state, reason: ledger.reason ?? base.reason })
      else if (status && status.installed !== true) {
        described.push({ ...base, state: 'skipped', reason: `${entry.name} is not installed on this computer.` })
      } else described.push({ ...base, reason: 'Not synced yet.' })
    }
    return described
  }

  async snapshot() {
    const state = await this.#load()
    return {
      registryPath: this.#registryPath,
      readable: this.#readable,
      unreadableReason: this.#unreadableReason,
      servers: state.servers.map(publicMcpServer),
      providers: await this.#describeProviders(state),
      lastSyncAt: state.sync.lastSyncAt,
      syncPending: this.#syncPending,
      updatedAt: state.updatedAt,
    }
  }

  /**
   * Adopt MCP servers that are already configured inside Claude Code and
   * Codex into the managed registry, then sync them out to every provider.
   * This runs automatically when the settings panel lists servers; it is
   * idempotent, never edits the source files, and honors tombstones recorded
   * when the person removes an adopted server through Ensync.
   */
  async autoAdopt() {
    const state = await this.#load()
    if (!this.#readable) return this.snapshot()

    const existing = new Set(state.servers.map((server) => server.name.toLowerCase()))
    const tombstoned = new Set(state.tombstones.map((tombstone) => `${tombstone.source}:${tombstone.name.toLowerCase()}`))
    const added = []

    for (const { source, entry } of await this.#discoverProviderServers()) {
      const sourceKey = `${source}:${entry.name.toLowerCase()}`
      if (tombstoned.has(sourceKey) || existing.has(entry.name.toLowerCase())) continue
      let server
      try {
        server = normalizeMcpServerInput(entry)
      } catch {
        continue
      }
      if (existing.has(server.name.toLowerCase())) continue
      if (state.servers.length >= MAX_MCP_SERVERS) break
      const at = this.#now()
      state.servers.push({ id: newServerId(), ...server, adoptedFrom: source, createdAt: at, updatedAt: at })
      existing.add(server.name.toLowerCase())
      added.push(server.name)
    }

    if (added.length > 0) {
      await this.#persist()
    }
    const result = added.length > 0 ? await this.sync({ trigger: 'adopt' }) : await this.snapshot()
    return { ...result, adopted: added }
  }

  #findIndex(state, id) {
    const index = state.servers.findIndex((server) => server.id === id)
    if (index === -1) throw new McpRegistryError('mcp_server_not_found', 'Unknown MCP server.', 404)
    return index
  }

  #assertUniqueName(state, name, exceptId = null) {
    const clash = state.servers.find(
      (server) => server.id !== exceptId && server.name.toLowerCase() === name.toLowerCase(),
    )
    if (clash) {
      throw new McpRegistryError('mcp_server_duplicate', `An MCP server named "${clash.name}" already exists.`, 409)
    }
  }

  async add(input) {
    const state = await this.#load()
    const server = normalizeMcpServerInput(input)
    this.#assertUniqueName(state, server.name)
    if (state.servers.length >= MAX_MCP_SERVERS) {
      throw new McpRegistryError('mcp_server_limit', `Ensync manages at most ${MAX_MCP_SERVERS} MCP servers.`, 409)
    }
    const at = this.#now()
    state.servers.push({ id: newServerId(), ...server, createdAt: at, updatedAt: at })
    await this.#persist()
    return this.sync({ trigger: 'add' })
  }

  async importJson(text) {
    const state = await this.#load()
    const servers = parseMcpServersJson(text)
    if (state.servers.length + servers.length > MAX_MCP_SERVERS) {
      throw new McpRegistryError('mcp_server_limit', `Ensync manages at most ${MAX_MCP_SERVERS} MCP servers.`, 409)
    }
    const seen = new Set()
    for (const server of servers) {
      this.#assertUniqueName(state, server.name)
      if (seen.has(server.name.toLowerCase())) {
        throw new McpRegistryError('mcp_server_duplicate', `The snippet defines "${server.name}" twice.`, 409)
      }
      seen.add(server.name.toLowerCase())
    }
    const at = this.#now()
    for (const server of servers) {
      state.servers.push({ id: newServerId(), ...server, createdAt: at, updatedAt: at })
    }
    await this.#persist()
    const result = await this.sync({ trigger: 'import' })
    return { ...result, imported: servers.map((server) => server.name) }
  }

  async update(id, input) {
    const state = await this.#load()
    const index = this.#findIndex(state, id)
    const existing = state.servers[index]
    const server = normalizeMcpServerInput({ ...input, name: input?.name ?? existing.name }, existing)
    this.#assertUniqueName(state, server.name, id)
    state.servers[index] = { ...existing, ...server, updatedAt: this.#now() }
    await this.#persist()
    return this.sync({ trigger: 'update' })
  }

  async setEnabled(id, enabled) {
    const state = await this.#load()
    const index = this.#findIndex(state, id)
    state.servers[index] = { ...state.servers[index], enabled: enabled === true, updatedAt: this.#now() }
    await this.#persist()
    return this.sync({ trigger: 'update' })
  }

  async remove(id) {
    const state = await this.#load()
    const index = this.#findIndex(state, id)
    const removed = state.servers[index]
    if (removed.adoptedFrom) {
      // A server adopted from a provider file must not reappear the next time
      // the panel loads and scans that file, so its name is remembered.
      const key = `${removed.adoptedFrom}:${removed.name.toLowerCase()}`
      if (!state.tombstones.some((tombstone) => `${tombstone.source}:${tombstone.name.toLowerCase()}` === key)) {
        state.tombstones.push({ name: removed.name, source: removed.adoptedFrom })
      }
    }
    state.servers.splice(index, 1)
    await this.#persist()
    return this.sync({ trigger: 'remove' })
  }

  /**
   * Mirror every enabled server into each supported, installed provider. Runs
   * are serialized; a call that arrives during a sync waits for it and then
   * runs again so the newest registry state always lands last.
   */
  async sync(options = {}) {
    if (this.#syncing) {
      await this.#syncing.catch(() => {})
    }
    this.#syncing = this.#runSync(options)
    try {
      return await this.#syncing
    } finally {
      this.#syncing = null
    }
  }

  async #runSync({ trigger = 'manual' } = {}) {
    const state = await this.#load()
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    const enabledServers = state.servers.filter((server) => server.enabled)
    const statuses = await this.#providerStatuses()
    const busy = this.#isBusy() === true
    const at = this.#now()
    let deferred = false
    let touched = false

    for (const entry of this.#catalogEntries()) {
      const config = getMcpProviderConfig(entry.id)
      if (!config || config.sync !== 'supported') continue
      const status = statuses.get(entry.id) ?? null
      const previous = state.sync.providers[entry.id] ?? null
      const managedNames = previous?.managedNames ?? []

      if (!status || status.installed !== true) {
        // Nothing is written for a provider that is not on this computer. A
        // ledger from an earlier install is kept so a reinstall reconciles.
        if (previous) {
          state.sync.providers[entry.id] = {
            ...previous,
            state: 'skipped',
            reason: status ? `${entry.name} is not installed on this computer.` : 'Provider status is unavailable.',
          }
          touched = true
        }
        continue
      }

      if (busy) {
        deferred = true
        state.sync.providers[entry.id] = {
          configPath: previous?.configPath ?? await this.#configPathFor(config),
          managedNames,
          syncedAt: previous?.syncedAt ?? null,
          state: 'deferred',
          reason: 'Waiting for active agent runs to finish before editing provider configuration.',
          conflicts: previous?.conflicts ?? [],
          skipped: previous?.skipped ?? [],
        }
        touched = true
        continue
      }

      const configPath = await this.#configPathFor(config)
      state.sync.providers[entry.id] = await this.#applyProvider({
        entry,
        config,
        configPath,
        servers: enabledServers,
        managedNames,
        at,
      })
      touched = true
    }

    this.#syncPending = deferred
    if (deferred) this.#scheduleRetry()
    if (touched || trigger !== 'startup') {
      state.sync.lastSyncAt = at
      try {
        await this.#persist()
      } catch (error) {
        if (!(error instanceof McpRegistryError)) throw error
      }
    }
    return this.snapshot()
  }

  async #applyProvider({ entry, config, configPath, servers, managedNames, at }) {
    if (!configPath) {
      return {
        configPath: null,
        managedNames: [],
        syncedAt: at,
        state: 'error',
        reason: `${entry.name} has no resolvable MCP configuration path on this platform.`,
        conflicts: [],
        skipped: [],
      }
    }
    try {
      const file = await readProviderFile(configPath)
      if (!file.exists && servers.length === 0 && managedNames.length === 0) {
        return {
          configPath,
          managedNames: [],
          syncedAt: at,
          state: 'synced',
          reason: 'No MCP servers to sync; the provider file was left uncreated.',
          conflicts: [],
          skipped: [],
        }
      }
      const result = config.merge({ content: file.content, servers, managedNames })
      if (result.changed) await writeProviderFile(configPath, result.content, file.mode)

      // A same-named entry Ensync did not write is only a real conflict when it
      // actually differs from the registry. One Ensync adopted from this very
      // provider, or one that already carries the exact same definition, is
      // satisfied as-is: it is neither overwritten nor reported as a conflict.
      const byName = new Map(servers.map((server) => [server.name.toLowerCase(), server]))
      const conflicts = []
      const preserved = []
      for (const name of result.conflicts) {
        const server = byName.get(name.toLowerCase())
        const satisfied = Boolean(server) && (
          server.adoptedFrom === entry.id
          || providerEntrySatisfies(config.read, file.content, name, server)
        )
        if (satisfied) preserved.push(name)
        else conflicts.push(name)
      }

      const written = result.managedNames.length
      const parts = []
      if (written > 0) parts.push(`${written} server${written === 1 ? '' : 's'} synced`)
      if (preserved.length > 0) {
        parts.push(`${preserved.length} left in place because ${entry.name} already has a matching ${preserved.map((name) => `"${name}"`).join(', ')}`)
      }
      if (conflicts.length > 0) {
        parts.push(`${conflicts.length} left untouched because ${entry.name} already defines ${conflicts.map((name) => `"${name}"`).join(', ')}`)
      }
      if (result.skipped.length > 0) {
        parts.push(`${result.skipped.length} not supported by ${entry.name}`)
      }
      return {
        configPath,
        managedNames: result.managedNames,
        syncedAt: at,
        state: 'synced',
        reason: `${parts.join('; ')}.`,
        conflicts,
        skipped: result.skipped,
      }
    } catch (error) {
      const detail = error instanceof McpConfigParseError
        ? error.message
        : `Ensync could not update the file (${error?.code ?? error?.message ?? 'unknown error'}).`
      return {
        configPath,
        managedNames,
        syncedAt: at,
        state: 'error',
        reason: `${detail} The file was not modified.`,
        conflicts: [],
        skipped: [],
      }
    }
  }

  #scheduleRetry() {
    if (this.#retryTimer) return
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      this.sync({ trigger: 'retry' }).catch(() => {})
    }, this.#retryDelayMs)
    this.#retryTimer.unref?.()
  }

  /** Reconcile provider files once the Host is up, without blocking startup. */
  async startupSync() {
    const state = await this.#load()
    const hasWork = state.servers.length > 0
      || Object.values(state.sync.providers).some((entry) => entry.managedNames.length > 0)
    if (!hasWork) return null
    return this.sync({ trigger: 'startup' })
  }

  close() {
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
  }
}
