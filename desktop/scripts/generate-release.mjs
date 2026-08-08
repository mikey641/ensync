import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'

function option(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const inputRoot = resolve(option('--input', 'release-input'))
const outputRoot = resolve(option('--output', 'release-assets'))
const tag = option('--tag')
const repository = option('--repository')
const channel = option('--channel')
if (!tag || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error('--tag must be a semantic release tag such as v1.2.3.')
}
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('--repository must be a GitHub owner/repository name.')
}
if (!['stable', 'beta'].includes(channel)) {
  throw new Error('--channel must be stable or beta.')
}
const version = tag.replace(/^v/, '')
const prerelease = version.split('+')[0].includes('-')
if (channel === 'stable' && prerelease) {
  throw new Error('A prerelease tag may publish only to the beta channel.')
}
if (channel === 'beta' && !prerelease) {
  throw new Error('The beta channel requires a semantic prerelease tag.')
}

async function walk(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

const inputFiles = await walk(inputRoot)
const artifactExtensions = new Set(['.dmg', '.zip'])
const artifacts = inputFiles.filter((file) => artifactExtensions.has(extname(file).toLowerCase()))
const attestations = new Map()

for (const file of inputFiles.filter((item) => basename(item) === 'attestation-macos.json')) {
  const attestation = JSON.parse(await readFile(file, 'utf8'))
  if (attestation.schemaVersion !== 1 || attestation.platform !== 'macos') {
    throw new Error(`Invalid build attestation: ${relative(inputRoot, file)}`)
  }
  if (attestation.version !== version) {
    throw new Error(`${attestation.platform} attestation is for ${attestation.version}, expected ${version}.`)
  }
  if (attestations.has(attestation.platform)) throw new Error(`Duplicate ${attestation.platform} attestation.`)
  attestations.set(attestation.platform, attestation)
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })

const names = new Set()
const records = []
for (const artifact of artifacts.sort()) {
  const name = basename(artifact)
  if (names.has(name)) throw new Error(`Duplicate release artifact name: ${name}`)
  if (!name.includes(`-${version}-`)) throw new Error(`${name} does not match release version ${version}.`)
  const details = await stat(artifact)
  if (details.size < 1_000_000) throw new Error(`${name} is too small to be a desktop artifact.`)
  names.add(name)
  await copyFile(artifact, join(outputRoot, name))
  records.push({ name, bytes: details.size, sha256: await sha256(artifact) })
}

function macosRelease() {
  const platform = 'macos'
  const marker = '-mac-'
  const installerExtension = '.dmg'
  const attestation = attestations.get(platform)
  const platformRecords = records.filter((record) => record.name.includes(marker))
  const installer = platformRecords.filter((record) => record.name.endsWith(installerExtension))
  const archives = platformRecords.filter((record) => record.name.endsWith('.zip'))
  if (!attestation || installer.length !== 1 || archives.length !== 1) {
    throw new Error(`${platform} must have one attestation, one ${installerExtension}, and one zip archive.`)
  }
  for (const record of platformRecords) {
    const attested = attestation.artifacts?.find((item) => item.name === record.name)
    if (!attested || attested.sha256 !== record.sha256 || attested.bytes !== record.bytes) {
      throw new Error(`${record.name} does not match its build attestation.`)
    }
  }

  if (attestation.signed !== true) {
    throw new Error(`${platform} artifacts are unsigned; refusing to create a public release.`)
  }
  if (attestation.notarized !== true) {
    throw new Error('macOS artifacts are not notarized; refusing to create a public release.')
  }
  const primary = installer[0]
  return {
    status: 'available',
    reason: null,
    version,
    url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(primary.name)}`,
    sha256: primary.sha256,
    signed: true,
    notarized: true,
    architectures: attestation.architectures ?? [],
  }
}

if (records.length !== 2) {
  throw new Error(`Expected two real public macOS release artifacts (DMG and ZIP), found ${records.length}.`)
}

const checksums = `${records.map((record) => `${record.sha256}  ${record.name}`).join('\n')}\n`
await writeFile(join(outputRoot, 'SHA256SUMS.txt'), checksums, { flag: 'wx' })

const manifest = {
  schemaVersion: 1,
  channel,
  latest: {
    version,
    publishedAt: new Date().toISOString(),
    notesUrl: `https://github.com/${repository}/releases/tag/${tag}`,
  },
  platforms: {
    macos: macosRelease(),
    windows: {
      status: 'unavailable',
      reason: 'Windows releases are delivered through Microsoft Store after Partner Center certification.',
      version: null,
      url: null,
      sha256: null,
      signed: false,
      notarized: null,
      architectures: [],
    },
  },
}
const manifestName = channel === 'beta' ? 'releases-beta.json' : 'releases.json'
await writeFile(join(outputRoot, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
console.log(`Prepared ${records.length} verified public macOS artifacts, checksums, and ${manifestName} for ${tag}.`)
