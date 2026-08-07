import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { cleanOutput, commandInvocation, subscriptionEnvironment } from './command.mjs'

const REQUEST_IDS = new Set([1, 2, 3])

function asPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null
}

function resetIso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const date = new Date(value * 1_000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function modelCatalog(result) {
  if (!Array.isArray(result?.data)) return []
  const seen = new Set()
  return result.data.flatMap((item) => {
    const id = typeof item?.model === 'string' && item.model.trim()
      ? item.model.trim()
      : typeof item?.id === 'string' && item.id.trim()
        ? item.id.trim()
        : null
    if (!id || seen.has(id) || item.hidden === true) return []
    seen.add(id)
    return [{
      id,
      displayName: typeof item.displayName === 'string' && item.displayName.trim()
        ? item.displayName.trim()
        : id,
      isDefault: item.isDefault === true,
    }]
  })
}

function rateLimitBucket(result) {
  const byId = result?.rateLimitsByLimitId
  if (byId && typeof byId === 'object') {
    if (byId.codex && typeof byId.codex === 'object') return byId.codex
    const first = Object.values(byId).find((item) => item && typeof item === 'object')
    if (first) return first
  }
  return result?.rateLimits && typeof result.rateLimits === 'object' ? result.rateLimits : null
}

function quotaWindowLabel(windowDurationMins, name) {
  if (windowDurationMins === 10_080) return 'Weekly'
  if (windowDurationMins === 1_440) return 'Daily'
  if (windowDurationMins === 300) return '5-hour'
  if (windowDurationMins === 60) return 'Hourly'
  if (typeof windowDurationMins === 'number' && Number.isFinite(windowDurationMins)) {
    return `${windowDurationMins.toLocaleString('en-US')}-minute`
  }
  return name === 'secondary' ? 'Secondary' : 'Primary'
}

function rateLimitEntries(result) {
  const byId = result?.rateLimitsByLimitId
  if (byId && typeof byId === 'object') {
    return Object.entries(byId).flatMap(([id, value]) => value && typeof value === 'object'
      ? [{ id, value }]
      : [])
  }
  const bucket = result?.rateLimits
  return bucket && typeof bucket === 'object'
    ? [{ id: typeof bucket.limitId === 'string' && bucket.limitId ? bucket.limitId : 'codex', value: bucket }]
    : []
}

function exactCredits(bucket) {
  const credits = bucket?.credits
  if (!credits || typeof credits !== 'object') return null
  if (credits.unlimited === true) return 'Unlimited'
  if (typeof credits.balance === 'string' && credits.balance.trim()) return credits.balance.trim()
  if (typeof credits.balance === 'number' && Number.isFinite(credits.balance)) return String(credits.balance)
  if (credits.hasCredits === false) return '0'
  return null
}

export function parseCodexAppServerProbe(responses, checkedAt = new Date().toISOString()) {
  const account = responses?.[1]?.result?.account
  const rateResult = responses?.[2]?.result
  const models = modelCatalog(responses?.[3]?.result)
  const bucket = rateLimitBucket(rateResult)
  const windows = [
    { name: 'primary', value: bucket?.primary },
    { name: 'secondary', value: bucket?.secondary },
  ].flatMap(({ name, value }) => {
    const usedPercent = asPercent(value?.usedPercent)
    return usedPercent === null ? [] : [{
      name,
      usedPercent,
      resetAt: resetIso(value?.resetsAt),
      windowDurationMins: typeof value?.windowDurationMins === 'number' ? value.windowDurationMins : null,
    }]
  })
  const limitingWindow = windows.sort((left, right) => right.usedPercent - left.usedPercent)[0] ?? null
  const defaultModel = models.find((model) => model.isDefault)?.id ?? null
  const plan = typeof account?.planType === 'string' && account.planType.trim()
    ? account.planType.trim()
    : typeof bucket?.planType === 'string' && bucket.planType.trim()
      ? bucket.planType.trim()
      : null

  if (!limitingWindow && !defaultModel && !plan) return null

  const windowLabel = limitingWindow?.windowDurationMins
    ? `${limitingWindow.windowDurationMins}-minute window`
    : `${limitingWindow?.name ?? 'current'} window`
  const details = []
  if (limitingWindow) {
    details.push(
      { label: 'Quota type', value: 'Subscription quota' },
      { label: 'Current window', value: quotaWindowLabel(limitingWindow.windowDurationMins, limitingWindow.name) },
      { label: 'Remaining', value: `${Math.max(0, 100 - limitingWindow.usedPercent)}%` },
      { label: 'Used', value: `${limitingWindow.usedPercent}%` },
    )
  }
  for (const { id, value } of rateLimitEntries(rateResult)) {
    if (id === 'codex') continue
    const quotaName = typeof value.limitName === 'string' && value.limitName.trim()
      ? value.limitName.trim()
      : id
    for (const name of ['primary', 'secondary']) {
      const window = value[name]
      const usedPercent = asPercent(window?.usedPercent)
      if (usedPercent === null) continue
      details.push({
        label: `${quotaName} · ${quotaWindowLabel(window?.windowDurationMins, name)}`,
        value: `${Math.max(0, 100 - usedPercent)}% remaining · ${usedPercent}% used`,
      })
    }
  }
  const credits = exactCredits(bucket)
  if (credits !== null) details.push({ label: 'Credits', value: credits })
  return {
    usage: {
      availability: limitingWindow ? 'partial' : 'unavailable',
      source: 'cli',
      kind: 'subscription_quota',
      plan,
      model: defaultModel,
      usedPercent: limitingWindow?.usedPercent ?? null,
      remainingPercent: limitingWindow ? Math.max(0, 100 - limitingWindow.usedPercent) : null,
      resetAt: limitingWindow?.resetAt ?? null,
      checkedAt,
      details,
      reason: limitingWindow
        ? `Codex app-server reported exact ChatGPT usage for the most-used ${windowLabel}.`
        : 'Codex app-server reported account or model data, but no rate-limit percentage.',
    },
    models,
  }
}

export function probeCodexAppServer(executable, options = {}) {
  const timeoutMs = options.timeoutMs ?? 6_000
  const env = options.env ?? subscriptionEnvironment()
  const invocation = commandInvocation(executable, ['app-server'], env)

  return new Promise((resolve) => {
    const child = spawn(invocation.executable, invocation.args, {
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const responses = {}
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (extra = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ responses, stderr: cleanOutput(stderr), timedOut, ...extra })
    }
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const reader = createInterface({ input: child.stdout })

    reader.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (typeof message.id === 'number') responses[message.id] = message
      if (message.id === 0 && message.result) {
        send({ method: 'initialized', params: {} })
        send({ method: 'account/read', id: 1, params: { refreshToken: false } })
        send({ method: 'account/rateLimits/read', id: 2 })
        send({ method: 'model/list', id: 3, params: { limit: 100, includeHidden: false } })
      }
      if ([...REQUEST_IDS].every((id) => responses[id])) child.stdin.end()
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(0, 256 * 1024)
    })
    child.on('error', (error) => finish({ exitCode: null, error: error.message }))
    child.on('close', (exitCode, signal) => finish({ exitCode, signal, error: null }))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref()
    }, timeoutMs)
    timer.unref()

    send({
      method: 'initialize',
      id: 0,
      params: { clientInfo: { name: 'ensync', title: 'Ensync', version: '0.1.0' } },
    })
  })
}
