import { readFile, stat } from 'node:fs/promises'
import { getMcpConfigPath, hasMcpConfig } from './provider-install.mjs'

// Read-only MCP (Model Context Protocol) server discovery. Ensync reports
// only whether a provider's MCP config file exists and which server names are
// configured. It never reads, parses, or transmits server command arguments,
// environment variables, URLs, or credentials. The server names themselves
// are non-sensitive labels (e.g. "linear", "github", "filesystem").

function parseTomlMcpServers(content) {
  // Codex and Kimi use TOML with [mcp_servers.<name>] sections.
  // We extract only the top-level server names, not nested sub-sections
  // like [mcp_servers.<name>.env] which are configuration for the same server.
  const names = new Set()
  const pattern = /\[mcp_servers\.([^\].]+)\]/g
  let match
  while ((match = pattern.exec(content)) !== null) {
    const name = match[1].trim()
    // Skip nested sub-sections like [mcp_servers.<name>.env]
    if (!name.includes('.')) {
      names.add(name)
    }
  }
  return [...names]
}

function parseJsonMcpServers(content, mcpKey = 'mcpServers') {
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object') return []
    // Some providers nest mcpServers under a provider key (e.g. amp.mcpServers)
    const servers = parsed[mcpKey] ?? parsed
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      return Object.keys(servers).filter((k) => typeof k === 'string')
    }
    return []
  } catch {
    return []
  }
}

function parseClaudeMcpServers(content) {
  // Claude Code stores MCP servers in ~/.claude.json under a top-level
  // "mcpServers" key and per-project "mcpServers" inside "projects".
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object') return { global: [], projects: {} }
    const global = parsed.mcpServers && typeof parsed.mcpServers === 'object'
      ? Object.keys(parsed.mcpServers).filter((k) => typeof k === 'string')
      : []
    const projects = {}
    if (parsed.projects && typeof parsed.projects === 'object') {
      for (const [projectPath, conf] of Object.entries(parsed.projects)) {
        if (conf && typeof conf === 'object' && conf.mcpServers && typeof conf.mcpServers === 'object') {
          const names = Object.keys(conf.mcpServers).filter((k) => typeof k === 'string')
          if (names.length > 0) projects[projectPath] = names
        }
      }
    }
    return { global, projects }
  } catch {
    return { global: [], projects: {} }
  }
}

function parseAmpMcpServers(content) {
  // Amp nests MCP servers under amp.mcpServers in settings.json
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object') return []
    const amp = parsed.amp
    if (amp && typeof amp === 'object' && amp.mcpServers && typeof amp.mcpServers === 'object') {
      return Object.keys(amp.mcpServers).filter((k) => typeof k === 'string')
    }
    return []
  } catch {
    return []
  }
}

export async function probeMcpConfig(providerId, options = {}) {
  if (!hasMcpConfig(providerId)) {
    return {
      providerId,
      configured: false,
      configPath: null,
      exists: false,
      serverCount: 0,
      serverNames: [],
      reason: `${providerId} has no local MCP configuration file.`,
    }
  }

  const configPath = options.configPath ?? getMcpConfigPath(
    providerId,
    options.environment,
    options.home,
  )
  if (!configPath) {
    return {
      providerId,
      configured: false,
      configPath: null,
      exists: false,
      serverCount: 0,
      serverNames: [],
      reason: `${providerId} does not use a local MCP configuration file.`,
    }
  }

  let content
  try {
    const info = await stat(configPath)
    if (!info.isFile()) {
      return {
        providerId,
        configured: false,
        configPath,
        exists: false,
        serverCount: 0,
        serverNames: [],
        reason: 'MCP config path exists but is not a regular file.',
      }
    }
    content = await readFile(configPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        providerId,
        configured: false,
        configPath,
        exists: false,
        serverCount: 0,
        serverNames: [],
        reason: 'No MCP configuration file found. Run the provider once to create it, or add MCP servers through the provider\'s own /mcp command.',
      }
    }
    return {
      providerId,
      configured: false,
      configPath,
      exists: false,
      serverCount: 0,
      serverNames: [],
      reason: 'Ensync could not read the MCP configuration file.',
    }
  }

  // Parse only server names, never credentials or arguments
  let serverNames
  let projects = null

  if (providerId === 'claude') {
    const result = parseClaudeMcpServers(content)
    serverNames = result.global
    projects = result.projects
  } else if (providerId === 'codex' || providerId === 'kimi') {
    serverNames = parseTomlMcpServers(content)
  } else if (providerId === 'amp') {
    serverNames = parseAmpMcpServers(content)
  } else {
    serverNames = parseJsonMcpServers(content)
  }

  const serverCount = serverNames.length
  const hasProjectServers = projects && Object.keys(projects).length > 0

  return {
    providerId,
    configured: serverCount > 0 || hasProjectServers,
    configPath,
    exists: true,
    serverCount,
    serverNames,
    projects: projects ?? null,
    reason: serverCount > 0 || hasProjectServers
      ? `${serverCount} MCP server${serverCount === 1 ? '' : 's'} configured.`
      : 'MCP config file exists but no servers are configured.',
  }
}
