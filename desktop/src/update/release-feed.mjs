/**
 * Ensync's release feed, standing in for the update server upstream talks to.
 *
 * VS Code asks `${updateUrl}/api/update/${platform}/${quality}/${commit}` and
 * lets the server decide whether a newer build exists (204 = up to date). Ensync
 * publishes a static, signed manifest per channel instead, so the comparison and
 * every trust check happen on the client. The `IUpdate` shape returned here is
 * upstream's: `{ version, productVersion, timestamp, url, sha256hash }`.
 */

import { basename } from 'node:path'

import { UpdateChannel } from './update.mjs'

export const MANIFEST_LIMIT_BYTES = 256 * 1024
export const INSTALLER_LIMIT_BYTES = 3 * 1024 * 1024 * 1024

const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseSemver(value) {
  const match = typeof value === 'string' ? value.match(SEMVER_PATTERN) : null
  if (!match) return null
  return {
    numeric: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') ?? [],
  }
}

function compareIdentifiers(left, right) {
  const numericLeft = /^\d+$/.test(left)
  const numericRight = /^\d+$/.test(right)
  if (numericLeft && numericRight) return Number(left) - Number(right)
  if (numericLeft !== numericRight) return numericLeft ? -1 : 1
  return left.localeCompare(right)
}

export function compareVersions(leftValue, rightValue) {
  const left = parseSemver(leftValue)
  const right = parseSemver(rightValue)
  if (!left || !right) return null
  for (let index = 0; index < 3; index += 1) {
    if (left.numeric[index] !== right.numeric[index]) return left.numeric[index] - right.numeric[index]
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1
    if (right.prerelease[index] === undefined) return 1
    const comparison = compareIdentifiers(left.prerelease[index], right.prerelease[index])
    if (comparison !== 0) return comparison
  }
  return 0
}

/** The platform identifiers the manifest publishes, and how each one installs. */
export function supportedPlatform(platform) {
  if (platform === 'darwin') return { id: 'macos', label: 'macOS', extension: '.dmg', installActionLabel: 'Open disk image' }
  if (platform === 'win32') return { id: 'windows', label: 'Windows', extension: '.exe', installActionLabel: 'Open installer' }
  return null
}

export function secureUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function unavailableCandidate(reason) {
  return { available: false, reason }
}

export function resolveUpdateCandidate(manifest, platform, installedVersion, expectedChannel = UpdateChannel.Stable) {
  const target = supportedPlatform(platform)
  if (!target) return unavailableCandidate('Native updates are supported only on macOS and Windows.')
  if (!manifest || manifest.schemaVersion !== 1) {
    return unavailableCandidate('The release manifest is missing or unsupported.')
  }
  const manifestChannel = manifest.channel ?? UpdateChannel.Stable
  if (!Object.values(UpdateChannel).includes(expectedChannel) || manifestChannel !== expectedChannel) {
    return unavailableCandidate('The release feed does not match the selected update channel.')
  }
  const latestVersion = manifest.latest?.version
  const parsedLatest = parseSemver(latestVersion)
  if (!parsedLatest) {
    return unavailableCandidate(`No verified ${expectedChannel} release version is published.`)
  }
  if (expectedChannel === UpdateChannel.Stable && parsedLatest.prerelease.length > 0) {
    return unavailableCandidate('The stable feed cannot publish a prerelease version.')
  }
  const comparison = compareVersions(latestVersion, installedVersion)
  if (comparison === null) {
    return unavailableCandidate('The installed or published version is not a valid release version.')
  }
  const release = manifest.platforms?.[target.id]
  if (!release || release.status !== 'available') {
    const reason = typeof release?.reason === 'string' && release.reason.trim()
      ? release.reason.trim()
      : `No verified ${target.label} build is published.`
    return unavailableCandidate(reason)
  }
  if (release.version !== latestVersion) {
    return unavailableCandidate('The platform build does not match the latest verified release.')
  }
  if (release.signed !== true) {
    return unavailableCandidate('The published installer is not verified as signed.')
  }
  if (target.id === 'macos' && release.notarized !== true) {
    return unavailableCandidate('The published macOS installer is not verified as notarized.')
  }
  const installerUrl = secureUrl(release.url)
  if (!installerUrl || !installerUrl.pathname.toLowerCase().endsWith(target.extension)) {
    return unavailableCandidate(`The published ${target.id === 'macos' ? 'macOS disk image' : 'Windows installer'} URL is invalid.`)
  }
  if (typeof release.sha256 !== 'string' || !SHA256_PATTERN.test(release.sha256)) {
    return unavailableCandidate('The published installer does not have a valid SHA-256 checksum.')
  }
  const notesUrl = secureUrl(manifest.latest?.notesUrl)
  if (comparison <= 0) {
    return {
      available: false,
      current: true,
      reason: comparison === 0
        ? `Ensync ${installedVersion} is the latest verified release.`
        : `Ensync ${installedVersion} is newer than the latest published release ${latestVersion}.`,
      checkedVersion: latestVersion,
      notesUrl: notesUrl?.href ?? null,
    }
  }
  const publishedAt = Date.parse(manifest.latest?.publishedAt ?? '')
  return {
    available: true,
    /** `IUpdate`, in upstream's shape. */
    update: Object.freeze({
      version: latestVersion,
      productVersion: latestVersion,
      timestamp: Number.isFinite(publishedAt) ? publishedAt : undefined,
      url: installerUrl.href,
      sha256hash: release.sha256.toLowerCase(),
      notesUrl: notesUrl?.href ?? null,
      installActionLabel: target.installActionLabel,
    }),
  }
}

function responseLength(response) {
  const value = response.headers?.get?.('content-length')
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

export { responseLength }

/** Fetches and parses one channel's manifest, refusing anything oversized or non-HTTPS. */
export async function fetchReleaseManifest(fetchImpl, manifestUrl, token) {
  const response = await fetchImpl(manifestUrl, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    redirect: 'follow',
    signal: token?.signal,
  })
  if (!response.ok || !secureUrl(response.url || manifestUrl)) {
    throw new Error(`Release feed returned HTTP ${response.status}.`)
  }
  const declaredLength = responseLength(response)
  if (declaredLength !== null && declaredLength > MANIFEST_LIMIT_BYTES) {
    throw new Error('Release feed is too large.')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MANIFEST_LIMIT_BYTES) throw new Error('Release feed is too large.')
  return JSON.parse(new TextDecoder().decode(bytes))
}

/** A filename that cannot escape the download directory and keeps the expected extension. */
export function safeInstallerName(url, platform, version) {
  const target = supportedPlatform(platform)
  const urlName = basename(new URL(url).pathname)
  const expectedExtension = target?.extension ?? ''
  if (
    !urlName
    || urlName === '.'
    || urlName === '..'
    || !urlName.toLowerCase().endsWith(expectedExtension)
    || !urlName.includes(version)
  ) {
    return `Ensync-${version}${expectedExtension}`
  }
  return urlName.replace(/[^A-Za-z0-9._-]/g, '_')
}
