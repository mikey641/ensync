import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/i
const BUILD_ID_PATTERN = /^[a-f0-9]{16}$/
const CHANNELS = new Set(['dev', 'beta', 'stable'])

function validIsoDate(value) {
  return typeof value === 'string' && value.length >= 20 && !Number.isNaN(Date.parse(value))
}

function canonicalBuildInput({ appVersion, channel, sourceCommit, sourceDirty, builtAt }) {
  return JSON.stringify({ appVersion, channel, sourceCommit, sourceDirty, builtAt })
}

export function createBuildInfo({ appVersion, channel, sourceCommit, sourceDirty, builtAt }) {
  if (typeof appVersion !== 'string' || !appVersion.trim()) throw new TypeError('A build version is required.')
  if (!CHANNELS.has(channel)) throw new TypeError('The build channel must be dev, beta, or stable.')
  if (typeof sourceCommit !== 'string' || !SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
    throw new TypeError('The exact source commit is required.')
  }
  if (typeof sourceDirty !== 'boolean') throw new TypeError('The source dirty flag is required.')
  if (!validIsoDate(builtAt)) throw new TypeError('A valid build time is required.')
  const normalized = {
    appVersion: appVersion.trim(),
    channel,
    sourceCommit: sourceCommit.toLowerCase(),
    sourceDirty,
    builtAt: new Date(builtAt).toISOString(),
  }
  return Object.freeze({
    schemaVersion: 1,
    buildId: createHash('sha256').update(canonicalBuildInput(normalized)).digest('hex').slice(0, 16),
    ...normalized,
  })
}

export function normalizeBuildInfo(value, { expectedVersion = null } = {}) {
  if (!value || value.schemaVersion !== 1 || !BUILD_ID_PATTERN.test(value.buildId ?? '')) return null
  try {
    const normalized = createBuildInfo(value)
    if (normalized.buildId !== value.buildId) return null
    if (expectedVersion !== null && normalized.appVersion !== expectedVersion) return null
    return normalized
  } catch {
    return null
  }
}

export function readBuildInfoFile(filePath, options = {}) {
  try {
    return normalizeBuildInfo(JSON.parse(readFileSync(filePath, 'utf8')), options)
  } catch {
    return null
  }
}
