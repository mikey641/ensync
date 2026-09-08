import assert from 'node:assert/strict'
import test from 'node:test'

import {
  McpConfigParseError,
  mergeJsonMcpConfig,
  mergeTomlMcpConfig,
  tomlMcpServerSection,
  tomlString,
} from './mcp-config-writers.mjs'

test('JSON merge creates the container in an empty file', () => {
  const result = mergeJsonMcpConfig({
    content: '',
    keyPath: ['mcpServers'],
    entries: { github: { command: 'npx', args: ['-y', 'github-mcp'] } },
  })
  assert.deepEqual(JSON.parse(result.content), {
    mcpServers: { github: { command: 'npx', args: ['-y', 'github-mcp'] } },
  })
  assert.deepEqual(result.managedNames, ['github'])
  assert.deepEqual(result.conflicts, [])
  assert.equal(result.changed, true)
  assert.ok(result.content.endsWith('\n'))
})

test('JSON merge preserves unrelated keys and nested key paths', () => {
  const content = JSON.stringify({
    theme: 'dark',
    projects: { '/a': { allowedTools: ['Bash'] } },
    amp: { permissions: ['x'] },
  })
  const result = mergeJsonMcpConfig({
    content,
    keyPath: ['amp', 'mcpServers'],
    entries: { linear: { url: 'https://mcp.linear.app/sse' } },
  })
  assert.deepEqual(JSON.parse(result.content), {
    theme: 'dark',
    projects: { '/a': { allowedTools: ['Bash'] } },
    amp: { permissions: ['x'], mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } } },
  })
})

test('JSON merge never overwrites a same-named server Ensync did not write', () => {
  const content = JSON.stringify({ mcpServers: { github: { command: 'my-own-github' } } })
  const result = mergeJsonMcpConfig({
    content,
    keyPath: ['mcpServers'],
    entries: { github: { command: 'npx' } },
    managedNames: [],
  })
  assert.deepEqual(JSON.parse(result.content).mcpServers.github, { command: 'my-own-github' })
  assert.deepEqual(result.conflicts, ['github'])
  assert.deepEqual(result.managedNames, [])
  assert.equal(result.changed, false)
})

test('JSON merge rewrites and removes only managed names', () => {
  const content = JSON.stringify({
    mcpServers: {
      github: { command: 'old' },
      stale: { command: 'gone' },
      mine: { command: 'user-owned' },
    },
  })
  const result = mergeJsonMcpConfig({
    content,
    keyPath: ['mcpServers'],
    entries: { github: { command: 'new' } },
    managedNames: ['github', 'stale', 'mine-but-not-present'],
  })
  assert.deepEqual(JSON.parse(result.content).mcpServers, {
    github: { command: 'new' },
    mine: { command: 'user-owned' },
  })
  assert.deepEqual(result.managedNames, ['github'])
  assert.equal(result.changed, true)
})

test('JSON merge reports no change when content is already current', () => {
  const content = JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['a'] } } })
  const result = mergeJsonMcpConfig({
    content,
    keyPath: ['mcpServers'],
    entries: { github: { command: 'npx', args: ['a'] } },
    managedNames: ['github'],
  })
  assert.equal(result.changed, false)
})

test('JSON merge refuses invalid JSON and wrong container types', () => {
  assert.throws(
    () => mergeJsonMcpConfig({ content: '{ not json', keyPath: ['mcpServers'], entries: {} }),
    McpConfigParseError,
  )
  assert.throws(
    () => mergeJsonMcpConfig({ content: '[]', keyPath: ['mcpServers'], entries: {} }),
    McpConfigParseError,
  )
  assert.throws(
    () => mergeJsonMcpConfig({ content: '{"mcpServers": "nope"}', keyPath: ['mcpServers'], entries: {} }),
    McpConfigParseError,
  )
})

test('JSON merge handles array-shaped server lists keyed by name', () => {
  const content = JSON.stringify({
    mcpServers: [
      { name: 'mine', command: 'user' },
      { name: 'github', command: 'old' },
      { name: 'stale', command: 'gone' },
    ],
  })
  const result = mergeJsonMcpConfig({
    content,
    keyPath: ['mcpServers'],
    shape: 'array',
    entries: {
      github: { name: 'github', command: 'new' },
      mine: { name: 'mine', command: 'ensync' },
      fresh: { name: 'fresh', command: 'added' },
    },
    managedNames: ['github', 'stale'],
  })
  assert.deepEqual(JSON.parse(result.content).mcpServers, [
    { name: 'mine', command: 'user' },
    { name: 'github', command: 'new' },
    { name: 'fresh', command: 'added' },
  ])
  assert.deepEqual(result.conflicts, ['mine'])
  assert.deepEqual(result.managedNames.sort(), ['fresh', 'github'])
})

test('TOML strings escape quotes, backslashes, and control characters', () => {
  assert.equal(tomlString('plain'), '"plain"')
  assert.equal(tomlString('say "hi" \\ now'), '"say \\"hi\\" \\\\ now"')
  assert.equal(tomlString('a\nb\tc'), '"a\\nb\\tc\\u0001"')
})

test('TOML section renders scalars, arrays, and nested sub-tables', () => {
  const section = tomlMcpServerSection({
    table: 'mcp_servers',
    name: 'github',
    fields: { command: 'npx', args: ['-y', 'github-mcp'], enabled: true, skipped: null },
    subTables: { env: { GITHUB_TOKEN: 'abc', 'weird key': 'x' }, http_headers: {} },
  })
  assert.equal(section, [
    '[mcp_servers.github]',
    'command = "npx"',
    'args = ["-y", "github-mcp"]',
    'enabled = true',
    '',
    '[mcp_servers.github.env]',
    'GITHUB_TOKEN = "abc"',
    '"weird key" = "x"',
    '',
  ].join('\n'))
})

test('TOML merge appends sections to an existing file and keeps other tables', () => {
  const content = [
    '# my codex config',
    'model = "gpt-5"',
    '',
    '[sandbox_workspace_write]',
    'network_access = true',
    '',
  ].join('\n')
  const result = mergeTomlMcpConfig({
    content,
    sections: {
      github: tomlMcpServerSection({ table: 'mcp_servers', name: 'github', fields: { command: 'npx' } }),
    },
  })
  assert.equal(result.content, [
    '# my codex config',
    'model = "gpt-5"',
    '',
    '[sandbox_workspace_write]',
    'network_access = true',
    '',
    '[mcp_servers.github]',
    'command = "npx"',
    '',
  ].join('\n'))
  assert.deepEqual(result.managedNames, ['github'])
  assert.equal(result.changed, true)
})

test('TOML merge replaces managed sections including their sub-tables and removes stale ones', () => {
  const content = [
    'model = "gpt-5"',
    '',
    '[mcp_servers.github]',
    'command = "old"',
    '',
    '[mcp_servers.github.env]',
    'TOKEN = "x"',
    '',
    '[mcp_servers.stale]',
    'command = "gone"',
    '',
    '[mcp_servers.mine]',
    'command = "user-owned"',
    '',
    '[projects."/tmp/a"]',
    'trust_level = "trusted"',
    '',
  ].join('\n')
  const result = mergeTomlMcpConfig({
    content,
    sections: {
      github: tomlMcpServerSection({ table: 'mcp_servers', name: 'github', fields: { command: 'new' } }),
      mine: tomlMcpServerSection({ table: 'mcp_servers', name: 'mine', fields: { command: 'ensync' } }),
    },
    managedNames: ['github', 'stale'],
  })
  assert.equal(result.content, [
    'model = "gpt-5"',
    '',
    '[mcp_servers.mine]',
    'command = "user-owned"',
    '',
    '[projects."/tmp/a"]',
    'trust_level = "trusted"',
    '',
    '[mcp_servers.github]',
    'command = "new"',
    '',
  ].join('\n'))
  assert.deepEqual(result.conflicts, ['mine'])
  assert.deepEqual(result.managedNames, ['github'])
})

test('TOML merge recognizes quoted table names and is idempotent', () => {
  const content = '[mcp_servers."github"]\ncommand = "old"\n'
  const section = tomlMcpServerSection({ table: 'mcp_servers', name: 'github', fields: { command: 'new' } })
  const first = mergeTomlMcpConfig({ content, sections: { github: section }, managedNames: ['github'] })
  assert.equal(first.content, '[mcp_servers.github]\ncommand = "new"\n')
  const second = mergeTomlMcpConfig({ content: first.content, sections: { github: section }, managedNames: ['github'] })
  assert.equal(second.content, first.content)
  assert.equal(second.changed, false)
})

test('TOML merge removes every managed section when nothing remains', () => {
  const content = 'model = "gpt-5"\n\n[mcp_servers.github]\ncommand = "old"\n'
  const result = mergeTomlMcpConfig({ content, sections: {}, managedNames: ['github'] })
  assert.equal(result.content, 'model = "gpt-5"\n')
  assert.equal(result.changed, true)
})

test('TOML merge refuses inline mcp_servers tables', () => {
  assert.throws(
    () => mergeTomlMcpConfig({ content: 'mcp_servers = { github = { command = "x" } }\n', sections: {} }),
    McpConfigParseError,
  )
})
