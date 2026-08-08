import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const generator = resolve(desktopRoot, 'scripts/generate-release.mjs')

async function fixture({ macSigned = true, macNotarized = true, includePrivateStorePackage = false, version = '1.2.3' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-release-'))
  const input = join(root, 'input')
  const output = join(root, 'output')
  await mkdir(input)

  const names = [
    `Ensync-${version}-mac-universal.dmg`,
    `Ensync-${version}-mac-universal.zip`,
  ]
  if (includePrivateStorePackage) names.push(`Ensync-${version}-windows-store-x64.appx`)
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

  const attestations = [{
    schemaVersion: 1,
    platform: 'macos',
    version,
    signed: macSigned,
    notarized: macNotarized,
    architectures: ['universal'],
    artifacts: records.filter((record) => record.name.includes('-mac-')),
  }]
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
    '--repository', 'ensync/ensync',
    '--channel', channel,
  ], { encoding: 'utf8' })
}

test('release generation publishes signed macOS artifacts and leaves Windows to Store certification', async () => {
  const { input, output } = await fixture()
  const result = generate(input, output)
  assert.equal(result.status, 0, result.stderr)

  const manifest = JSON.parse(await readFile(join(output, 'releases.json'), 'utf8'))
  assert.equal(manifest.channel, 'stable')
  assert.equal(manifest.platforms.macos.status, 'available')
  assert.equal(manifest.platforms.windows.status, 'unavailable')
  assert.match(manifest.platforms.windows.reason, /Microsoft Store/)
  assert.match(manifest.platforms.macos.url, /^https:\/\/github\.com\//)
  assert.equal(manifest.platforms.macos.signed, true)
  assert.equal(manifest.platforms.macos.notarized, true)
  assert.equal(manifest.platforms.windows.url, null)
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

test('release generation refuses a signed but unnotarized macOS build', async () => {
  const { input, output } = await fixture({ macNotarized: false })
  const result = generate(input, output)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /macOS artifacts are not notarized/)
})
