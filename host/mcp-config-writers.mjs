// Pure text transforms that merge Ensync-managed MCP servers into a provider's
// own configuration file without disturbing anything else in it.
//
// Two rules make these safe to run repeatedly against files the person also
// edits by hand or through a provider's own `mcp add` command:
//
// 1. Only names Ensync previously wrote (the ledger's `managedNames`) may be
//    rewritten or removed. A same-named entry Ensync did not write is reported
//    as a conflict and left exactly as it was.
// 2. Every other key, table, and comment in the file is carried through. JSON
//    files are re-serialized (comments cannot survive JSON.parse, and none of
//    the JSON-configured providers accept them); TOML files are edited as
//    lines so the person's comments and ordering elsewhere survive.

export class McpConfigParseError extends Error {
  constructor(message) {
    super(message)
    this.name = 'McpConfigParseError'
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonRoot(content) {
  if (typeof content !== 'string' || content.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new McpConfigParseError(`The file is not valid JSON (${error.message}).`)
  }
  if (!isPlainObject(parsed)) {
    throw new McpConfigParseError('The file does not contain a JSON object at its root.')
  }
  return parsed
}

/**
 * Merge `entries` (name -> provider-native server object) into the JSON object
 * found at `keyPath` inside `content`.
 *
 * `shape` is `'object'` (the common `{ "mcpServers": { name: {...} } }`) or
 * `'array'` for providers that keep a list of `{ name, ... }` objects.
 */
export function mergeJsonMcpConfig({ content, keyPath, entries, managedNames = [], shape = 'object' }) {
  if (!Array.isArray(keyPath) || keyPath.length === 0) {
    throw new TypeError('mergeJsonMcpConfig requires a non-empty keyPath.')
  }
  const root = parseJsonRoot(content)
  const managed = new Set(managedNames)
  const wanted = new Map(Object.entries(entries ?? {}))

  let parent = root
  for (const key of keyPath.slice(0, -1)) {
    if (parent[key] === undefined || parent[key] === null) parent[key] = {}
    if (!isPlainObject(parent[key])) {
      throw new McpConfigParseError(`Expected "${key}" to be an object.`)
    }
    parent = parent[key]
  }
  const leafKey = keyPath[keyPath.length - 1]

  const conflicts = []
  const written = []
  let changed = false

  if (shape === 'array') {
    if (parent[leafKey] === undefined || parent[leafKey] === null) parent[leafKey] = []
    if (!Array.isArray(parent[leafKey])) {
      throw new McpConfigParseError(`Expected "${leafKey}" to be an array.`)
    }
    const list = parent[leafKey]
    const kept = []
    const seen = new Set()
    for (const item of list) {
      const name = isPlainObject(item) && typeof item.name === 'string' ? item.name : null
      if (name && managed.has(name)) {
        // Ensync wrote this one: rewrite it in place or drop it.
        if (wanted.has(name)) {
          kept.push(wanted.get(name))
          written.push(name)
          seen.add(name)
          if (JSON.stringify(item) !== JSON.stringify(wanted.get(name))) changed = true
        } else {
          changed = true
        }
        continue
      }
      if (name && wanted.has(name)) {
        conflicts.push(name)
        seen.add(name)
      }
      kept.push(item)
    }
    for (const [name, value] of wanted) {
      if (seen.has(name)) continue
      kept.push(value)
      written.push(name)
      changed = true
    }
    parent[leafKey] = kept
  } else {
    if (parent[leafKey] === undefined || parent[leafKey] === null) parent[leafKey] = {}
    if (!isPlainObject(parent[leafKey])) {
      throw new McpConfigParseError(`Expected "${leafKey}" to be an object.`)
    }
    const container = parent[leafKey]
    for (const name of managed) {
      if (!wanted.has(name) && Object.hasOwn(container, name)) {
        delete container[name]
        changed = true
      }
    }
    for (const [name, value] of wanted) {
      if (Object.hasOwn(container, name) && !managed.has(name)) {
        conflicts.push(name)
        continue
      }
      if (JSON.stringify(container[name]) !== JSON.stringify(value)) changed = true
      container[name] = value
      written.push(name)
    }
  }

  return {
    content: `${JSON.stringify(root, null, 2)}\n`,
    managedNames: written,
    conflicts,
    changed,
  }
}

// --- TOML -------------------------------------------------------------------

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/

export function tomlString(value) {
  const text = String(value)
  let out = '"'
  for (const char of text) {
    const code = char.codePointAt(0)
    if (char === '"') out += '\\"'
    else if (char === '\\') out += '\\\\'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

export function tomlKey(key) {
  return TOML_BARE_KEY.test(key) ? key : tomlString(key)
}

function tomlValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) return `[${value.map((item) => tomlValue(item)).join(', ')}]`
  if (isPlainObject(value)) {
    const pairs = Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`)
    return `{ ${pairs.join(', ')} }`
  }
  return tomlString(value)
}

/**
 * Render one `[<table>.<name>]` section. `fields` become `key = value` lines;
 * each entry of `subTables` becomes a nested `[<table>.<name>.<sub>]` section
 * (empty sub-tables are omitted).
 */
export function tomlMcpServerSection({ table, name, fields = {}, subTables = {} }) {
  const lines = [`[${table}.${tomlKey(name)}]`]
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    lines.push(`${tomlKey(key)} = ${tomlValue(value)}`)
  }
  for (const [sub, values] of Object.entries(subTables)) {
    if (!isPlainObject(values) || Object.keys(values).length === 0) continue
    lines.push('', `[${table}.${tomlKey(name)}.${tomlKey(sub)}]`)
    for (const [key, value] of Object.entries(values)) {
      lines.push(`${tomlKey(key)} = ${tomlValue(value)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function tomlHeaderName(line, table) {
  // Matches [table.name], [table."name"], [table.name.sub], with optional
  // surrounding whitespace and a trailing comment. Returns the server name or
  // null when the line is not a header for this table.
  const match = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/)
  if (!match) return null
  const path = match[1]
  const prefix = `${table}.`
  if (!path.startsWith(prefix)) return null
  const rest = path.slice(prefix.length).trim()
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1)
    return end > 1 ? rest.slice(1, end) : null
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1)
    return end > 1 ? rest.slice(1, end) : null
  }
  return rest.split('.')[0] || null
}

function isAnyTableHeader(line) {
  return /^\s*\[/.test(line)
}

/**
 * Merge `sections` (name -> rendered section text from tomlMcpServerSection)
 * into a TOML document that keeps its servers under `[<table>.<name>]`.
 */
export function mergeTomlMcpConfig({ content, table = 'mcp_servers', sections, managedNames = [] }) {
  const source = typeof content === 'string' ? content : ''
  const inlinePattern = new RegExp(`^\\s*${table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'm')
  if (inlinePattern.test(source)) {
    throw new McpConfigParseError(`The file defines "${table}" as an inline table, which Ensync does not edit.`)
  }

  const managed = new Set(managedNames)
  const wanted = new Map(Object.entries(sections ?? {}))
  const lines = source.split('\n')

  // Group the file into blocks: leading text, then one block per table header.
  const blocks = []
  let current = { name: null, lines: [] }
  for (const line of lines) {
    if (isAnyTableHeader(line)) {
      blocks.push(current)
      current = { name: tomlHeaderName(line, table), lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  blocks.push(current)

  const existing = new Set(blocks.map((block) => block.name).filter(Boolean))
  const conflicts = [...wanted.keys()].filter((name) => existing.has(name) && !managed.has(name))
  const removable = new Set([...managed].filter((name) => existing.has(name)))

  let changed = false
  const kept = []
  for (const block of blocks) {
    if (block.name && removable.has(block.name)) {
      changed = true
      continue
    }
    kept.push(block.lines.join('\n'))
  }

  let output = kept.join('\n')
  const appended = []
  for (const [name, section] of wanted) {
    if (conflicts.includes(name)) continue
    appended.push(section)
    changed = true
  }

  if (appended.length > 0) {
    output = output.replace(/\s+$/, '')
    output = output.length > 0 ? `${output}\n\n${appended.join('\n')}` : appended.join('\n')
  } else if (changed) {
    output = `${output.replace(/\s+$/, '')}\n`
    if (output === '\n') output = ''
  }

  // A rewrite of identical content is not a change.
  if (changed && output === source) changed = false

  return {
    content: output,
    managedNames: [...wanted.keys()].filter((name) => !conflicts.includes(name)),
    conflicts,
    changed,
  }
}
