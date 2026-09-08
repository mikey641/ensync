import assert from 'node:assert/strict'
import test from 'node:test'

import { McpConfigParseError } from './mcp-config-writers.mjs'
import { parseCodexMcpServersToml, parseJsonMcpServers } from './mcp-config-readers.mjs'

test('JSON reader returns an empty list for blank or absent content', () => {
  assert.deepEqual(parseJsonMcpServers(''), [])
  assert.deepEqual(parseJsonMcpServers('   \n'), [])
  assert.deepEqual(parseJsonMcpServers('{"noServers": true}'), [])
})

test('JSON reader extracts the mcpServers map keyed by name', () => {
  const content = JSON.stringify({
    mcpServers: {
      github: { type: 'stdio', command: 'npx', args: ['-y', 'github-mcp'], env: { GITHUB_TOKEN: 'x' } },
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
    },
  })
  assert.deepEqual(parseJsonMcpServers(content), [
    { name: 'github', type: 'stdio', command: 'npx', args: ['-y', 'github-mcp'], env: { GITHUB_TOKEN: 'x' } },
    { name: 'linear', type: 'http', url: 'https://mcp.linear.app/mcp' },
  ])
})

test('JSON reader supports array-shaped server lists and skips malformed entries', () => {
  const content = JSON.stringify({
    mcpServers: [
      { name: 'github', command: 'npx' },
      { command: 'missing-name' },
      'not-an-object',
    ],
  })
  assert.deepEqual(parseJsonMcpServers(content), [{ name: 'github', command: 'npx' }])
})

test('JSON reader throws on invalid JSON and non-object roots', () => {
  assert.throws(() => parseJsonMcpServers('{ not json'), McpConfigParseError)
  assert.throws(() => parseJsonMcpServers('[1,2,3]'), McpConfigParseError)
})

test('JSON reader resolves array key paths and flat dotted keys', () => {
  const nested = JSON.stringify({ amp: { mcpServers: { github: { command: 'npx' } } } })
  assert.deepEqual(parseJsonMcpServers(nested, { key: ['amp', 'mcpServers'] }), [
    { name: 'github', command: 'npx' },
  ])

  // Amp writes a single key literally named "amp.mcpServers".
  const flat = JSON.stringify({ 'amp.mcpServers': { github: { command: 'npx' } } })
  assert.deepEqual(parseJsonMcpServers(flat, { key: ['amp.mcpServers'] }), [
    { name: 'github', command: 'npx' },
  ])
})

test('JSON reader canonicalizes provider-specific url and header field names', () => {
  const content = JSON.stringify({
    mcpServers: {
      antigravity: { serverUrl: 'https://example.com/mcp' },
      headersAndUrl: { httpUrl: 'https://x.example/sse', http_headers: { Authorization: 'Bearer t' } },
      ownHeaders: { url: 'https://y.example/mcp', headers: { 'X-K': 'v' }, http_headers: { ignored: 'v' } },
    },
  })
  assert.deepEqual(parseJsonMcpServers(content), [
    { name: 'antigravity', serverUrl: 'https://example.com/mcp', url: 'https://example.com/mcp' },
    {
      name: 'headersAndUrl',
      httpUrl: 'https://x.example/sse',
      http_headers: { Authorization: 'Bearer t' },
      url: 'https://x.example/sse',
      headers: { Authorization: 'Bearer t' },
    },
    {
      name: 'ownHeaders',
      url: 'https://y.example/mcp',
      headers: { 'X-K': 'v' },
      http_headers: { ignored: 'v' },
    },
  ])
})

test('Codex reader returns an empty list for blank content', () => {
  assert.deepEqual(parseCodexMcpServersToml(''), [])
  assert.deepEqual(parseCodexMcpServersToml('# just a comment'), [])
})

test('Codex reader parses stdio servers with env sub-tables', () => {
  const content = [
    '# network sandbox',
    'model = "gpt-5"',
    '',
    '[mcp_servers.node_repl]',
    'args = []',
    'command = "/usr/local/bin/node_repl"',
    '',
    '[mcp_servers.node_repl.env]',
    'NODE_ENV = "test"',
    'PORT = "3000"',
    '',
    '[mcp_servers.github]',
    'command = "npx"',
    'args = ["-y", "a", "b"]',
    '',
    '[mcp_servers.github.env]',
    'GITHUB_TOKEN = "secret"',
    '',
  ].join('\n')
  assert.deepEqual(parseCodexMcpServersToml(content), [
    { name: 'node_repl', command: '/usr/local/bin/node_repl', args: [], env: { NODE_ENV: 'test', PORT: '3000' } },
    { name: 'github', command: 'npx', args: ['-y', 'a', 'b'], env: { GITHUB_TOKEN: 'secret' } },
  ])
})

test('Codex reader parses remote servers with http_headers sub-tables', () => {
  const content = [
    '[mcp_servers.openaiDeveloperDocs]',
    'url = "https://developers.openai.com/mcp"',
    '',
    '[mcp_servers.linear]',
    'url = "https://mcp.linear.app/mcp"',
    '',
    '[mcp_servers.linear.http_headers]',
    'Authorization = "Bearer abc"',
    'X-Org = "ensync"',
    '',
  ].join('\n')
  assert.deepEqual(parseCodexMcpServersToml(content), [
    { name: 'openaiDeveloperDocs', url: 'https://developers.openai.com/mcp' },
    { name: 'linear', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer abc', 'X-Org': 'ensync' } },
  ])
})

test('Codex reader handles quoted names and keys, booleans, and numbers', () => {
  const content = [
    '[mcp_servers."my server"]',
    'command = "node"',
    'enabled = false',
    'retries = 3',
    '',
    '[mcp_servers."my server".env]',
    '"a b" = "c"',
    'TIMEOUT = "30"',
    '',
  ].join('\n')
  assert.deepEqual(parseCodexMcpServersToml(content), [
    {
      name: 'my server',
      command: 'node',
      enabled: false,
      env: { 'a b': 'c', TIMEOUT: '30' },
    },
  ])
})

test('Codex reader flushes multiple sections and skips tables outside mcp_servers', () => {
  const content = [
    '[shell_environment_policy.set]',
    'network_access = true',
    '',
    '[mcp_servers.first]',
    'command = "one"',
    '',
    '[other_table]',
    'command = "ignored"',
    '',
    '[mcp_servers.second]',
    'command = "two"',
    '',
  ].join('\n')
  assert.deepEqual(parseCodexMcpServersToml(content), [
    { name: 'first', command: 'one' },
    { name: 'second', command: 'two' },
  ])
})
