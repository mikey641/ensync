import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBuildInfoFile } from '../src/build-info.mjs'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const releaseRoot = resolve(desktopRoot, 'release')
const platformIndex = process.argv.indexOf('--platform')
const platform = platformIndex >= 0 ? process.argv[platformIndex + 1] : null
if (!['macos', 'windows', 'windows-store'].includes(platform)) {
  throw new Error('Use --platform macos, windows, or windows-store.')
}

const packageJson = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8'))
const version = packageJson.version
const buildInfo = readBuildInfoFile(resolve(desktopRoot, 'build', 'generated', 'build-info.json'), {
  expectedVersion: version,
})
if (!buildInfo) throw new Error('The packaged build identity is missing or does not match the desktop version.')
const entries = await readdir(releaseRoot, { withFileTypes: true })
const expectedExtensions = platform === 'macos'
  ? ['.dmg', '.zip']
  : platform === 'windows-store'
    ? ['.appx']
    : ['.exe', '.zip']
const platformMarker = platform === 'macos'
  ? '-mac-'
  : platform === 'windows-store'
    ? '-windows-store-'
    : '-windows-'
const artifacts = entries
  .filter((entry) => entry.isFile())
  .map((entry) => join(releaseRoot, entry.name))
  .filter((file) => basename(file).includes(`-${version}${platformMarker}`))
  .filter((file) => expectedExtensions.some((extension) => file.toLowerCase().endsWith(extension)))

for (const extension of expectedExtensions) {
  const matching = artifacts.filter((file) => file.toLowerCase().endsWith(extension))
  if (matching.length !== 1) {
    throw new Error(`Expected exactly one ${platform} ${extension} artifact, found ${matching.length}.`)
  }
}

async function fileRecord(file) {
  const contents = await readFile(file)
  const details = await stat(file)
  if (details.size < 1_000_000) throw new Error(`${basename(file)} is too small to be a desktop artifact.`)
  return {
    name: basename(file),
    bytes: details.size,
    sha256: createHash('sha256').update(contents).digest('hex'),
  }
}

let signed = false
let notarized = false
let storePackage = null
if (platform === 'macos') {
  const appDirectory = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .map((entry) => join(releaseRoot, entry.name, 'Ensync.app'))[0]
  if (!appDirectory) throw new Error('The packaged Ensync.app directory was not found.')
  const diskImage = artifacts.find((file) => file.toLowerCase().endsWith('.dmg'))
  const appSigned = spawnSync('codesign', ['--verify', '--deep', '--strict', appDirectory], { stdio: 'ignore' }).status === 0
  const diskImageSigned = spawnSync('codesign', ['--verify', '--strict', diskImage], { stdio: 'ignore' }).status === 0
  signed = appSigned && diskImageSigned
  const appNotarized = signed
    && spawnSync('xcrun', ['stapler', 'validate', appDirectory], { stdio: 'ignore' }).status === 0
  const diskImageNotarized = signed
    && spawnSync('xcrun', ['stapler', 'validate', diskImage], { stdio: 'ignore' }).status === 0
  notarized = appNotarized && diskImageNotarized
} else if (platform === 'windows') {
  const installer = artifacts.find((file) => file.toLowerCase().endsWith('.exe'))
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-AuthenticodeSignature -LiteralPath $env:ENSYNC_WINDOWS_INSTALLER).Status.ToString()',
  ], {
    encoding: 'utf8',
    env: { ...process.env, ENSYNC_WINDOWS_INSTALLER: installer },
    windowsHide: true,
  })
  signed = result.status === 0 && result.stdout.trim() === 'Valid'
} else {
  const artifact = artifacts[0]
  const manifestResult = spawnSync('tar.exe', ['-xOf', artifact, 'AppxManifest.xml'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (manifestResult.status !== 0 || !manifestResult.stdout.trim()) {
    throw new Error('The Windows Store package does not contain a readable AppxManifest.xml.')
  }
  const expected = resolveWindowsStorePackageConfig(process.env, { productVersion: version })
  storePackage = verifyWindowsStoreManifest(manifestResult.stdout, expected)
}

const attestation = {
  schemaVersion: 1,
  platform,
  version,
  buildId: buildInfo.buildId,
  channel: buildInfo.channel,
  sourceCommit: buildInfo.sourceCommit,
  sourceDirty: buildInfo.sourceDirty,
  builtAt: buildInfo.builtAt,
  createdAt: new Date().toISOString(),
  signed,
  notarized: platform === 'macos' ? notarized : null,
  architectures: platform === 'macos' ? ['universal'] : ['x64'],
  distribution: platform === 'windows-store' ? 'microsoft-store' : 'direct',
  storeCertification: platform === 'windows-store' ? 'pending' : null,
  packageIdentity: storePackage,
  artifacts: await Promise.all(artifacts.sort().map(fileRecord)),
}

const output = join(releaseRoot, `attestation-${platform}.json`)
await writeFile(output, `${JSON.stringify(attestation, null, 2)}\n`, { flag: 'wx' })
console.log(`Wrote ${basename(output)} (${signed ? 'signature verified' : 'unsigned'}).`)
