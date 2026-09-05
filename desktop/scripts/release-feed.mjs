import { compareVersions } from '../src/native-updates.mjs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/i
const BUILD_ID_PATTERN = /^[a-f0-9]{16}$/

export function manifestFilename(channel) {
  if (channel === 'stable') return 'releases.json'
  if (channel === 'beta') return 'releases-beta.json'
  throw new TypeError('The release channel must be stable or beta.')
}

function prerelease(version) {
  return typeof version === 'string' && version.includes('-')
}

function assertChannelVersion(channel, version) {
  if (compareVersions(version, version) !== 0) throw new Error(`Release version ${version} is invalid.`)
  if (channel === 'stable' && prerelease(version)) {
    throw new Error('The stable feed cannot point to a prerelease version.')
  }
  if (channel === 'beta' && !prerelease(version)) {
    throw new Error('The beta feed must point to an explicit prerelease version.')
  }
}

function assertHttps(value, label) {
  try {
    if (new URL(value).protocol !== 'https:') throw new Error()
  } catch {
    throw new Error(`${label} must be a verified HTTPS URL.`)
  }
}

function assertPlatform(platform, release, version) {
  if (!release || release.status !== 'available' || release.version !== version) {
    throw new Error(`${platform} does not match the verified release version ${version}.`)
  }
  if (release.signed !== true) throw new Error(`${platform} is not verified as signed.`)
  if (platform === 'macos' && release.notarized !== true) {
    throw new Error('macOS is not verified as notarized.')
  }
  assertHttps(release.url, `${platform} artifact`)
  if (!SHA256_PATTERN.test(release.sha256 ?? '')) throw new Error(`${platform} is missing a valid SHA-256 checksum.`)
  if (!BUILD_ID_PATTERN.test(release.buildId ?? '')) throw new Error(`${platform} is missing a valid build identity.`)
}

function normalizedChannel(manifest) {
  return manifest?.channel ?? 'stable'
}

function snapshot(manifest) {
  if (!manifest?.latest?.version) return null
  return {
    version: manifest.latest.version,
    publishedAt: manifest.latest.publishedAt,
    notesUrl: manifest.latest.notesUrl ?? null,
    sourceRevision: manifest.sourceRevision,
    platforms: structuredClone(manifest.platforms),
  }
}

function snapshotKey(value) {
  return `${value.version}:${value.sourceRevision}`
}

function deduplicateSnapshots(values) {
  const seen = new Set()
  return values.filter((value) => {
    if (!value) return false
    const key = snapshotKey(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function assertAvailablePlatform(platform, release, version, label) {
  if (!release || release.status !== 'available') {
    throw new Error(`${label} is missing a ${platform} release.`)
  }
  assertPlatform(platform, release, version)
}

function assertSnapshotPlatforms(value, label) {
  // macOS is the direct download feed and is always required. Windows is the
  // direct-installer fallback: a macOS-only release records it as unavailable
  // because Windows is served through the certified Microsoft Store listing.
  assertAvailablePlatform('macos', value.platforms?.macos, value.version, label)
  const windows = value.platforms?.windows
  if (windows === undefined || windows === null) return
  if (windows.status === 'unavailable') return
  assertPlatform('windows', windows, value.version)
}

function validateSnapshot(value, channel, label) {
  if (!value || typeof value !== 'object') throw new Error(`${label} is invalid.`)
  assertChannelVersion(channel, value.version)
  if (typeof value.publishedAt !== 'string' || Number.isNaN(Date.parse(value.publishedAt))) {
    throw new Error(`${label} has an invalid publication time.`)
  }
  if (value.notesUrl !== null && value.notesUrl !== undefined) assertHttps(value.notesUrl, `${label} notes`)
  if (!SOURCE_COMMIT_PATTERN.test(value.sourceRevision ?? '')) throw new Error(`${label} has an invalid source revision.`)
  assertSnapshotPlatforms(value, label)
}

export function validateChannelManifest(manifest, expectedChannel, { allowEmpty = false } = {}) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error('The release manifest is missing or unsupported.')
  if (!['stable', 'beta'].includes(expectedChannel) || normalizedChannel(manifest) !== expectedChannel) {
    throw new Error('The release manifest does not match the selected channel.')
  }
  if (!manifest.latest?.version) {
    if (!allowEmpty) throw new Error(`The ${expectedChannel} manifest has no published release.`)
    return manifest
  }
  validateSnapshot(snapshot(manifest), expectedChannel, `The ${expectedChannel} release`)
  if (manifest.history !== undefined && !Array.isArray(manifest.history)) {
    throw new Error('Release history must be an array.')
  }
  for (const [index, entry] of (manifest.history ?? []).entries()) {
    validateSnapshot(entry, expectedChannel, `Release history entry ${index + 1}`)
  }
  return manifest
}

export function prepareChannelRelease({ current, candidate, channel, updatedAt = new Date().toISOString() }) {
  validateChannelManifest(current, channel, { allowEmpty: true })
  validateChannelManifest(candidate, channel)
  const known = [snapshot(current), ...(current.history ?? [])].filter(Boolean)
  for (const previous of known) {
    if (compareVersions(candidate.latest.version, previous.version) <= 0) {
      throw new Error(`Release ${candidate.latest.version} is not newer than retained ${channel} release ${previous.version}.`)
    }
  }
  return {
    ...structuredClone(candidate),
    channel,
    feedUpdatedAt: new Date(updatedAt).toISOString(),
    history: deduplicateSnapshots(known),
  }
}

export function prepareChannelRollback({ current, channel, version, updatedAt = new Date().toISOString() }) {
  validateChannelManifest(current, channel)
  assertChannelVersion(channel, version)
  if (current.latest.version === version) throw new Error(`The ${channel} feed already points to ${version}.`)
  const retained = [snapshot(current), ...(current.history ?? [])]
  const target = retained.find((entry) => entry.version === version)
  if (!target) throw new Error(`Release ${version} is not retained in the ${channel} manifest.`)
  validateSnapshot(target, channel, `Rollback target ${version}`)
  const previous = snapshot(current)
  return {
    schemaVersion: 1,
    channel,
    sourceRevision: target.sourceRevision,
    feedUpdatedAt: new Date(updatedAt).toISOString(),
    latest: {
      version: target.version,
      publishedAt: target.publishedAt,
      notesUrl: target.notesUrl ?? null,
    },
    platforms: structuredClone(target.platforms),
    history: deduplicateSnapshots([previous, ...retained.filter((entry) => entry !== target)]),
    rollback: {
      fromVersion: previous.version,
      toVersion: target.version,
      preparedAt: new Date(updatedAt).toISOString(),
    },
  }
}
