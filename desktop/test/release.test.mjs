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

async function fixture({ macSigned = true, macNotarized = true, windowsSigned = true, version = '1.2.3' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-release-'))
  const input = join(root, 'input')
  const output = join(root, 'output')
  await mkdir(input)

  const names = [
    `Ensync-${version}-mac-universal.dmg`,
    `Ensync-${version}-mac-universal.zip`,
    `Ensync-${version}-windows-x64.exe`,
    `Ensync-${version}-windows-x64.zip`,
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

  const attestations = [
    {
      schemaVersion: 1,
      platform: 'macos',
      version,
      signed: macSigned,
      notarized: macNotarized,
      architectures: ['universal'],
      artifacts: records.filter((record) => record.name.includes('-mac-')),
    },
    {
      schemaVersion: 1,
      platform: 'windows',
      version,
      signed: windowsSigned,
      notarized: null,
      architectures: ['x64'],
      artifacts: records.filter((record) => record.name.includes('-windows-')),
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
    '--repository', 'ensync/ensync',
    '--channel', channel,
  ], { encoding: 'utf8' })
}

test('release generation produces download metadata only for signed native artifacts', async () => {
  const { input, output } = await fixture()
  const result = generate(input, output)
  assert.equal(result.status, 0, result.stderr)

  const manifest = JSON.parse(await readFile(join(output, 'releases.json'), 'utf8'))
  assert.equal(manifest.channel, 'stable')
  assert.equal(manifest.platforms.macos.status, 'available')
  assert.equal(manifest.platforms.windows.status, 'available')
  assert.match(manifest.platforms.macos.url, /^https:\/\/github\.com\//)
  assert.equal(manifest.platforms.macos.signed, true)
  assert.equal(manifest.platforms.macos.notarized, true)
  assert.equal(manifest.platforms.windows.notarized, null)
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

test('release generation refuses unsigned Windows artifacts', async () => {
  const { input, output } = await fixture({ windowsSigned: false })
  const result = generate(input, output)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /windows artifacts are unsigned/)
})

test('release generation refuses a signed but unnotarized macOS build', async () => {
  const { input, output } = await fixture({ macNotarized: false })
  const result = generate(input, output)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /macOS artifacts are not notarized/)
})
