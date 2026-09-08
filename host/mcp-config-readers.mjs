import { McpConfigParseError } from './mcp-config-writers.mjs'

// Read-only extraction of provider-native MCP server definitions back into the
// provider-neutral `{ name, ...fields }` shape, so Ensync can adopt servers a
// person already configured inside a CLI and share them with every other
// provider. These are the inverse of the serializers in mcp-config-writers.mjs;
// a file that cannot be parsed is surfaced to the caller, never modified.

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function entriesFrom(value) {
  if (isPlainObject(value)) {
    return Object.entries(value).map(([name, definition]) => (
      isPlainObject(definition) ? { name, ...definition } : null
    )).filter(Boolean)
  }
  if (Array.isArray(value)) {
    // Some CLIs keep `[{ name, ... }]`; the object map above is the common shape.
    return value.map((item) => (isPlainObject(item) && typeof item.name === 'string' ? { ...item } : null)).filter(Boolean)
  }
  return []
}

/**
 * Normalize the provider-specific aliases into the neutral field names
 * `normalizeMcpServerInput` reads, without discarding the native fields a
 * provider may model differently.
 */
export function canonicalizeMcpEntry(entry) {
  const canonical = { ...entry }
  if (!isPlainObject(canonical.headers) && isPlainObject(canonical.http_headers)) {
    canonical.headers = canonical.http_headers
  }
  if (typeof canonical.url !== 'string') {
    if (typeof canonical.serverUrl === 'string') canonical.url = canonical.serverUrl
    else if (typeof canonical.httpUrl === 'string') canonical.url = canonical.httpUrl
  }
  return canonical
}

function lookupPath(root, key) {
  const path = Array.isArray(key) ? key : String(key).split('.')
  let node = root
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[segment]
  }
  return node
}

export function parseJsonMcpServers(content, { key = 'mcpServers' } = {}) {
  if (typeof content !== 'string' || content.trim() === '') return []
  let root
  try {
    root = JSON.parse(content)
  } catch (error) {
    throw new McpConfigParseError(`The file is not valid JSON (${error.message}).`)
  }
  if (!isPlainObject(root)) {
    throw new McpConfigParseError('The file does not contain a JSON object at its root.')
  }
  return entriesFrom(lookupPath(root, key)).map(canonicalizeMcpEntry)
}

// --- Codex config.toml ([mcp_servers.<name>]) -------------------------------

function parseTomlString(text) {
  const value = text.trim()
  if (value.length < 2) return ''
  if (value[0] === '"') {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value[0] === "'") return value.slice(1, -1)
  return value
}

function parseTomlKey(text) {
  const value = text.trim()
  if (value[0] === '"' || value[0] === "'") return parseTomlString(value)
  return value
}

function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let inString = false
  let quote = ''
  let current = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      current += char
      if (char === quote && text[index - 1] !== '\\') inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      current += char
      continue
    }
    if (char === '[' || char === '{') { depth += 1; current += char; continue }
    if (char === ']' || char === '}') { depth -= 1; current += char; continue }
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

function parseTomlArray(text) {
  const value = text.trim()
  if (!value.startsWith('[') || !value.endsWith(']')) return null
  const inner = value.slice(1, -1).trim()
  if (inner === '') return []
  return splitTopLevel(inner).map(parseTomlScalar)
}

function parseTomlInlineTable(text) {
  const value = text.trim()
  if (!value.startsWith('{') || !value.endsWith('}')) return null
  const inner = value.slice(1, -1).trim()
  const result = {}
  if (inner === '') return result
  for (const part of splitTopLevel(inner)) {
    const equals = part.indexOf('=')
    if (equals <= 0) continue
    result[parseTomlKey(part.slice(0, equals))] = parseTomlScalar(part.slice(equals + 1))
  }
  return result
}

function parseTomlScalar(text) {
  const value = text.trim()
  if (value === '') return null
  if (value[0] === '"' || value[0] === "'") return parseTomlString(value)
  if (value[0] === '[') return parseTomlArray(value)
  if (value[0] === '{') return parseTomlInlineTable(value)
  if (value === 'true') return true
  if (value === 'false') return false
  const number = Number(value)
  return Number.isFinite(number) ? number : value
}

function stripTomlComment(line) {
  let inString = false
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (inString) {
      if (char === quote && line[index - 1] !== '\\') inString = false
      continue
    }
    if (char === '"' || char === "'") {
      inString = true
      quote = char
      continue
    }
    if (char === '#') return line.slice(0, index)
  }
  return line
}

function toStringValue(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

function toStringMap(value) {
  const result = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue
      const equals = item.indexOf('=')
      if (equals > 0) result[item.slice(0, equals)] = item.slice(equals + 1)
    }
    return result
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) result[key] = toStringValue(item)
  }
  return result
}

const CODEX_SECTION = /^mcp_servers\.(?:(?:"([^"]+)")|(?:'([^']+)')|([A-Za-z0-9_-]+))(?:\.(env|http_headers))?$/

function parseCodexSection(path) {
  const match = CODEX_SECTION.exec(path.trim())
  if (!match) return null
  return { name: match[1] ?? match[2] ?? match[3], sub: match[4] ?? null }
}

export function parseCodexMcpServersToml(content) {
  if (typeof content !== 'string' || content.trim() === '') return []
  const servers = []
  let current = null
  let subTable = null

  const flush = () => {
    if (!current) return
    const { name, fields, env, httpHeaders } = current
    const entry = { name }
    if (typeof fields.url === 'string' && fields.url.trim() !== '') {
      entry.url = fields.url
      if (Object.keys(httpHeaders).length > 0) entry.headers = httpHeaders
    } else if (typeof fields.command === 'string') {
      entry.command = fields.command
      if (Array.isArray(fields.args)) entry.args = fields.args.map(String)
      if (Object.keys(env).length > 0) entry.env = env
    }
    if (fields.enabled === false) entry.enabled = false
    servers.push(entry)
    current = null
    subTable = null
  }

  const assign = (key, value) => {
    if (subTable === 'env') current.env[key] = toStringValue(value)
    else if (subTable === 'http_headers') current.httpHeaders[key] = toStringValue(value)
    else if (key === 'env') Object.assign(current.env, toStringMap(value))
    else if (key === 'http_headers') Object.assign(current.httpHeaders, toStringMap(value))
    else current.fields[key] = value
  }

  for (const rawLine of content.split('\n')) {
    const line = stripTomlComment(rawLine).trim()
    if (line === '') continue
    const header = line.match(/^\[\s*([^\]]+?)\s*\]$/)
    if (header) {
      const section = parseCodexSection(header[1])
      if (!section) {
        flush()
        continue
      }
      if (section.sub === null) {
        flush()
        current = { name: section.name, fields: {}, env: {}, httpHeaders: {} }
        subTable = null
      } else if (current && section.name === current.name) {
        subTable = section.sub
      } else {
        // A sub-table whose parent we have not started (or one that belongs to
        // a different server): ignore it until its own table starts.
        current = null
        subTable = null
      }
      continue
    }
    if (!current) continue
    const equals = line.indexOf('=')
    if (equals <= 0) continue
    assign(parseTomlKey(line.slice(0, equals)), parseTomlScalar(line.slice(equals + 1)))
  }
  flush()
  return servers
}
