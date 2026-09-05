import assert from 'node:assert/strict'
import test from 'node:test'

import { VercelDeploymentAdapter } from './deployment-adapters.mjs'

const SHA = 'a'.repeat(40)

test('Vercel delivery lookup certifies only the exact production commit', async () => {
  const calls = []
  const adapter = new VercelDeploymentAdapter({
    home: '/home/test',
    platform: 'linux',
    readFile: async (path) => path.endsWith('.vercel/project.json')
      ? JSON.stringify({ projectId: 'project-1', orgId: 'team-1' })
      : JSON.stringify({ token: 'secret-token' }),
    fetch: async (url, options) => {
      calls.push({ url: String(url), authorization: options.headers.Authorization })
      return new Response(JSON.stringify({ deployments: [
        { uid: 'old', target: 'production', readyState: 'READY', meta: { githubCommitSha: 'b'.repeat(40) } },
        { uid: 'exact', target: 'production', readyState: 'BUILDING', url: 'exact.vercel.app', meta: { githubCommitSha: SHA } },
      ] }), { status: 200 })
    },
  })
  const result = await adapter.inspect({ repositoryPath: '/repo', productionCommitSha: SHA })
  assert.equal(result.state, 'building')
  assert.equal(result.deploymentId, 'exact')
  assert.equal(result.deploymentUrl, 'https://exact.vercel.app')
  assert.equal(calls[0].authorization, 'Bearer secret-token')
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
})

test('Vercel failure output is captured without returning credentials', async () => {
  const adapter = new VercelDeploymentAdapter({
    env: { VERCEL_TOKEN: 'secret-token' },
    readFile: async () => JSON.stringify({ projectId: 'project-1' }),
    fetch: async (url) => String(url).includes('/events?')
      ? new Response(JSON.stringify([{ text: 'schema missing' }, { text: 'build exited 1' }]), { status: 200 })
      : new Response(JSON.stringify({ deployments: [{
          uid: 'failed', target: 'production', readyState: 'ERROR', errorCode: 'BUILD_FAILED', meta: { githubCommitSha: SHA },
        }] }), { status: 200 }),
  })
  const result = await adapter.inspect({ repositoryPath: '/repo', productionCommitSha: SHA })
  assert.equal(result.state, 'failed')
  assert.match(result.failureLog, /schema missing/)
  assert.equal(JSON.stringify(result).includes('secret-token'), false)
})

test('Vercel delivery lookup silently refreshes an expired CLI session and persists the rotation', async () => {
  const writes = []
  const calls = []
  const adapter = new VercelDeploymentAdapter({
    home: '/home/test',
    platform: 'linux',
    now: () => 2_000_000,
    readFile: async (path) => path.endsWith('.vercel/project.json')
      ? JSON.stringify({ projectId: 'project-1', orgId: 'team-1' })
      : JSON.stringify({ token: 'expired-token', refreshToken: 'refresh-token', expiresAt: 1_999 }),
    writeFile: async (path, contents, options) => writes.push({ path, contents, options }),
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), authorization: options.headers?.Authorization, body: String(options.body ?? '') })
      if (String(url).endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify({ token_endpoint: 'https://vercel.com/oauth/token' }), { status: 200 })
      }
      if (String(url) === 'https://vercel.com/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'fresh-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 28_800,
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ deployments: [{
        uid: 'exact', target: 'production', readyState: 'READY', meta: { githubCommitSha: SHA },
      }] }), { status: 200 })
    },
  })
  const result = await adapter.inspect({ repositoryPath: '/repo', productionCommitSha: SHA })
  assert.equal(result.state, 'ready')
  assert.equal(calls.at(-1).authorization, 'Bearer fresh-token')
  assert.match(calls[1].body, /grant_type=refresh_token/)
  assert.equal(writes.length, 1)
  const persisted = JSON.parse(writes[0].contents)
  assert.equal(persisted.token, 'fresh-token')
  assert.equal(persisted.refreshToken, 'rotated-refresh-token')
  assert.equal(persisted.expiresAt, 30_800)
  assert.equal(writes[0].options.mode, 0o600)
})

test('Vercel delivery lookup tries the stored CLI session when an environment token is rejected', async () => {
  const authorizations = []
  const adapter = new VercelDeploymentAdapter({
    home: '/home/test',
    platform: 'linux',
    env: { VERCEL_TOKEN: 'rejected-environment-token' },
    readFile: async (path) => path.endsWith('.vercel/project.json')
      ? JSON.stringify({ projectId: 'project-1' })
      : JSON.stringify({ token: 'working-stored-token' }),
    fetch: async (_url, options) => {
      authorizations.push(options.headers.Authorization)
      return options.headers.Authorization === 'Bearer rejected-environment-token'
        ? new Response(JSON.stringify({ error: { code: 'forbidden' } }), { status: 403 })
        : new Response(JSON.stringify({ deployments: [{
            uid: 'exact', target: 'production', readyState: 'READY', meta: { githubCommitSha: SHA },
          }] }), { status: 200 })
    },
  })
  const result = await adapter.inspect({ repositoryPath: '/repo', productionCommitSha: SHA })
  assert.equal(result.state, 'ready')
  assert.deepEqual(authorizations, ['Bearer rejected-environment-token', 'Bearer working-stored-token'])
})
