import { spawn } from 'node:child_process'
import { commandInvocation, subscriptionEnvironment } from './command.mjs'

// The Copilot CLI, running as an SDK server over stdio, exposes the account's
// AI-credit quota through the `account.getQuota` RPC (verified live on this
// machine). It is a server-side billing read: it creates no session, sends no
// prompt, and consumes no model turn. The relevant bucket for the Copilot CLI
// agent is `chat`; `completions` is IDE code completion and `premium_interactions`
// is the legacy premium-request bucket, so only `chat` drives the percentage.
const MAX_FRAME_BYTES = 64 * 1024
const MIN_PROTOCOL_VERSION = 2
const MAX_PROTOCOL_VERSION = 3
const TOKEN_AUTH_ENVIRONMENT_KEYS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]

function finitePercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null
  return value
}

function rounded(value) {
  return Math.round(value * 100) / 100
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value))
}

function usedRequestsLabel(snapshot) {
  if (snapshot.isUnlimitedEntitlement === true || snapshot.entitlementRequests === -1) {
    return 'Unlimited entitlement'
  }
  const used = snapshot.usedRequests
  const entitled = snapshot.entitlementRequests
  if (Number.isFinite(used) && Number.isFinite(entitled) && entitled >= 0) {
    return `${used} of ${entitled}`
  }
  return null
}

export function parseCopilotQuota(result, checkedAt = new Date().toISOString()) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const snapshots = result.quotaSnapshots
  if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)) return null
  const chat = snapshots.chat
  if (!chat || typeof chat !== 'object' || Array.isArray(chat)) return null

  const remaining = finitePercent(chat.remainingPercentage)
  if (remaining === null) return null
  const remainingPercent = clampPercent(rounded(remaining))
  const usedPercent = clampPercent(rounded(100 - remaining))

  const details = [
    { label: 'Quota type', value: 'Copilot agent credits (chat)' },
    { label: 'Remaining', value: `${remainingPercent}%` },
    { label: 'Used', value: usedRequestsLabel(chat) ?? 'Not reported' },
  ]
  if (chat.overageAllowedWithExhaustedQuota === true || chat.usageAllowedWithExhaustedQuota === true) {
    details.push({ label: 'Overage', value: 'Usage may continue past the allowance' })
  }

  return {
    availability: 'partial',
    source: 'cli',
    kind: 'subscription_quota',
    plan: null,
    model: null,
    usedPercent,
    remainingPercent,
    // `resetDate` is supplied by the SDK, but live probes return a timestamp
    // that tracks the snapshot instead of a fixed future reset. It is left
    // unreported so the card's "resets …" meter never claims a bogus schedule.
    resetAt: null,
    checkedAt,
    details,
    reason: `Copilot reported ${remainingPercent}% of this period's agent-credit (chat) quota remaining.`,
  }
}

function copilotUserEnvironment(source) {
  const env = subscriptionEnvironment(source)
  for (const key of TOKEN_AUTH_ENVIRONMENT_KEYS) delete env[key]
  return env
}

function rpcFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ])
}

export function probeCopilotUsage(executable, checkedAt = new Date().toISOString(), options = {}) {
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
      try { child?.stdin?.end() } catch { /* already closed */ }
      try { child?.kill() } catch { /* already exited */ }
    }

    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stopChild()
      resolve(null)
    }

    const writeRequest = (id, method) => {
      try { child.stdin.write(rpcFrame({ jsonrpc: '2.0', id, method, params: {} })) } catch { fail() }
    }

    const handleMessage = (message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) { fail(); return }
      if (nextRequest === 'connect' && message.id === 1) {
        const protocolVersion = message.result?.protocolVersion
        if (!Number.isInteger(protocolVersion)
          || protocolVersion < MIN_PROTOCOL_VERSION
          || protocolVersion > MAX_PROTOCOL_VERSION) {
          fail()
          return
        }
        nextRequest = 'quota'
        writeRequest(2, 'account.getQuota')
        return
      }
      if (nextRequest === 'quota' && message.id === 2) {
        if (message.error || message.result == null) { fail(); return }
        settled = true
        clearTimeout(timer)
        stopChild()
        resolve(parseCopilotQuota(message.result, checkedAt))
      }
    }

    const readFrames = (chunk) => {
      if (settled) return
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_FRAME_BYTES * 2) { fail(); return }
      while (!settled) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = buffer.subarray(0, headerEnd).toString('ascii')
        const lengthMatch = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i)
        if (!lengthMatch) { fail(); return }
        const contentLength = Number(lengthMatch[1])
        if (!Number.isSafeInteger(contentLength) || contentLength < 2 || contentLength > MAX_FRAME_BYTES) { fail(); return }
        const bodyStart = headerEnd + 4
        if (buffer.length < bodyStart + contentLength) return
        const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8')
        buffer = buffer.subarray(bodyStart + contentLength)
        try { handleMessage(JSON.parse(body)) } catch { fail(); return }
      }
    }

    const timer = setTimeout(fail, timeoutMs)

    try {
      child = spawnProcess(invocation.executable, invocation.args, {
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stdout.on('data', readFrames)
      child.stderr.on('data', () => { /* quota accepted only from the bounded JSON-RPC response */ })
      child.on('error', fail)
      child.on('close', fail)
      child.stdin.on('error', fail)
      writeRequest(1, 'connect')
    } catch {
      fail()
    }
  })
}
