import assert from 'node:assert/strict'
import test from 'node:test'

import { funnelUrlFromStatus } from './tailscale-funnel.mjs'

const status = {
  Web: {
    'mac.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8123' } } },
    'mac.tail1.ts.net:10000': { Handlers: { '/': { Proxy: 'http://127.0.0.1:43122' } } },
    'mac.tail1.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } },
  },
  AllowFunnel: { 'mac.tail1.ts.net:443': true, 'mac.tail1.ts.net:10000': true },
}

test('finds the Funnel address that proxies to the local Sync service', () => {
  assert.equal(funnelUrlFromStatus(status, 'http://127.0.0.1:43122'), 'https://mac.tail1.ts.net:10000')
})

test('omits the default port', () => {
  assert.equal(funnelUrlFromStatus(status, 'http://127.0.0.1:8123'), 'https://mac.tail1.ts.net')
})

test('ignores tailnet-only serve entries and unrelated services', () => {
  assert.equal(funnelUrlFromStatus(status, 'http://127.0.0.1:9999'), null)
  assert.equal(funnelUrlFromStatus(status, 'http://127.0.0.1:1'), null)
  assert.equal(funnelUrlFromStatus(status, 'https://sync.example.com'), null)
  assert.equal(funnelUrlFromStatus(null, 'http://127.0.0.1:43122'), null)
})
