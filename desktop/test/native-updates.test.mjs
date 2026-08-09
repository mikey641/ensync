import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  compareVersions,
  createAuthorizedUpdateHandler,
  createNativeUpdateManager,
  resolveUpdateCandidate,
  verifyDownloadedInstaller,
  verifyInstalledNativeBuild,
} from '../src/native-updates.mjs'

function releaseManifest({ version = '1.2.3', notarized = true, signed = true, sha256 = 'a'.repeat(64) } = {}) {
  return {
    schemaVersion: 1,
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

test('compares stable and prerelease versions without coercing invalid values', () => {
  assert.equal(compareVersions('1.2.3', '1.2.2') > 0, true)
  assert.equal(compareVersions('1.2.3', '1.2.3-beta.2') > 0, true)
  assert.equal(compareVersions('1.2.3-beta.2', '1.2.3-beta.10') < 0, true)
  assert.equal(compareVersions('latest', '1.2.3'), null)
})

test('candidate resolution requires matching signed artifacts and macOS notarization', () => {
  const available = resolveUpdateCandidate(releaseManifest(), 'darwin', '1.2.2')
  assert.equal(available.available, true)
  assert.equal(available.version, '1.2.3')

  assert.match(resolveUpdateCandidate(releaseManifest({ signed: false }), 'darwin', '1.2.2').reason, /signed/)
  assert.match(resolveUpdateCandidate(releaseManifest({ notarized: false }), 'darwin', '1.2.2').reason, /notarized/)
  assert.match(resolveUpdateCandidate(releaseManifest({ sha256: null }), 'win32', '1.2.2').reason, /SHA-256/)

  const current = resolveUpdateCandidate(releaseManifest(), 'darwin', '1.2.3')
  assert.equal(current.available, false)
  assert.equal(current.current, true)
  assert.match(current.reason, /latest verified release/)
})

test('development and unsigned packaged builds fail closed without checking the network', async () => {
  let fetched = 0
  const common = {
    installedVersion: '1.0.0',
    platform: 'darwin',
    executablePath: '/Applications/Ensync.app/Contents/MacOS/Ensync',
    manifestUrl: 'https://ensync.vercel.app/releases.json',
    tempRoot: tmpdir(),
    fetchImpl: async () => { fetched += 1 },
    openInstaller: async () => '',
  }
  const development = createNativeUpdateManager({ ...common, isPackaged: false })
  assert.equal((await development.initialize()).phase, 'unavailable')
  assert.match(development.getState().message, /development builds/)

  const unsigned = createNativeUpdateManager({
    ...common,
    isPackaged: true,
    verifyInstalledBuild: async () => ({ verified: false, signerIdentity: null }),
  })
  assert.equal((await unsigned.initialize()).phase, 'unavailable')
  assert.match(unsigned.getState().message, /not verified as signed/)
  assert.equal(fetched, 0)
})

test('Microsoft Store installations delegate updates without checking Ensync feeds or signatures', async () => {
  let fetched = 0
  let signatureChecks = 0
  const manager = createNativeUpdateManager({
    installedVersion: '1.0.0',
    platform: 'win32',
    storeManaged: true,
    isPackaged: true,
    executablePath: 'C:\\Program Files\\WindowsApps\\Ensync.exe',
    manifestUrl: 'https://ensync.vercel.app/releases.json',
    tempRoot: tmpdir(),
    fetchImpl: async () => { fetched += 1 },
    verifyInstalledBuild: async () => { signatureChecks += 1; return { verified: true, signerIdentity: 'CN=Store' } },
    openInstaller: async () => '',
  })

  const state = await manager.initialize()
  assert.equal(state.phase, 'managed')
  assert.match(state.message, /Microsoft Store/)
  assert.equal(state.canCheck, false)
  assert.equal(state.canChangeChannel, false)
  assert.equal((await manager.check()).phase, 'managed')
  assert.equal((await manager.setChannel('beta')).channel, 'stable')
  assert.equal(fetched, 0)
  assert.equal(signatureChecks, 0)
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
    runCommand: async (executable, args) => executable === 'codesign' && args.includes('--display')
      ? { ok: true, output: 'TeamIdentifier=not set\n' }
      : { ok: true, output: '' },
  })
  assert.deepEqual(adHoc, { verified: false, signerIdentity: null })

  assert.equal(await verifyDownloadedInstaller({
    platform: 'darwin',
    installerPath: '/tmp/Ensync-1.2.3.dmg',
    expectedSignerIdentity: 'OTHER12345',
    runCommand,
  }), false)
})

test('manual check, download, checksum, same-signer verification, and installer opening stay separate', async () => {
  const installer = Buffer.from('verified installer fixture')
  const checksum = createHash('sha256').update(installer).digest('hex')
  const manifest = releaseManifest({ sha256: checksum })
  const tempRoot = await mkdtemp(join(tmpdir(), 'ensync-update-test-'))
  const states = []
  const installerVerifications = []
  const opened = []
  let fetchCount = 0
  let timestamp = Date.parse('2026-08-06T12:00:00.000Z')
  const manager = createNativeUpdateManager({
    installedVersion: '1.2.2',
    platform: 'darwin',
    isPackaged: true,
    executablePath: '/Applications/Ensync.app/Contents/MacOS/Ensync',
    manifestUrl: 'https://ensync.vercel.app/releases.json',
    tempRoot,
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
    verifyInstalledBuild: async () => ({ verified: true, signerIdentity: 'TEAM123456' }),
    verifyInstaller: async (input) => {
      installerVerifications.push(input)
      assert.equal((await readFile(input.installerPath)).equals(installer), true)
      return input.expectedSignerIdentity === 'TEAM123456'
    },
    openInstaller: async (path) => { opened.push(path); return '' },
    onStateChange: (state) => states.push(state),
  })

  assert.equal((await manager.initialize()).phase, 'idle')
  assert.equal(fetchCount, 0)
  assert.equal((await manager.check()).phase, 'available')
  assert.equal(fetchCount, 1)
  assert.equal(manager.getState().canDownload, true)
  assert.equal((await manager.download()).phase, 'downloaded')
  assert.equal(installerVerifications.length, 1)
  assert.equal(manager.getState().progress.percent, 100)
  assert.equal(opened.length, 0)
  assert.equal((await manager.openDownloadedInstaller()).phase, 'installer_opened')
  assert.equal(opened.length, 1)
  assert.match(manager.getState().message, /will not quit or restart/)
  assert.equal(states.some((state) => state.phase === 'downloading'), true)
})

test('same-signer verification failure removes the installer and never enables opening', async () => {
  const installer = Buffer.from('installer signed by somebody else')
  const checksum = createHash('sha256').update(installer).digest('hex')
  const manifest = releaseManifest({ sha256: checksum })
  let fetchCount = 0
  let opened = false
  const manager = createNativeUpdateManager({
    installedVersion: '1.2.2',
    platform: 'darwin',
    isPackaged: true,
    executablePath: '/Applications/Ensync.app/Contents/MacOS/Ensync',
    manifestUrl: 'https://ensync.vercel.app/releases.json',
    tempRoot: await mkdtemp(join(tmpdir(), 'ensync-update-test-')),
    fetchImpl: async () => {
      fetchCount += 1
      return fetchCount === 1
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : new Response(installer, { status: 200 })
    },
    verifyInstalledBuild: async () => ({ verified: true, signerIdentity: 'TEAM123456' }),
    verifyInstaller: async () => false,
    openInstaller: async () => { opened = true; return '' },
  })
  await manager.initialize()
  await manager.check()
  const state = await manager.download()
  assert.equal(state.phase, 'error')
  assert.match(state.message, /signature/)
  assert.equal(state.canInstall, false)
  await manager.openDownloadedInstaller()
  assert.equal(opened, false)
})

test('checksum mismatch fails before installer signature verification', async () => {
  const installer = Buffer.from('tampered installer bytes')
  const manifest = releaseManifest({ sha256: 'b'.repeat(64) })
  let fetchCount = 0
  let signatureChecks = 0
  const manager = createNativeUpdateManager({
    installedVersion: '1.2.2',
    platform: 'win32',
    isPackaged: true,
    executablePath: 'C:\\Program Files\\Ensync\\Ensync.exe',
    manifestUrl: 'https://ensync.vercel.app/releases.json',
    tempRoot: await mkdtemp(join(tmpdir(), 'ensync-update-test-')),
    fetchImpl: async () => {
      fetchCount += 1
      return fetchCount === 1
        ? new Response(JSON.stringify(manifest), { status: 200 })
        : new Response(installer, { status: 200 })
    },
    verifyInstalledBuild: async () => ({ verified: true, signerIdentity: 'CN=Ensync' }),
    verifyInstaller: async () => { signatureChecks += 1; return true },
    openInstaller: async () => '',
  })
  await manager.initialize()
  await manager.check()
  const state = await manager.download()
  assert.equal(state.phase, 'error')
  assert.match(state.message, /checksum/)
  assert.equal(signatureChecks, 0)
})

test('every update IPC action rejects an unregistered sender before invoking native work', async () => {
  let invoked = 0
  const handler = createAuthorizedUpdateHandler({
    isAuthorized: (event) => event.sender === 'owned',
    action: async () => { invoked += 1; return { phase: 'idle' } },
  })
  const rejected = await handler({ sender: 'foreign' })
  assert.equal(rejected.phase, 'unavailable')
  assert.match(rejected.message, /registered Ensync app window/)
  assert.equal(invoked, 0)
  assert.deepEqual(await handler({ sender: 'owned' }), { phase: 'idle' })
  assert.equal(invoked, 1)
})

test('desktop package includes the updater and production HTTPS manifest feeds', async () => {
  const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'))
  assert.ok(manifest.build.files.includes('src/native-updates.mjs'))
  assert.deepEqual(manifest.ensync.updateManifestUrls, {
    stable: 'https://ensync.vercel.app/releases.json',
    beta: 'https://ensync.vercel.app/releases-beta.json',
  })
  assert.equal(manifest.build.dmg.sign, true)
  assert.equal(manifest.build.afterAllArtifactBuild, 'scripts/notarize-artifacts.cjs')
})
