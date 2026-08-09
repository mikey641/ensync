import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, unlink } from 'node:fs/promises'
import { basename, join, parse, resolve } from 'node:path'

export const UPDATE_STATE_CHANNEL = 'ensync:updates:state'
export const UPDATE_GET_STATE_CHANNEL = 'ensync:updates:get-state'
export const UPDATE_CHECK_CHANNEL = 'ensync:updates:check'
export const UPDATE_DOWNLOAD_CHANNEL = 'ensync:updates:download'
export const UPDATE_CANCEL_CHANNEL = 'ensync:updates:cancel'
export const UPDATE_OPEN_INSTALLER_CHANNEL = 'ensync:updates:open-installer'
export const UPDATE_SET_CHANNEL_CHANNEL = 'ensync:updates:set-channel'

const MANIFEST_LIMIT_BYTES = 256 * 1024
const INSTALLER_LIMIT_BYTES = 3 * 1024 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 150
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function frozenState(value) {
  return Object.freeze({
    installedVersion: value.installedVersion,
    installedBuildId: value.installedBuildInfo?.buildId ?? value.installedBuildId ?? null,
    installedBuildChannel: value.installedBuildInfo?.channel ?? value.installedBuildChannel ?? null,
    installedSourceCommit: value.installedBuildInfo?.sourceCommit ?? value.installedSourceCommit ?? null,
    installedSourceDirty: typeof value.installedBuildInfo?.sourceDirty === 'boolean'
      ? value.installedBuildInfo.sourceDirty
      : typeof value.installedSourceDirty === 'boolean' ? value.installedSourceDirty : null,
    installedBuiltAt: value.installedBuildInfo?.builtAt ?? value.installedBuiltAt ?? null,
    channel: value.channel === 'beta' ? 'beta' : 'stable',
    phase: value.phase,
    message: value.message,
    availableVersion: value.availableVersion ?? null,
    checkedAt: value.checkedAt ?? null,
    releaseNotesUrl: value.releaseNotesUrl ?? null,
    progress: value.progress ?? null,
    canCheck: value.canCheck === true,
    canDownload: value.canDownload === true,
    canCancel: value.canCancel === true,
    canInstall: value.canInstall === true,
    canChangeChannel: value.canChangeChannel === true,
    installActionLabel: value.installActionLabel ?? null,
  })
}

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

function supportedPlatform(platform) {
  if (platform === 'darwin') return { id: 'macos', extension: '.dmg', installActionLabel: 'Open disk image' }
  if (platform === 'win32') return { id: 'windows', extension: '.exe', installActionLabel: 'Open installer' }
  return null
}

function secureUrl(value) {
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

export function resolveUpdateCandidate(manifest, platform, installedVersion, expectedChannel = 'stable') {
  const target = supportedPlatform(platform)
  if (!target) return unavailableCandidate('Native updates are supported only on macOS and Windows.')
  if (!manifest || manifest.schemaVersion !== 1) {
    return unavailableCandidate('The release manifest is missing or unsupported.')
  }
  const manifestChannel = manifest.channel ?? 'stable'
  if (!['stable', 'beta'].includes(expectedChannel) || manifestChannel !== expectedChannel) {
    return unavailableCandidate('The release feed does not match the selected update channel.')
  }
  const latestVersion = manifest.latest?.version
  const parsedLatest = parseSemver(latestVersion)
  if (!parsedLatest) {
    return unavailableCandidate(`No verified ${expectedChannel} release version is published.`)
  }
  if (expectedChannel === 'stable' && parsedLatest.prerelease.length > 0) {
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
      : `No verified ${target.id === 'macos' ? 'macOS' : 'Windows'} build is published.`
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
  return {
    available: true,
    version: latestVersion,
    url: installerUrl.href,
    sha256: release.sha256.toLowerCase(),
    notesUrl: notesUrl?.href ?? null,
    installActionLabel: target.installActionLabel,
  }
}

function appBundleForExecutable(executablePath) {
  let current = resolve(executablePath)
  while (parse(current).root !== current) {
    if (current.toLowerCase().endsWith('.app')) return current
    current = resolve(current, '..')
  }
  return null
}

function defaultRunCommand(executable, args, options = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const output = []
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveResult(result)
    }
    child.stdout?.on('data', (chunk) => output.push(chunk))
    child.stderr?.on('data', (chunk) => output.push(chunk))
    child.once('error', () => finish({ ok: false, output: '' }))
    child.once('exit', (code) => finish({ ok: code === 0, output: Buffer.concat(output).toString('utf8') }))
    const timeout = setTimeout(() => {
      child.kill()
      finish({ ok: false, output: '' })
    }, options.timeoutMs ?? 15_000)
    timeout.unref?.()
  })
}

async function readWindowsSignature(filePath, runCommand) {
  const env = { ...process.env, ENSYNC_SIGNATURE_TARGET: filePath }
  const result = await runCommand('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:ENSYNC_SIGNATURE_TARGET; @{ Status = $signature.Status.ToString(); Subject = $signature.SignerCertificate.Subject } | ConvertTo-Json -Compress",
  ], { env, timeoutMs: 20_000 })
  if (!result.ok) return null
  try {
    const parsed = JSON.parse(result.output.trim())
    return parsed.Status === 'Valid' && typeof parsed.Subject === 'string' && parsed.Subject.trim()
      ? parsed.Subject.trim()
      : null
  } catch {
    return null
  }
}

function macTeamIdentifier(output) {
  const match = output.match(/^TeamIdentifier=(.+)$/m)
  const value = match?.[1]?.trim()
  return value && /^[A-Z0-9]{10}$/.test(value) ? value : null
}

async function readMacSignature(filePath, runCommand, deep) {
  const verifyArgs = ['--verify', '--strict']
  if (deep) verifyArgs.push('--deep')
  verifyArgs.push(filePath)
  if (!(await runCommand('codesign', verifyArgs, { timeoutMs: 20_000 })).ok) return null
  const details = await runCommand('codesign', ['--display', '--verbose=4', filePath], { timeoutMs: 20_000 })
  return details.ok ? macTeamIdentifier(details.output) : null
}

export async function verifyInstalledNativeBuild({ platform, executablePath, runCommand = defaultRunCommand }) {
  if (platform === 'darwin') {
    const appBundle = appBundleForExecutable(executablePath)
    if (!appBundle) return { verified: false, signerIdentity: null }
    const signerIdentity = await readMacSignature(appBundle, runCommand, true)
    return { verified: Boolean(signerIdentity), signerIdentity }
  }
  if (platform === 'win32') {
    const signerIdentity = await readWindowsSignature(executablePath, runCommand)
    return { verified: Boolean(signerIdentity), signerIdentity }
  }
  return { verified: false, signerIdentity: null }
}

export async function verifyDownloadedInstaller({
  platform,
  installerPath,
  expectedSignerIdentity,
  runCommand = defaultRunCommand,
}) {
  if (platform === 'darwin') {
    const signerIdentity = await readMacSignature(installerPath, runCommand, false)
    if (!signerIdentity || signerIdentity !== expectedSignerIdentity) return false
    return (await runCommand('spctl', [
      '--assess',
      '--type', 'open',
      '--context', 'context:primary-signature',
      '--verbose=4',
      installerPath,
    ], { timeoutMs: 30_000 })).ok
  }
  if (platform === 'win32') {
    return await readWindowsSignature(installerPath, runCommand) === expectedSignerIdentity
  }
  return false
}

function checkedAtNow(now) {
  return new Date(now()).toISOString()
}

function responseLength(response) {
  const value = response.headers.get('content-length')
  if (value === null) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function safeInstallerName(url, platform, version) {
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

export function createNativeUpdateManager({
  installedVersion,
  installedBuildInfo = null,
  platform,
  isPackaged,
  executablePath,
  manifestUrl,
  manifestUrls,
  initialChannel = 'stable',
  tempRoot,
  fetchImpl = globalThis.fetch,
  verifyInstalledBuild = (input) => verifyInstalledNativeBuild(input),
  verifyInstaller = (input) => verifyDownloadedInstaller(input),
  openInstaller,
  persistChannel = async () => {},
  now = Date.now,
  onStateChange = () => {},
}) {
  let channel = initialChannel === 'beta' ? 'beta' : 'stable'
  const feeds = manifestUrls && typeof manifestUrls === 'object'
    ? { stable: manifestUrls.stable ?? null, beta: manifestUrls.beta ?? null }
    : { stable: manifestUrl ?? null, beta: null }
  let state = frozenState({
    installedVersion,
    installedBuildInfo,
    channel,
    phase: 'initializing',
    message: 'Checking whether this build can use signed updates.',
    canChangeChannel: true,
  })
  let initialized = false
  let candidate = null
  let installerPath = null
  let operation = null
  let downloadController = null
  let installedSignerIdentity = null
  let updatesAllowed = false

  const publish = (next) => {
    state = frozenState({ ...state, ...next })
    onStateChange(state)
    return state
  }

  async function initialize() {
    if (initialized) return state
    initialized = true
    if (!isPackaged) {
      return publish({
        phase: 'unavailable',
        message: 'Updates are unavailable in development builds. Install a signed Ensync release to use native updates.',
        canChangeChannel: true,
      })
    }
    if (!supportedPlatform(platform)) {
      return publish({ phase: 'unavailable', message: 'Native updates are supported only on macOS and Windows.' })
    }
    if (!secureUrl(feeds[channel])) {
      return publish({
        phase: 'unavailable',
        message: `This build does not have a configured HTTPS ${channel} update feed.`,
        canChangeChannel: true,
      })
    }
    let signature = null
    try {
      signature = await verifyInstalledBuild({ platform, executablePath })
    } catch {
      signature = null
    }
    if (!signature?.verified || typeof signature.signerIdentity !== 'string' || !signature.signerIdentity.trim()) {
      return publish({
        phase: 'unavailable',
        message: 'This installed build is not verified as signed. Native updates are disabled.',
        canChangeChannel: true,
      })
    }
    installedSignerIdentity = signature.signerIdentity.trim()
    updatesAllowed = true
    return publish({
      phase: 'idle',
      message: `${channel === 'beta' ? 'Beta' : 'Stable'} updates have not been checked. Ensync checks only when you ask.`,
      canCheck: true,
      canChangeChannel: true,
    })
  }

  async function runExclusive(task) {
    if (operation) return state
    operation = Promise.resolve().then(task)
    try {
      return await operation
    } finally {
      operation = null
    }
  }

  async function check() {
    await initialize()
    if (!state.canCheck || operation) return state
    return runExclusive(async () => {
      candidate = null
      if (installerPath) await unlink(installerPath).catch(() => {})
      installerPath = null
      publish({
        phase: 'checking',
        message: `Checking the signed ${channel} release feed…`,
        availableVersion: null,
        checkedAt: null,
        releaseNotesUrl: null,
        progress: null,
        canCheck: false,
        canDownload: false,
        canCancel: false,
        canInstall: false,
        canChangeChannel: false,
        installActionLabel: null,
      })
      try {
        const selectedManifestUrl = feeds[channel]
        const response = await fetchImpl(selectedManifestUrl, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          redirect: 'follow',
        })
        if (!response.ok || !secureUrl(response.url || selectedManifestUrl)) {
          throw new Error(`Release feed returned HTTP ${response.status}.`)
        }
        const declaredLength = responseLength(response)
        if (declaredLength !== null && declaredLength > MANIFEST_LIMIT_BYTES) {
          throw new Error('Release feed is too large.')
        }
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength > MANIFEST_LIMIT_BYTES) throw new Error('Release feed is too large.')
        const manifest = JSON.parse(new TextDecoder().decode(bytes))
        const resolvedCandidate = resolveUpdateCandidate(manifest, platform, installedVersion, channel)
        const checkedAt = checkedAtNow(now)
        if (!resolvedCandidate.available) {
          return publish({
            phase: resolvedCandidate.current ? 'up_to_date' : 'unavailable',
            message: resolvedCandidate.reason,
            availableVersion: resolvedCandidate.checkedVersion ?? null,
            checkedAt,
            releaseNotesUrl: resolvedCandidate.notesUrl ?? null,
            canCheck: true,
            canChangeChannel: true,
          })
        }
        candidate = resolvedCandidate
        return publish({
          phase: 'available',
          message: `Ensync ${resolvedCandidate.version} is available as a verified signed ${channel} release.`,
          availableVersion: resolvedCandidate.version,
          checkedAt,
          releaseNotesUrl: resolvedCandidate.notesUrl,
          canCheck: true,
          canDownload: true,
          canChangeChannel: true,
          installActionLabel: resolvedCandidate.installActionLabel,
        })
      } catch (error) {
        return publish({
          phase: 'error',
          message: error instanceof SyntaxError
            ? `The ${channel} release feed returned invalid JSON. No update was offered.`
            : `The ${channel} release feed could not be verified. No update was offered.`,
          checkedAt: checkedAtNow(now),
          canCheck: true,
          canChangeChannel: true,
        })
      }
    })
  }

  async function download() {
    await initialize()
    if (!candidate || !state.canDownload || operation) return state
    return runExclusive(async () => {
      downloadController = new AbortController()
      publish({
        phase: 'downloading',
        message: `Downloading Ensync ${candidate.version}…`,
        progress: { transferred: 0, total: null, percent: null },
        canCheck: false,
        canDownload: false,
        canCancel: true,
        canInstall: false,
        canChangeChannel: false,
      })
      let outputPath = null
      try {
        const response = await fetchImpl(candidate.url, {
          cache: 'no-store',
          redirect: 'follow',
          signal: downloadController.signal,
        })
        if (!response.ok || !secureUrl(response.url || candidate.url) || !response.body) {
          throw new Error('The installer download could not be verified.')
        }
        const total = responseLength(response)
        if (total !== null && total > INSTALLER_LIMIT_BYTES) throw new Error('The installer is larger than the safety limit.')
        await mkdir(tempRoot, { recursive: true })
        const directory = await mkdtemp(join(tempRoot, 'ensync-update-'))
        outputPath = join(directory, safeInstallerName(candidate.url, platform, candidate.version))
        const output = await open(outputPath, 'wx')
        const hash = createHash('sha256')
        const reader = response.body.getReader()
        let transferred = 0
        let lastPublished = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (!value?.byteLength) continue
            transferred += value.byteLength
            if (transferred > INSTALLER_LIMIT_BYTES || (total !== null && transferred > total)) {
              throw new Error('The installer exceeded its declared or allowed size.')
            }
            hash.update(value)
            await output.writeFile(value)
            const timestamp = now()
            if (timestamp - lastPublished >= PROGRESS_INTERVAL_MS) {
              lastPublished = timestamp
              publish({
                progress: {
                  transferred,
                  total,
                  percent: total && total > 0 ? Math.min(100, (transferred / total) * 100) : null,
                },
              })
            }
          }
        } finally {
          await output.close()
        }
        if (total !== null && transferred !== total) throw new Error('The installer download ended before its declared size.')
        if (hash.digest('hex') !== candidate.sha256) throw new Error('The installer SHA-256 checksum did not match the signed release manifest.')
        const signed = await verifyInstaller({
          platform,
          installerPath: outputPath,
          expectedSignerIdentity: installedSignerIdentity,
        })
        if (!signed) throw new Error('The downloaded installer signature could not be verified.')
        installerPath = outputPath
        outputPath = null
        return publish({
          phase: 'downloaded',
          message: `Ensync ${candidate.version} downloaded and passed checksum and signature verification.`,
          progress: {
            transferred,
            total: total ?? transferred,
            percent: 100,
          },
          canCheck: true,
          canDownload: false,
          canCancel: false,
          canInstall: true,
          canChangeChannel: true,
        })
      } catch (error) {
        if (outputPath) await unlink(outputPath).catch(() => {})
        const cancelled = downloadController?.signal.aborted === true
        return publish({
          phase: cancelled ? 'available' : 'error',
          message: cancelled
            ? 'Update download cancelled. Nothing was installed.'
            : error instanceof Error && /checksum|signature|size|declared/.test(error.message)
              ? `${error.message} Nothing was installed.`
              : 'The installer could not be downloaded and verified. Nothing was installed.',
          progress: null,
          canCheck: true,
          canDownload: Boolean(candidate),
          canCancel: false,
          canInstall: false,
          canChangeChannel: true,
        })
      } finally {
        downloadController = null
      }
    })
  }

  function cancel() {
    if (state.canCancel) downloadController?.abort()
    return state
  }

  async function openDownloadedInstaller() {
    await initialize()
    if (!installerPath || !state.canInstall || operation) return state
    return runExclusive(async () => {
      try {
        const errorMessage = await openInstaller(installerPath)
        if (errorMessage) throw new Error(errorMessage)
        return publish({
          phase: 'installer_opened',
          message: 'The verified installer was opened. Complete it when ready; Ensync will not quit or restart itself.',
          canCheck: true,
          canInstall: true,
          canChangeChannel: true,
        })
      } catch {
        return publish({
          phase: 'error',
          message: 'Ensync could not open the verified installer. It was not installed.',
          canCheck: true,
          canInstall: true,
          canChangeChannel: true,
        })
      }
    })
  }

  async function setChannel(value) {
    const nextChannel = value === 'stable' || value === 'beta' ? value : null
    if (!nextChannel || nextChannel === channel || operation || state.canCancel) return state
    return runExclusive(async () => {
      try {
        await persistChannel(nextChannel)
      } catch {
        return publish({
          phase: 'error',
          message: 'The update-channel preference could not be saved. The channel was not changed.',
          canChangeChannel: true,
        })
      }
      if (installerPath) await unlink(installerPath).catch(() => {})
      installerPath = null
      candidate = null
      channel = nextChannel
      const configured = secureUrl(feeds[channel])
      return publish({
        channel,
        phase: updatesAllowed && configured ? 'idle' : 'unavailable',
        message: updatesAllowed && configured
          ? `${channel === 'beta' ? 'Beta' : 'Stable'} updates have not been checked. Ensync checks only when you ask.`
          : `This build cannot use the configured ${channel} update feed.`,
        availableVersion: null,
        checkedAt: null,
        releaseNotesUrl: null,
        progress: null,
        canCheck: updatesAllowed && Boolean(configured),
        canDownload: false,
        canCancel: false,
        canInstall: false,
        canChangeChannel: true,
        installActionLabel: null,
      })
    })
  }

  return Object.freeze({
    initialize,
    getState: () => state,
    check,
    download,
    cancel,
    openDownloadedInstaller,
    setChannel,
  })
}

export function unauthorizedUpdateState() {
  return frozenState({
    installedVersion: null,
    installedBuildInfo: null,
    channel: 'stable',
    phase: 'unavailable',
    message: 'Native update controls are available only to a registered Ensync app window.',
    canChangeChannel: false,
  })
}

export function createAuthorizedUpdateHandler({ isAuthorized, action }) {
  if (typeof isAuthorized !== 'function' || typeof action !== 'function') {
    throw new TypeError('Update IPC authorization and action are required.')
  }
  return async (event, ...args) => isAuthorized(event) ? action(...args) : unauthorizedUpdateState()
}
