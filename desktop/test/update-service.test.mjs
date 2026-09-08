import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  verifyDownloadedInstaller,
  verifyInstalledNativeBuild,
} from '../src/update/code-signature.mjs'
import { compareVersions, resolveUpdateCandidate } from '../src/update/release-feed.mjs'
import {
  createAuthorizedUpdateHandler,
  createUpdateSnapshot,
  updateIpcActions,
  UPDATE_APPLY_CHANNEL,
  UPDATE_QUIT_AND_INSTALL_CHANNEL,
  UPDATE_SET_MODE_CHANNEL,
} from '../src/update/update-ipc.mjs'
import { createUpdateManager } from '../src/update/update-manager.mjs'
import { DisablementReason, State, StateType, UpdateType } from '../src/update/update.mjs'

const silentLog = { trace() {}, info() {}, warn() {}, error() {} }

function releaseManifest({
  version = '1.2.3',
  channel = 'stable',
  notarized = true,
  signed = true,
  sha256 = 'a'.repeat(64),
} = {}) {
  return {
    schemaVersion: 1,
    channel,
    latest: {
      version,
      publishedAt: '2026-08-06T00:00:00.000Z',
      notesUrl: `https://github.com/ensync/ensync/releases/tag/v${version}`,
    },
    platforms: {
      macos: {
        status: 'available',
        reason: null,
        version,
        url: `https://github.com/ensync/ensync/releases/download/v${version}/Ensync-${version}-mac-universal.dmg`,
        sha256,
        signed,
        notarized,
      },
      windows: {
        status: 'available',
        reason: null,
        version,
        url: `https://github.com/ensync/ensync/releases/download/v${version}/Ensync-${version}-windows-x64.exe`,
        sha256,
        signed,
        notarized: null,
      },
    },
  }
}

/** A preferences store with the two update settings the service reads. */
function preferencesStore(initial = {}) {
  let value = { updateChannel: 'stable', updateMode: 'default', ...initial }
  return {
    get: () => value,
    setUpdateChannel(updateChannel) { value = { ...value, updateChannel }; return value },
    setUpdateMode(updateMode) { value = { ...value, updateMode }; return value },
  }
}

async function managerFor(overrides = {}) {
  return createUpdateManager({
    installedVersion: '1.2.2',
    platform: 'darwin',
    isPackaged: true,
    executablePath: '/Applications/Ensync.app/Contents/MacOS/Ensync',
    manifestUrls: {
      stable: 'https://ensync.vercel.app/releases.json',
      beta: 'https://ensync.vercel.app/releases-beta.json',
    },
    preferences: preferencesStore(),
    tempRoot: await mkdtemp(join(tmpdir(), 'ensync-update-test-')),
    verifyInstalledBuild: async () => ({ verified: true, signerIdentity: 'TEAM123456' }),
    verifyInstaller: async () => true,
    openInstaller: async () => '',
    logService: silentLog,
    ...overrides,
  })
}

test('compares stable and prerelease versions without coercing invalid values', () => {
  assert.equal(compareVersions('1.2.3', '1.2.2') > 0, true)
  assert.equal(compareVersions('1.2.3', '1.2.3-beta.2') > 0, true)
  assert.equal(compareVersions('1.2.3-beta.2', '1.2.3-beta.10') < 0, true)
  assert.equal(compareVersions('latest', '1.2.3'), null)
})

test('candidate resolution requires matching signed artifacts and macOS notarization', () => {
  const available = resolveUpdateCandidate(releaseManifest(), 'darwin', '1.2.2')
  assert.equal(available.available, true)
  assert.equal(available.update.version, '1.2.3')
  assert.equal(available.update.productVersion, '1.2.3')
  assert.match(available.update.sha256hash, /^[a-f0-9]{64}$/)

  assert.match(resolveUpdateCandidate(releaseManifest({ signed: false }), 'darwin', '1.2.2').reason, /signed/)
  assert.match(resolveUpdateCandidate(releaseManifest({ notarized: false }), 'darwin', '1.2.2').reason, /notarized/)
  assert.match(resolveUpdateCandidate(releaseManifest({ sha256: null }), 'win32', '1.2.2').reason, /SHA-256/)

  const current = resolveUpdateCandidate(releaseManifest(), 'darwin', '1.2.3')
  assert.equal(current.available, false)
  assert.equal(current.current, true)
  assert.match(current.reason, /latest verified release/)
})

test('candidate resolution isolates stable and beta channels', () => {
  const beta = releaseManifest({ version: '1.2.3-beta.2', channel: 'beta' })
  assert.equal(resolveUpdateCandidate(beta, 'darwin', '1.2.3-beta.1', 'beta').available, true)
  assert.match(resolveUpdateCandidate(beta, 'darwin', '1.2.2', 'stable').reason, /selected update channel/)
  assert.match(resolveUpdateCandidate(releaseManifest({ version: '1.2.4-beta.1' }), 'darwin', '1.2.3').reason, /stable feed/)
})

test('development builds are permanently disabled without touching the network or the keychain', async () => {
  let touched = 0
  const manager = await managerFor({
    isPackaged: false,
    fetchImpl: async () => { touched += 1 },
    verifyInstalledBuild: async () => { touched += 1; return { verified: true, signerIdentity: 'TEAM123456' } },
  })
  const snapshot = await manager.initialize()
  assert.deepEqual(snapshot.state, { type: StateType.Disabled, reason: DisablementReason.NotBuilt })
  assert.equal(touched, 0)
  // A permanently disabled service ignores later setting changes.
  assert.equal((await manager.setMode('manual')).state.type, StateType.Disabled)
  assert.equal((await manager.checkForUpdates(true)).state.type, StateType.Disabled)
  assert.equal(touched, 0)
})

test('an unsigned packaged build is disabled before any feed is contacted', async () => {
  let fetched = 0
  const manager = await managerFor({
    fetchImpl: async () => { fetched += 1 },
    verifyInstalledBuild: async () => ({ verified: false, signerIdentity: null }),
  })
  const snapshot = await manager.initialize()
  assert.equal(snapshot.state.reason, DisablementReason.UnsignedBuild)
  assert.equal(fetched, 0)
})

test('Microsoft Store installations delegate updates without checking feeds or signatures', async () => {
  let fetched = 0
  let signatureChecks = 0
  const manager = await managerFor({
    platform: 'win32',
    storeManaged: true,
    executablePath: 'C:\\Program Files\\WindowsApps\\Ensync.exe',
    fetchImpl: async () => { fetched += 1 },
    verifyInstalledBuild: async () => { signatureChecks += 1; return { verified: true, signerIdentity: 'CN=Store' } },
  })
  const snapshot = await manager.initialize()
  assert.equal(snapshot.state.reason, DisablementReason.StoreManaged)
  assert.equal((await manager.checkForUpdates(true)).state.type, StateType.Disabled)
  assert.equal(fetched, 0)
  assert.equal(signatureChecks, 0)
})

test('a platform without a signed release feed resolves to a disabled service', async () => {
  const manager = await managerFor({ platform: 'linux', executablePath: '/opt/ensync/ensync' })
  const snapshot = await manager.initialize()
  assert.equal(snapshot.state.reason, DisablementReason.UnsupportedPlatform)
})

test('update.mode none disables checks and switching back re-enables them', async () => {
  const preferences = preferencesStore()
  let fetched = 0
  const manager = await managerFor({
    preferences,
    fetchImpl: async () => { fetched += 1; return new Response(JSON.stringify(releaseManifest()), { status: 200 }) },
  })
  await manager.initialize()

  const off = await manager.setMode('none')
  assert.deepEqual(off.state, { type: StateType.Disabled, reason: DisablementReason.ManuallyDisabled })
  assert.equal(preferences.get().updateMode, 'none')
  assert.equal((await manager.checkForUpdates(true)).state.type, StateType.Disabled)
  assert.equal(fetched, 0)

  const manual = await manager.setMode('manual')
  assert.equal(manual.state.type, StateType.Idle)
  assert.equal(manual.mode, 'manual')
})

test('macOS verification requires a real team identity and the downloaded DMG to match it and pass Gatekeeper', async () => {
  const commands = []
  const runCommand = async (executable, args) => {
    commands.push([executable, ...args])
    if (executable === 'codesign' && args.includes('--display')) {
      return { ok: true, output: 'Authority=Developer ID Application: Ensync\nTeamIdentifier=ABC123DEF4\n' }
    }
    return { ok: true, output: '' }
  }
  const installed = await verifyInstalledNativeBuild({
    platform: 'darwin',
    executablePath: '/Applications/Ensync.app/Contents/MacOS/Ensync',
    runCommand,
  })
  assert.deepEqual(installed, { verified: true, signerIdentity: 'ABC123DEF4' })
  assert.equal(await verifyDownloadedInstaller({
    platform: 'darwin',
    installerPath: '/tmp/Ensync-1.2.3.dmg',
    expectedSignerIdentity: installed.signerIdentity,
    runCommand,
  }), true)
  assert.equal(commands.some((command) => command[0] === 'spctl' && command.includes('context:primary-signature')), true)

  const adHoc = await verifyInstalledNativeBuild({
    platform: 'darwin',
    executablePath: '/Applications/Ensync.app/Contents/MacOS/Ensync',
    runCommand: async (executable, args) => (executable === 'codesign' && args.includes('--display')
      ? { ok: true, output: 'TeamIdentifier=not set\n' }
      : { ok: true, output: '' }),
  })
  assert.deepEqual(adHoc, { verified: false, signerIdentity: null })

  assert.equal(await verifyDownloadedInstaller({
    platform: 'darwin',
    installerPath: '/tmp/Ensync-1.2.3.dmg',
    expectedSignerIdentity: 'OTHER12345',
    runCommand,
  }), false)
})

test('a check walks Idle → Checking → Downloading → Downloaded and applying opens the installer', async () => {
  const installer = Buffer.from('verified installer fixture')
  const checksum = createHash('sha256').update(installer).digest('hex')
  const manifest = releaseManifest({ sha256: checksum })
  const states = []
  const installerVerifications = []
  const opened = []
  let fetchCount = 0
  let timestamp = Date.parse('2026-08-06T12:00:00.000Z')

  const manager = await managerFor({
    now: () => { timestamp += 200; return timestamp },
    fetchImpl: async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        return new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { 'content-length': String(Buffer.byteLength(JSON.stringify(manifest))) },
        })
      }
      return new Response(installer, {
        status: 200,
        headers: { 'content-length': String(installer.byteLength) },
      })
    },
    verifyInstaller: async (input) => {
      installerVerifications.push(input)
      assert.equal((await readFile(input.installerPath)).equals(installer), true)
      return input.expectedSignerIdentity === 'TEAM123456'
    },
    openInstaller: async (path) => { opened.push(path); return '' },
    onSnapshotChange: (snapshot) => states.push(snapshot.state.type),
  })

  assert.equal((await manager.initialize()).state.type, StateType.Idle)
  assert.equal(fetchCount, 0)

  const checked = await manager.checkForUpdates(true)
  assert.equal(checked.state.type, StateType.Downloaded)
  assert.equal(checked.availableVersion, '1.2.3')
  assert.equal(checked.updateType, UpdateType.Archive)
  assert.match(checked.releaseNotesUrl, /releases\/tag\/v1\.2\.3/)
  assert.equal(installerVerifications.length, 1)
  assert.equal(opened.length, 0)

  const applied = await manager.applyUpdate()
  assert.equal(applied.state.type, StateType.Ready)
  assert.equal(opened.length, 1)

  assert.deepEqual(
    states.filter((type, index) => states[index - 1] !== type),
    [
      StateType.Idle,
      StateType.CheckingForUpdates,
      StateType.Downloading,
      StateType.Downloaded,
      StateType.Updating,
      StateType.Ready,
    ],
  )
})

test('quitAndInstall never quits: it leaves the pending update with the user', async () => {
  const installer = Buffer.from('verified installer fixture')
  const manifest = releaseManifest({ sha256: createHash('sha256').update(installer).digest('hex') })
  let fetchCount = 0
  const manager = await managerFor({
    fetchImpl: async () => {
      fetchCount += 1
      return fetchCount === 1
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : new Response(installer, { status: 200 })
    },
  })
  await manager.initialize()
  await manager.checkForUpdates(true)
  await manager.applyUpdate()
  assert.equal(manager.getSnapshot().state.type, StateType.Ready)
  assert.equal((await manager.quitAndInstall()).state.type, StateType.Ready)
})

test('same-signer verification failure discards the installer and never enables applying', async () => {
  const installer = Buffer.from('installer signed by somebody else')
  const manifest = releaseManifest({ sha256: createHash('sha256').update(installer).digest('hex') })
  let fetchCount = 0
  let opened = false
  const manager = await managerFor({
    fetchImpl: async () => {
      fetchCount += 1
      return fetchCount === 1
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : new Response(installer, { status: 200 })
    },
    verifyInstaller: async () => false,
    openInstaller: async () => { opened = true; return '' },
  })
  await manager.initialize()
  const state = (await manager.checkForUpdates(true)).state
  assert.equal(state.type, StateType.Idle)
  assert.match(state.error, /signature/)
  await manager.applyUpdate()
  assert.equal(opened, false)
})

test('checksum mismatch fails before installer signature verification', async () => {
  const installer = Buffer.from('tampered installer bytes')
  const manifest = releaseManifest({ sha256: 'b'.repeat(64) })
  let fetchCount = 0
  let signatureChecks = 0
  const manager = await managerFor({
    platform: 'win32',
    executablePath: 'C:\\Program Files\\Ensync\\Ensync.exe',
    fetchImpl: async () => {
      fetchCount += 1
      return fetchCount === 1
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : new Response(installer, { status: 200 })
    },
    verifyInstalledBuild: async () => ({ verified: true, signerIdentity: 'CN=Ensync' }),
    verifyInstaller: async () => { signatureChecks += 1; return true },
  })
  await manager.initialize()
  const state = (await manager.checkForUpdates(true)).state
  assert.equal(state.type, StateType.Idle)
  assert.match(state.error, /checksum/)
  assert.equal(signatureChecks, 0)
})

test('cancelling an in-flight download keeps the candidate and discards the partial file', async () => {
  const manifest = releaseManifest({ sha256: 'c'.repeat(64) })
  let releaseChunk = () => {}
  const stalled = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8))
      releaseChunk = () => controller.close()
    },
  })
  let fetchCount = 0
  const manager = await managerFor({
    fetchImpl: async (_url, init) => {
      fetchCount += 1
      if (fetchCount === 1) return new Response(JSON.stringify(manifest), { status: 200 })
      init?.signal?.addEventListener('abort', () => releaseChunk())
      return new Response(stalled, { status: 200, headers: { 'content-length': '4096' } })
    },
  })
  await manager.initialize()

  const checking = manager.checkForUpdates(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manager.getSnapshot().state.type, StateType.Downloading)

  manager.cancelDownload()
  await checking

  const snapshot = manager.getSnapshot()
  assert.equal(snapshot.state.type, StateType.AvailableForDownload)
  assert.equal(snapshot.state.update.version, '1.2.3')
  assert.equal(manager.service.availableUpdate, undefined)
})

test('a check that finds nothing newer reports Idle with notAvailable and downloads nothing', async () => {
  let fetchCount = 0
  const manager = await managerFor({
    installedVersion: '1.2.3',
    fetchImpl: async () => {
      fetchCount += 1
      return new Response(JSON.stringify(releaseManifest()), { status: 200 })
    },
  })
  await manager.initialize()
  const snapshot = await manager.checkForUpdates(true)
  assert.equal(snapshot.state.type, StateType.Idle)
  assert.equal(snapshot.state.notAvailable, true)
  assert.match(snapshot.notice, /latest verified release/)
  assert.equal(fetchCount, 1)
})

test('switching channel discards the downloaded installer and re-idles on the new feed', async () => {
  const installer = Buffer.from('verified installer fixture')
  const manifest = releaseManifest({ sha256: createHash('sha256').update(installer).digest('hex') })
  const preferences = preferencesStore()
  let fetchCount = 0
  const manager = await managerFor({
    preferences,
    fetchImpl: async () => {
      fetchCount += 1
      return fetchCount === 1
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : new Response(installer, { status: 200 })
    },
  })
  await manager.initialize()
  await manager.checkForUpdates(true)
  assert.equal(manager.getSnapshot().state.type, StateType.Downloaded)

  const beta = await manager.setChannel('beta')
  assert.equal(beta.channel, 'beta')
  assert.equal(beta.state.type, StateType.Idle)
  assert.equal(manager.service.availableUpdate, undefined)
  assert.equal(preferences.get().updateChannel, 'beta')
})

test('the IPC snapshot carries the raw state plus the installed build and settings', async () => {
  const manager = await managerFor({ installedBuildId: '0123456789abcdef' })
  await manager.initialize()
  const snapshot = createUpdateSnapshot(manager.service)
  assert.deepEqual(snapshot.state, { type: StateType.Idle, updateType: UpdateType.Archive })
  assert.equal(snapshot.installedVersion, '1.2.2')
  assert.equal(snapshot.installedBuildId, '0123456789abcdef')
  assert.equal(snapshot.channel, 'stable')
  assert.equal(snapshot.mode, 'default')
  assert.equal(snapshot.installActionLabel, 'Open disk image')
  // The snapshot must survive the structured clone the IPC bridge performs.
  assert.deepEqual(structuredClone(snapshot), snapshot)
})

test('every update IPC action rejects an unregistered sender before invoking native work', async () => {
  let invoked = 0
  const handler = createAuthorizedUpdateHandler({
    isAuthorized: (event) => event.sender === 'owned',
    action: async () => { invoked += 1; return { state: State.Idle(UpdateType.Archive) } },
  })
  const rejected = await handler({ sender: 'foreign' })
  assert.equal(rejected.state.type, StateType.Disabled)
  assert.match(rejected.notice, /registered Ensync app window/)
  assert.equal(invoked, 0)
  assert.equal((await handler({ sender: 'owned' })).state.type, StateType.Idle)
  assert.equal(invoked, 1)
})

test('the IPC action table covers every renderer-facing update action', () => {
  const channels = [...updateIpcActions({}).keys()]
  assert.ok(channels.includes(UPDATE_APPLY_CHANNEL))
  assert.ok(channels.includes(UPDATE_QUIT_AND_INSTALL_CHANNEL))
  assert.ok(channels.includes(UPDATE_SET_MODE_CHANNEL))
  assert.equal(new Set(channels).size, channels.length)
})

test('desktop package includes the updater and production HTTPS manifest feeds', async () => {
  const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'))
  assert.ok(manifest.build.files.includes('src/update/*.mjs'))
  assert.deepEqual(manifest.ensync.updateManifestUrls, {
    stable: 'https://ensync.vercel.app/releases.json',
    beta: 'https://ensync.vercel.app/releases-beta.json',
  })
  assert.equal(manifest.build.dmg.sign, true)
  assert.equal(manifest.build.afterAllArtifactBuild, 'scripts/notarize-artifacts.cjs')
})
