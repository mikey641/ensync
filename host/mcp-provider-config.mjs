import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseCodexMcpServersToml, parseJsonMcpServers } from './mcp-config-readers.mjs'
import { mergeJsonMcpConfig, mergeTomlMcpConfig, tomlMcpServerSection } from './mcp-config-writers.mjs'

// Catalog-wide MCP (Model Context Protocol) configuration knowledge, one entry
// per provider, verified against first-party documentation on 2026-09-06 (see
// `.ensync/provider-api-research.md`, "MCP configuration review").
//
// `sync` is the provider's explicit capability for Ensync-managed MCP sync:
//   supported   — the user-level file location and schema are verified, so
//                 Ensync merges managed servers into it.
//   unavailable — the provider has no local MCP configuration file Ensync
//                 could write (cloud-only, account-synced, or not an MCP
//                 client at all).
//
// No provider is silently omitted: every catalog ID has an entry with a
// factual reason, and a transport a provider cannot express is reported as
// skipped for that provider rather than written in a shape it would reject.

function compact(object) {
  const result = {}
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue
    result[key] = value
  }
  return result
}

function skippedEntry(server, reason) {
  return { name: server.name, reason }
}

/**
 * Build a JSON merge for a provider that keeps `{ <name>: {...} }` under
 * `keyPath`. `serialize(server)` returns the provider-native object, or a
 * string explaining why this provider cannot express that server.
 */
function jsonMerge({ keyPath, serialize }) {
  return ({ content, servers, managedNames }) => {
    const entries = {}
    const skipped = []
    for (const server of servers) {
      const native = serialize(server)
      if (typeof native === 'string') {
        skipped.push(skippedEntry(server, native))
        continue
      }
      entries[server.name] = native
    }
    const result = mergeJsonMcpConfig({ content, keyPath, entries, managedNames })
    return { ...result, skipped }
  }
}

function tomlMerge({ table, serialize }) {
  return ({ content, servers, managedNames }) => {
    const sections = {}
    const skipped = []
    for (const server of servers) {
      const section = serialize(server)
      if (typeof section === 'string') {
        skipped.push(skippedEntry(server, section))
        continue
      }
      sections[server.name] = tomlMcpServerSection({ table, name: server.name, ...section })
    }
    const result = mergeTomlMcpConfig({ content, table, sections, managedNames })
    return { ...result, skipped }
  }
}

// Discovery-side inverse of a JSON merge: read the provider's server map back
// from the same key path `merge` writes it to.
function jsonMcpReader(keyPath) {
  return (content) => parseJsonMcpServers(content, { key: keyPath })
}

// Shared serializers -------------------------------------------------------

const SSE_UNSUPPORTED = 'SSE transport is not supported; use streamable HTTP.'
const HEADERS_UNSUPPORTED = 'Custom headers are not supported for remote servers.'

// { "type": "stdio" | "http" | "sse", command/args/env | url/headers }
function typedJsonServer(server, { stdio = 'stdio', http = 'http', sse = 'sse', extra = {} } = {}) {
  if (server.transport === 'stdio') {
    return compact({ type: stdio, command: server.command, args: server.args, env: server.env, ...extra })
  }
  return compact({ type: server.transport === 'sse' ? sse : http, url: server.url, headers: server.headers, ...extra })
}

// { command/args/env } or { url/headers } with the transport inferred from the URL
function untypedJsonServer(server, { urlKey = 'url' } = {}) {
  if (server.transport === 'stdio') {
    return compact({ command: server.command, args: server.args, env: server.env })
  }
  return compact({ [urlKey]: server.url, headers: server.headers })
}

// Codex TOML: [mcp_servers.<name>] command/args + [.env], or url + [.http_headers]
function codexTomlServer(server) {
  if (server.transport === 'stdio') {
    return {
      fields: { command: server.command, args: server.args.length > 0 ? server.args : undefined },
      subTables: { env: server.env },
    }
  }
  if (server.transport === 'sse') return SSE_UNSUPPORTED
  return { fields: { url: server.url }, subTables: { http_headers: server.headers } }
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

function envPath(env, name) {
  const value = env?.[name]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const providerConfigs = [
  {
    id: 'claude',
    name: 'Claude Code',
    sync: 'supported',
    reason: 'User-scope servers live in ~/.claude.json under "mcpServers"; remote entries carry "type": "http" or "sse".',
    documentationUrl: 'https://code.claude.com/docs/en/mcp',
    configPath: (env, home) => join(home, '.claude.json'),
    merge: jsonMerge({ keyPath: ['mcpServers'], serialize: (server) => typedJsonServer(server) }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'codex',
    name: 'Codex',
    sync: 'supported',
    reason: 'Servers live in $CODEX_HOME/config.toml (default ~/.codex) as [mcp_servers.<name>] tables; stdio and streamable HTTP only.',
    documentationUrl: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
    configPath: (env, home) => join(envPath(env, 'CODEX_HOME') ?? join(home, '.codex'), 'config.toml'),
    merge: tomlMerge({ table: 'mcp_servers', serialize: codexTomlServer }),
    read: (content) => parseCodexMcpServersToml(content),
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    sync: 'supported',
    reason: 'Servers live in $KIMI_CODE_HOME/mcp.json (default ~/.kimi-code) under "mcpServers"; SSE entries set "transport": "sse".',
    documentationUrl: 'https://moonshotai.github.io/kimi-code/en/customization/mcp',
    configPath: (env, home) => join(envPath(env, 'KIMI_CODE_HOME') ?? join(home, '.kimi-code'), 'mcp.json'),
    merge: jsonMerge({
      keyPath: ['mcpServers'],
      serialize: (server) => {
        if (server.transport === 'stdio') return compact({ command: server.command, args: server.args, env: server.env })
        return compact({ transport: server.transport === 'sse' ? 'sse' : undefined, url: server.url, headers: server.headers })
      },
    }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    sync: 'supported',
    reason: 'Servers live in ~/.gemini/config/mcp_config.json under "mcpServers"; remote entries use "serverUrl".',
    documentationUrl: 'https://antigravity.google/docs/cli/mcp/',
    configPath: (env, home) => join(home, '.gemini', 'config', 'mcp_config.json'),
    merge: jsonMerge({ keyPath: ['mcpServers'], serialize: (server) => untypedJsonServer(server, { urlKey: 'serverUrl' }) }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'jules',
    name: 'Google Jules',
    sync: 'unavailable',
    reason: 'Jules is a cloud-session agent; its CLI has no MCP support and the web app only offers a curated partner list.',
    documentationUrl: 'https://jules.google/docs/cli/reference/',
    configPath: () => null,
    merge: null,
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    sync: 'supported',
    reason: 'Servers live in $COPILOT_HOME/mcp-config.json (default ~/.copilot) under "mcpServers" with stdio, http, and sse types.',
    documentationUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers',
    configPath: (env, home) => join(envPath(env, 'COPILOT_HOME') ?? join(home, '.copilot'), 'mcp-config.json'),
    merge: jsonMerge({ keyPath: ['mcpServers'], serialize: (server) => typedJsonServer(server, { extra: { tools: ['*'] } }) }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    sync: 'supported',
    reason: 'Servers live in ~/.cursor/mcp.json under "mcpServers" as command/args/env or url/headers entries.',
    documentationUrl: 'https://cursor.com/docs/mcp',
    configPath: (env, home) => join(home, '.cursor', 'mcp.json'),
    merge: jsonMerge({ keyPath: ['mcpServers'], serialize: (server) => untypedJsonServer(server) }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'kiro',
    name: 'Kiro CLI',
    sync: 'supported',
    reason: 'Servers live in ~/.kiro/settings/mcp.json under "mcpServers" as command/args/env or url/headers entries.',
    documentationUrl: 'https://kiro.dev/docs/mcp/configuration/',
    configPath: (env, home) => join(home, '.kiro', 'settings', 'mcp.json'),
    merge: jsonMerge({ keyPath: ['mcpServers'], serialize: (server) => untypedJsonServer(server) }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'qoder',
    name: 'Qoder CLI',
    sync: 'supported',
    reason: 'User-scope servers live in $QODER_CONFIG_DIR/settings.json (default ~/.qoder) under "mcpServers" with stdio, http, and sse types.',
    documentationUrl: 'https://docs.qoder.com/cli/mcp-reference',
    configPath: (env, home) => join(envPath(env, 'QODER_CONFIG_DIR') ?? join(home, '.qoder'), 'settings.json'),
    merge: jsonMerge({ keyPath: ['mcpServers'], serialize: (server) => typedJsonServer(server) }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    sync: 'supported',
    reason: 'User-scope servers live in the first existing of ~/.codebuddy/.mcp.json, ~/.codebuddy/mcp.json, or ~/.codebuddy.json under "mcpServers".',
    documentationUrl: 'https://www.codebuddy.ai/docs/cli/mcp',
    configPath: async (env, home) => {
      // CodeBuddy reads the first file that exists and ignores the rest, so a
      // new .mcp.json would silently shadow servers kept in an older file.
      const directory = envPath(env, 'CODEBUDDY_CONFIG_DIR') ?? join(home, '.codebuddy')
      const candidates = [join(directory, '.mcp.json'), join(directory, 'mcp.json'), join(home, '.codebuddy.json')]
      return (await firstExisting(candidates)) ?? candidates[0]
    },
    merge: jsonMerge({ keyPath: ['mcpServers'], serialize: (server) => typedJsonServer(server) }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'droid',
    name: 'Factory Droid',
    sync: 'supported',
    reason: 'Servers live in ~/.factory/mcp.json under "mcpServers" with stdio, http, and sse types.',
    documentationUrl: 'https://docs.factory.ai/cli/configuration/mcp',
    configPath: (env, home) => join(home, '.factory', 'mcp.json'),
    merge: jsonMerge({ keyPath: ['mcpServers'], serialize: (server) => typedJsonServer(server) }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'auggie',
    name: 'Augment Auggie',
    sync: 'supported',
    reason: 'Servers live in ~/.augment/settings.json under "mcpServers" with stdio, http, and sse types.',
    documentationUrl: 'https://docs.augmentcode.com/cli/integrations',
    configPath: (env, home) => join(home, '.augment', 'settings.json'),
    merge: jsonMerge({ keyPath: ['mcpServers'], serialize: (server) => typedJsonServer(server) }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'amp',
    name: 'Amp',
    sync: 'supported',
    reason: 'Servers live in $AMP_SETTINGS_FILE (default ~/.config/amp/settings.json) under the flat "amp.mcpServers" key as command/args/env or url/headers entries.',
    documentationUrl: 'https://ampcode.com/docs/customize/mcp',
    configPath: (env, home) => envPath(env, 'AMP_SETTINGS_FILE') ?? join(home, '.config', 'amp', 'settings.json'),
    merge: jsonMerge({ keyPath: ['amp.mcpServers'], serialize: (server) => untypedJsonServer(server) }),
    read: jsonMcpReader(['amp.mcpServers']),
  },
  {
    id: 'gitlab_duo',
    name: 'GitLab Duo CLI',
    sync: 'supported',
    reason: 'Servers live in ~/.gitlab/duo/mcp.json (Windows: %APPDATA%\\GitLab\\duo\\mcp.json) under "mcpServers" with stdio, http, and sse types; remote entries cannot carry headers.',
    documentationUrl: 'https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_clients/',
    configPath: (env, home, platform = process.platform) => {
      const glabConfig = envPath(env, 'GLAB_CONFIG_DIR')
      if (glabConfig) return join(glabConfig, 'duo', 'mcp.json')
      const xdg = envPath(env, 'XDG_CONFIG_HOME')
      if (xdg) return join(xdg, 'gitlab', 'duo', 'mcp.json')
      if (platform === 'win32') {
        return join(envPath(env, 'APPDATA') ?? join(home, 'AppData', 'Roaming'), 'GitLab', 'duo', 'mcp.json')
      }
      return join(home, '.gitlab', 'duo', 'mcp.json')
    },
    merge: jsonMerge({
      keyPath: ['mcpServers'],
      serialize: (server) => {
        if (server.transport !== 'stdio' && Object.keys(server.headers).length > 0) return HEADERS_UNSUPPORTED
        if (server.transport === 'stdio') {
          return compact({ type: 'stdio', command: server.command, args: server.args, env: server.env })
        }
        return compact({ type: server.transport, url: server.url })
      },
    }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'oz',
    name: 'Warp Oz',
    sync: 'unavailable',
    reason: 'Warp Oz reads MCP servers from the Warp account or a per-run --mcp flag; there is no local file for Ensync to write.',
    documentationUrl: 'https://docs.warp.dev/reference/cli/mcp-servers/',
    configPath: () => null,
    merge: null,
  },
  {
    id: 'junie',
    name: 'Junie CLI',
    sync: 'supported',
    reason: 'Servers live in $JUNIE_HOME/mcp/mcp.json (default ~/.junie) under "mcpServers" as command/args/env or url/headers entries; SSE is not documented.',
    documentationUrl: 'https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html',
    configPath: (env, home) => join(envPath(env, 'JUNIE_HOME') ?? join(home, '.junie'), 'mcp', 'mcp.json'),
    merge: jsonMerge({
      keyPath: ['mcpServers'],
      serialize: (server) => (server.transport === 'sse' ? 'SSE transport is not documented for Junie CLI.' : untypedJsonServer(server)),
    }),
    read: jsonMcpReader(['mcpServers']),
  },
  {
    id: 'ollama',
    name: 'Ollama',
    sync: 'unavailable',
    reason: 'Ollama is a local model runtime, not an MCP client; it has no MCP configuration.',
    documentationUrl: 'https://docs.ollama.com/cli',
    configPath: () => null,
    merge: null,
  },
]

const byId = new Map(providerConfigs.map((config) => [config.id, config]))

export function listMcpProviderConfigs() {
  return providerConfigs.map((config) => ({
    id: config.id,
    name: config.name,
    sync: config.sync,
    reason: config.reason,
    documentationUrl: config.documentationUrl,
  }))
}

export function getMcpProviderConfig(providerId) {
  return byId.get(providerId) ?? null
}

/** May return a promise for providers whose file choice depends on what exists. */
export function getMcpConfigPath(providerId, env = process.env, home = homedir(), platform = process.platform) {
  const config = byId.get(providerId)
  if (!config) return null
  return config.configPath(env, home, platform)
}

export function hasMcpConfig(providerId) {
  const config = byId.get(providerId)
  return Boolean(config) && config.sync !== 'unavailable'
}
