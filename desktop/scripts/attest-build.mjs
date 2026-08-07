import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const releaseRoot = resolve(desktopRoot, 'release')
const platformIndex = process.argv.indexOf('--platform')
const platform = platformIndex >= 0 ? process.argv[platformIndex + 1] : null
if (!['macos', 'windows'].includes(platform)) {
  throw new Error('Use --platform macos or --platform windows.')
}

const packageJson = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8'))
const version = packageJson.version
const entries = await readdir(releaseRoot, { withFileTypes: true })
const expectedExtensions = platform === 'macos' ? ['.dmg', '.zip'] : ['.exe', '.zip']
const platformMarker = platform === 'macos' ? '-mac-' : '-windows-'
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
} else {
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
}

const attestation = {
  schemaVersion: 1,
  platform,
  version,
  createdAt: new Date().toISOString(),
  signed,
  notarized: platform === 'macos' ? notarized : null,
  architectures: platform === 'macos' ? ['universal'] : ['x64'],
  artifacts: await Promise.all(artifacts.sort().map(fileRecord)),
}

const output = join(releaseRoot, `attestation-${platform}.json`)
await writeFile(output, `${JSON.stringify(attestation, null, 2)}\n`, { flag: 'wx' })
console.log(`Wrote ${basename(output)} (${signed ? 'signature verified' : 'unsigned'}).`)
