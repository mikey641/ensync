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

