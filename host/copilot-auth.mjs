import { spawn } from 'node:child_process'
import { commandInvocation, subscriptionEnvironment } from './command.mjs'

const MAX_FRAME_BYTES = 64 * 1024
const MIN_PROTOCOL_VERSION = 2
const MAX_PROTOCOL_VERSION = 3
const TOKEN_AUTH_ENVIRONMENT_KEYS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]

function unavailable(reason, checkedAt) {
  return {
    state: 'unavailable',
    method: null,
    accountLogin: null,
    reason,
    source: 'cli',
    checkedAt,
    exactPlan: null,
  }
}

function rpcFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ])
}

function safeLogin(value) {
  if (typeof value !== 'string') return null
  const login = value.trim()
  if (!login || login.length > 100 || /[\u0000-\u001f\u007f]/.test(login)) return null
  return login
}

export function parseCopilotAuthenticationStatus(status, checkedAt = new Date().toISOString()) {
  if (!status || typeof status !== 'object' || Array.isArray(status)
    || typeof status.isAuthenticated !== 'boolean') {
    return unavailable('Copilot returned no recognized authentication status.', checkedAt)
  }

  if (!status.isAuthenticated) {
    return {
      state: 'not_authenticated',
      method: null,
      accountLogin: null,
      reason: 'Copilot CLI reports that it is not signed in.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }

  if (status.authType !== 'user') {
    return unavailable(
      'Copilot is authenticated through a token or another GitHub client, not a verified Copilot user login.',
      checkedAt,
    )
  }

  const login = safeLogin(status.login)
  if (!login) {
    return unavailable('Copilot confirmed authentication but did not identify the signed-in account.', checkedAt)
  }

  return {
    state: 'authenticated',
    method: 'GitHub OAuth',
    accountLogin: login,
    reason: `Signed in as ${login}.`,
    source: 'cli',
    checkedAt,
    exactPlan: null,
  }
}

function copilotUserEnvironment(source) {
  const env = subscriptionEnvironment(source)
  for (const key of TOKEN_AUTH_ENVIRONMENT_KEYS) delete env[key]
  return env
}

export function probeCopilotAuthentication(executable, checkedAt = new Date().toISOString(), options = {}) {
  const timeoutMs = options.timeoutMs ?? 8_000
  const env = copilotUserEnvironment(options.env ?? process.env)
  const spawnProcess = options.spawnProcess ?? spawn
  const invocation = commandInvocation(
    executable,
    ['--headless', '--no-auto-update', '--stdio', '--log-level', 'none'],
    env,
  )

  return new Promise((resolve) => {
    let child
    let buffer = Buffer.alloc(0)
    let settled = false
    let nextRequest = 'connect'

    const stopChild = () => {
      try {
        child?.stdin?.end()
      } catch {
        // The runtime may already have closed its input after a protocol error.
      }
      try {
        child?.kill()
      } catch {
        // A completed authentication result remains authoritative.
      }
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stopChild()
      resolve(result)
    }

    const fail = (reason) => finish(unavailable(reason, checkedAt))

    const writeRequest = (id, method) => {
      try {
        child.stdin.write(rpcFrame({ jsonrpc: '2.0', id, method, params: {} }))
      } catch {
        fail('Copilot authentication status could not be requested.')
      }
    }

    const handleMessage = (message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        fail('Copilot returned a malformed authentication response.')
        return
      }

      if (nextRequest === 'connect' && message.id === 1) {
        const protocolVersion = message.result?.protocolVersion
        if (!Number.isInteger(protocolVersion)
          || protocolVersion < MIN_PROTOCOL_VERSION
          || protocolVersion > MAX_PROTOCOL_VERSION) {
          fail('Copilot CLI uses an unsupported SDK protocol version. Update Copilot CLI and Ensync.')
          return
        }
        nextRequest = 'authentication'
        writeRequest(2, 'auth.getStatus')
        return
      }

      if (nextRequest === 'authentication' && message.id === 2) {
        if (message.error) {
          fail('Copilot could not return its authentication status.')
          return
        }
        finish(parseCopilotAuthenticationStatus(message.result, checkedAt))
      }
    }

    const readFrames = (chunk) => {
      if (settled) return
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_FRAME_BYTES * 2) {
        fail('Copilot returned an oversized authentication response.')
        return
      }

      while (!settled) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = buffer.subarray(0, headerEnd).toString('ascii')
        const lengthMatch = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i)
        if (!lengthMatch) {
          fail('Copilot returned a malformed SDK response.')
          return
        }
        const contentLength = Number(lengthMatch[1])
        if (!Number.isSafeInteger(contentLength) || contentLength < 2 || contentLength > MAX_FRAME_BYTES) {
          fail('Copilot returned an invalid authentication response size.')
          return
        }
        const bodyStart = headerEnd + 4
        if (buffer.length < bodyStart + contentLength) return
        const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8')
        buffer = buffer.subarray(bodyStart + contentLength)
        try {
          handleMessage(JSON.parse(body))
        } catch {
          fail('Copilot returned malformed JSON for its authentication status.')
        }
      }
    }

    const timer = setTimeout(() => {
      fail('Copilot authentication check timed out.')
    }, timeoutMs)

    try {
      child = spawnProcess(invocation.executable, invocation.args, {
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stdout.on('data', readFrames)
      child.stderr.on('data', () => {
        // Authentication is accepted only from the bounded JSON-RPC response.
      })
      child.on('error', () => fail('Copilot authentication check could not be started.'))
      child.on('close', () => {
        if (!settled) fail('Copilot closed before returning its authentication status.')
      })
      child.stdin.on('error', () => {
        if (!settled) fail('Copilot closed before accepting the authentication request.')
      })
      writeRequest(1, 'connect')
    } catch {
      fail('Copilot authentication check could not be started.')
    }
  })
}
