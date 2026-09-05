import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const generator = resolve(desktopRoot, 'scripts/generate-release.mjs')
const sourceCommit = '35642bfda02d82e007a1639dbd2c642b67c01b7d'

async function fixture({
  macSigned = true,
  macNotarized = true,
  windowsSigned = true,
  includePrivateStorePackage = false,
  version = '1.2.3',
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-release-'))
  const input = join(root, 'input')
  const output = join(root, 'output')
  await mkdir(input)

  const nameGroups = {
    macos: [
      `Ensync-${version}-mac-universal.dmg`,
      `Ensync-${version}-mac-universal.zip`,
    ],
    windows: [
      `Ensync-${version}-windows-x64.exe`,
      `Ensync-${version}-windows-x64.zip`,
    ],
  }
  const privateStoreNames = includePrivateStorePackage
    ? [`Ensync-${version}-windows-store-x64.appx`]
    : []
  const names = [...nameGroups.macos, ...nameGroups.windows, ...privateStoreNames]
  const records = []
  for (const [index, name] of names.entries()) {
    const contents = Buffer.alloc(1_000_001, index + 1)
    await writeFile(join(input, name), contents)
    records.push({
      name,
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    })
  }

  const channel = version.includes('-') ? 'beta' : 'stable'
  const attestations = [
    {
      schemaVersion: 1,
      platform: 'macos',
      version,
      buildId: 'a'.repeat(16),
      channel,
      sourceCommit,
      sourceDirty: false,
      builtAt: '2026-08-07T10:00:00.000Z',
      signed: macSigned,
      notarized: macNotarized,
      architectures: ['universal'],
      artifacts: records.filter((record) => nameGroups.macos.includes(record.name)),
    },
    {
      schemaVersion: 1,
      platform: 'windows',
      version,
      buildId: 'b'.repeat(16),
      channel,
      sourceCommit,
      sourceDirty: false,
      builtAt: '2026-08-07T10:01:00.000Z',
      signed: windowsSigned,
      notarized: null,
      architectures: ['x64'],
      distribution: 'direct',
      artifacts: records.filter((record) => nameGroups.windows.includes(record.name)),
    },
  ]
  for (const attestation of attestations) {
    await writeFile(
      join(input, `attestation-${attestation.platform}.json`),
      `${JSON.stringify(attestation)}\n`,
    )
  }
  return { input, output }
}

function generate(input, output, { tag = 'v1.2.3', channel = 'stable' } = {}) {
  return spawnSync(process.execPath, [
    generator,
    '--input', input,
    '--output', output,
    '--tag', tag,
    '--repository', 'ensync/ensync-downloads',
    '--channel', channel,
    '--source-commit', sourceCommit,
  ], { encoding: 'utf8' })
}

async function macosOnlyFixture({ macSigned = true, macNotarized = true, version = '0.1.0-beta.1' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-release-mac-'))
  const input = join(root, 'input')
  const output = join(root, 'output')
  await mkdir(input)

  const names = [
    `Ensync-${version}-mac-universal.dmg`,
    `Ensync-${version}-mac-universal.zip`,
  ]
  const records = []
  for (const [index, name] of names.entries()) {
    const contents = Buffer.alloc(1_000_001, index + 1)
    await writeFile(join(input, name), contents)
    records.push({
      name,
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    })
  }

  const channel = version.includes('-') ? 'beta' : 'stable'
  const attestation = {
    schemaVersion: 1,
    platform: 'macos',
    version,
    buildId: 'a'.repeat(16),
    channel,
    sourceCommit,
    sourceDirty: false,
    builtAt: '2026-08-07T10:00:00.000Z',
    signed: macSigned,
    notarized: macNotarized,
    architectures: ['universal'],
    artifacts: records,
  }
  await writeFile(join(input, 'attestation-macos.json'), `${JSON.stringify(attestation)}\n`)
  return { input, output }
}

function generateMacosOnly(input, output, { tag = 'v0.1.0-beta.1', channel = 'beta' } = {}) {
  return spawnSync(process.execPath, [
    generator,
    '--input', input,
    '--output', output,
    '--tag', tag,
    '--repository', 'ensync/ensync-downloads',
    '--channel', channel,
    '--source-commit', sourceCommit,
    '--macos-only',
  ], { encoding: 'utf8' })
}

test('release generation publishes signed macOS and Windows direct artifacts', async () => {
  const { input, output } = await fixture()
  const result = generate(input, output)
  assert.equal(result.status, 0, result.stderr)

  const manifest = JSON.parse(await readFile(join(output, 'releases.json'), 'utf8'))
  assert.equal(manifest.channel, 'stable')
  assert.equal(manifest.sourceRevision, sourceCommit)

  assert.equal(manifest.platforms.macos.status, 'available')
  assert.equal(manifest.platforms.macos.buildId, 'a'.repeat(16))
  assert.equal(manifest.platforms.macos.signed, true)
  assert.equal(manifest.platforms.macos.notarized, true)
  assert.match(manifest.platforms.macos.url, /^https:\/\/github\.com\/ensync\/ensync-downloads\//)

  assert.equal(manifest.platforms.windows.status, 'available')
  assert.equal(manifest.platforms.windows.reason, null)
  assert.equal(manifest.platforms.windows.buildId, 'b'.repeat(16))
  assert.equal(manifest.platforms.windows.signed, true)
  assert.equal(manifest.platforms.windows.notarized, null)
  assert.match(manifest.platforms.windows.url, /Ensync-1\.2\.3-windows-x64\.exe/)
})

test('prerelease generation writes only the beta manifest and labels its channel', async () => {
  const version = '1.2.3-beta.1'
  const { input, output } = await fixture({ version })
  const result = generate(input, output, { tag: `v${version}`, channel: 'beta' })
  assert.equal(result.status, 0, result.stderr)

  const manifest = JSON.parse(await readFile(join(output, 'releases-beta.json'), 'utf8'))
  assert.equal(manifest.channel, 'beta')
  assert.equal(manifest.latest.version, version)
  await assert.rejects(readFile(join(output, 'releases.json')), { code: 'ENOENT' })
})

test('release generation refuses a tag that does not match its selected channel', async () => {
  const stable = await fixture()
  const stableAsBeta = generate(stable.input, stable.output, { channel: 'beta' })
  assert.notEqual(stableAsBeta.status, 0)
  assert.match(stableAsBeta.stderr, /beta channel requires/)

  const prerelease = await fixture({ version: '1.2.3-beta.1' })
  const betaAsStable = generate(prerelease.input, prerelease.output, {
    tag: 'v1.2.3-beta.1',
    channel: 'stable',
  })
  assert.notEqual(betaAsStable.status, 0)
  assert.match(betaAsStable.stderr, /prerelease tag may publish only/)
})

test('release generation never copies a private uncertified Store package into public assets', async () => {
  const { input, output } = await fixture({ includePrivateStorePackage: true })
  const result = generate(input, output)
  assert.equal(result.status, 0, result.stderr)
  await assert.rejects(readFile(join(output, 'Ensync-1.2.3-windows-store-x64.appx')), { code: 'ENOENT' })
  const checksums = await readFile(join(output, 'SHA256SUMS.txt'), 'utf8')
  assert.doesNotMatch(checksums, /windows-store/)
})

test('release generation refuses unsigned Windows direct artifacts', async () => {
  const { input, output } = await fixture({ windowsSigned: false })
  const result = generate(input, output)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /windows artifacts are unsigned/)
})

test('release generation refuses a private Store attestation as a direct Windows release', async () => {
  const { input, output } = await fixture()
  const path = join(input, 'attestation-windows.json')
  const attestation = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...attestation, distribution: 'microsoft-store' }))
  const result = generate(input, output)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /private Store attestation/)
})

test('release generation refuses a signed but unnotarized macOS build', async () => {
  const { input, output } = await fixture({ macNotarized: false })
  const result = generate(input, output)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /macOS artifacts are not notarized/)
})

test('release generation refuses dirty or channel-mismatched attestations', async () => {
  const dirty = await fixture()
  const path = join(dirty.input, 'attestation-windows.json')
  const attestation = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...attestation, sourceDirty: true }))
  const dirtyResult = generate(dirty.input, dirty.output)
  assert.notEqual(dirtyResult.status, 0)
  assert.match(dirtyResult.stderr, /clean stable source build/)

  const beta = await fixture()
  const betaResult = spawnSync(process.execPath, [
    generator,
    '--input', beta.input,
    '--output', beta.output,
    '--tag', 'v1.2.3',
    '--repository', 'ensync/ensync-downloads',
    '--channel', 'beta',
    '--source-commit', sourceCommit,
  ], { encoding: 'utf8' })
  assert.notEqual(betaResult.status, 0)
  assert.match(betaResult.stderr, /prerelease tag/)
})

test('macOS-only generation publishes a signed notarized DMG and keeps Windows unavailable', async () => {
  const { input, output } = await macosOnlyFixture()
  const result = generateMacosOnly(input, output)
  assert.equal(result.status, 0, result.stderr)

  const manifest = JSON.parse(await readFile(join(output, 'releases-beta.json'), 'utf8'))
  assert.equal(manifest.channel, 'beta')
  assert.equal(manifest.platforms.macos.status, 'available')
  assert.equal(manifest.platforms.macos.signed, true)
  assert.equal(manifest.platforms.macos.notarized, true)
  assert.match(manifest.platforms.macos.url, /Ensync-0\.1\.0-beta\.1-mac-universal\.dmg/)

  assert.equal(manifest.platforms.windows.status, 'unavailable')
  assert.equal(manifest.platforms.windows.signed, false)
  assert.equal(manifest.platforms.windows.notarized, null)
  assert.equal(manifest.platforms.windows.url, null)

  const checksums = await readFile(join(output, 'SHA256SUMS.txt'), 'utf8')
  assert.match(checksums, /mac-universal\.dmg/)
  assert.doesNotMatch(checksums, /windows|\.exe/)
})

test('macOS-only generation refuses unsigned or unnotarized macOS artifacts', async () => {
  const unsigned = await macosOnlyFixture({ macSigned: false })
  const unsignedResult = generateMacosOnly(unsigned.input, unsigned.output)
  assert.notEqual(unsignedResult.status, 0)
  assert.match(unsignedResult.stderr, /artifacts are unsigned/)

  const unnotarized = await macosOnlyFixture({ macNotarized: false })
  const unnotarizedResult = generateMacosOnly(unnotarized.input, unnotarized.output)
  assert.notEqual(unnotarizedResult.status, 0)
  assert.match(unnotarizedResult.stderr, /not notarized/)
})

test('macOS-only generation rejects a stray direct Windows artifact', async () => {
  const { input, output } = await macosOnlyFixture()
  await writeFile(join(input, 'Ensync-0.1.0-beta.1-windows-x64.exe'), Buffer.alloc(1_000_001, 9))
  const result = generateMacosOnly(input, output)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must not include Windows artifacts/)
})

test('macOS-only generation rejects a direct Windows attestation', async () => {
  const { input, output } = await macosOnlyFixture()
  await writeFile(join(input, 'attestation-windows.json'), JSON.stringify({
    schemaVersion: 1,
    platform: 'windows',
    version: '0.1.0-beta.1',
    buildId: 'b'.repeat(16),
    channel: 'beta',
    sourceCommit,
    sourceDirty: false,
    builtAt: '2026-08-07T10:00:00.000Z',
    signed: true,
    notarized: null,
    architectures: ['x64'],
    distribution: 'direct',
    artifacts: [],
  }))
  const result = generateMacosOnly(input, output)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must not include a direct Windows attestation/)
})
