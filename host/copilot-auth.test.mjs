import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import {
  parseCopilotAuthenticationStatus,
  probeCopilotAuthentication,
} from './copilot-auth.mjs'

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ])
}

function requestFromFrame(chunk) {
  const separator = chunk.indexOf('\r\n\r\n')
  return JSON.parse(chunk.subarray(separator + 4).toString('utf8'))
}

function fakeSpawn(onRequest) {
  return (_executable, _args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        onRequest(requestFromFrame(chunk), child, options)
        callback()
      },
    })
    child.kill = () => {
      queueMicrotask(() => child.emit('close', 0, null))
      return true
    }
    return child
  }
}

test('Copilot SDK auth probe proves the stored user account without creating a session', async () => {
  const methods = []
  let spawnedOptions
  const result = await probeCopilotAuthentication('/verified/copilot', '2026-08-06T12:00:00.000Z', {
    env: {
      PATH: '/bin',
      COPILOT_GITHUB_TOKEN: 'excluded',
      GH_TOKEN: 'excluded',
      GITHUB_TOKEN: 'excluded',
      ENSYNC_SAFE_VALUE: 'kept',
    },
    spawnProcess: fakeSpawn((request, child, options) => {
      methods.push(request.method)
      spawnedOptions = options
      if (request.method === 'connect') {
        child.stdout.write(frame({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 3 } }))
      } else if (request.method === 'auth.getStatus') {
        child.stdout.write(frame({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            isAuthenticated: true,
            authType: 'user',
            host: 'https://github.com',
            login: 'mikey641',
          },
        }))
      }
    }),
  })

  assert.deepEqual(methods, ['connect', 'auth.getStatus'])
  assert.equal(result.state, 'authenticated')
  assert.equal(result.accountLogin, 'mikey641')
  assert.equal(result.method, 'GitHub OAuth')
  assert.equal(spawnedOptions.env.ENSYNC_SAFE_VALUE, 'kept')
  assert.equal(spawnedOptions.env.COPILOT_GITHUB_TOKEN, undefined)
  assert.equal(spawnedOptions.env.GH_TOKEN, undefined)
  assert.equal(spawnedOptions.env.GITHUB_TOKEN, undefined)
})

test('Copilot SDK auth probe reports an explicit signed-out account', async () => {
  const result = await probeCopilotAuthentication('/verified/copilot', undefined, {
    spawnProcess: fakeSpawn((request, child) => {
      child.stdout.write(frame(request.method === 'connect'
        ? { jsonrpc: '2.0', id: request.id, result: { protocolVersion: 2 } }
        : { jsonrpc: '2.0', id: request.id, result: { isAuthenticated: false } }))
    }),
  })

  assert.equal(result.state, 'not_authenticated')
  assert.equal(result.accountLogin, null)
})

test('Copilot SDK auth probe rejects unsupported protocol versions', async () => {
  const result = await probeCopilotAuthentication('/verified/copilot', undefined, {
    spawnProcess: fakeSpawn((request, child) => {
      child.stdout.write(frame({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 99 } }))
    }),
  })

  assert.equal(result.state, 'unavailable')
  assert.match(result.reason, /unsupported SDK protocol/i)
})

test('Copilot SDK auth probe rejects malformed responses', async () => {
  const result = await probeCopilotAuthentication('/verified/copilot', undefined, {
    spawnProcess: fakeSpawn((_request, child) => {
      child.stdout.write(Buffer.from('Content-Length: 5\r\n\r\nnope!', 'utf8'))
    }),
  })

  assert.equal(result.state, 'unavailable')
  assert.match(result.reason, /malformed JSON/i)
})

test('Copilot SDK auth probe is bounded by a timeout', async () => {
  const result = await probeCopilotAuthentication('/verified/copilot', undefined, {
    timeoutMs: 5,
    spawnProcess: fakeSpawn(() => {}),
  })

  assert.equal(result.state, 'unavailable')
  assert.match(result.reason, /timed out/i)
})

test('Copilot account proof does not accept token or generic GitHub CLI authentication', () => {
  for (const authType of ['env', 'gh-cli', 'api-key', 'token']) {
    const result = parseCopilotAuthenticationStatus({
      isAuthenticated: true,
      authType,
      login: 'not-proof',
    })
    assert.equal(result.state, 'unavailable')
  }
})
