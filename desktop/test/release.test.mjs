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
const sourceCommit = '35642bfda02d82e007a1639dbd2c642b67c01b7d'

async function fixture({ macSigned = true, macNotarized = true, windowsSigned = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-release-'))
  const input = join(root, 'input')
  const output = join(root, 'output')
  await mkdir(input)

  const names = [
    'Ensync-1.2.3-mac-universal.dmg',
    'Ensync-1.2.3-mac-universal.zip',
    'Ensync-1.2.3-windows-x64.exe',
    'Ensync-1.2.3-windows-x64.zip',
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
      version: '1.2.3',
      buildId: 'a'.repeat(16),
      channel: 'stable',
      sourceCommit,
      sourceDirty: false,
      builtAt: '2026-08-07T10:00:00.000Z',
      signed: macSigned,
      notarized: macNotarized,
      architectures: ['universal'],
      artifacts: records.filter((record) => record.name.includes('-mac-')),
    },
    {
      schemaVersion: 1,
      platform: 'windows',
      version: '1.2.3',
      buildId: 'b'.repeat(16),
      channel: 'stable',
      sourceCommit,
      sourceDirty: false,
      builtAt: '2026-08-07T10:01:00.000Z',
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

function generate(input, output) {
  return spawnSync(process.execPath, [
    generator,
    '--input', input,
    '--output', output,
    '--tag', 'v1.2.3',
    '--repository', 'ensync/ensync-downloads',
    '--channel', 'stable',
    '--source-commit', sourceCommit,
  ], { encoding: 'utf8' })
}

test('release generation produces download metadata only for signed native artifacts', async () => {
  const { input, output } = await fixture()
  const result = generate(input, output)
  assert.equal(result.status, 0, result.stderr)

  const manifest = JSON.parse(await readFile(join(output, 'releases.json'), 'utf8'))
  assert.equal(manifest.platforms.macos.status, 'available')
  assert.equal(manifest.platforms.windows.status, 'available')
  assert.equal(manifest.channel, 'stable')
  assert.equal(manifest.sourceRevision, sourceCommit)
  assert.match(manifest.platforms.macos.url, /^https:\/\/github\.com\/ensync\/ensync-downloads\//)
  assert.equal(manifest.platforms.macos.buildId, 'a'.repeat(16))
  assert.equal(manifest.platforms.macos.signed, true)
  assert.equal(manifest.platforms.macos.notarized, true)
  assert.equal(manifest.platforms.windows.notarized, null)
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
