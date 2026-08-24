import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { stageAsarSources } from '../../scripts/install-app.mjs'

// The local installer used to ship only Resources/ui and Resources/host, so
// every change under desktop/src stayed in the old app.asar. The renderer then
// called native bridge methods the installed preload had never heard of, and
// the app told people to restart — which could never help. These tests cover
// the staging step that lets the installer rebuild app.asar from the checkout.

async function fixtureRepo(context, files, buildFiles) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'ensync-asar-fixture-'))
  context.after(() => rm(repoRoot, { recursive: true, force: true }))
  for (const [path, contents] of Object.entries(files)) {
    const full = join(repoRoot, 'desktop', path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, contents)
  }
  await writeFile(
    join(repoRoot, 'desktop', 'package.json'),
    JSON.stringify({ name: 'ensync-desktop', main: 'src/main.mjs', build: { files: buildFiles } }),
  )
  return repoRoot
}

test('stageAsarSources copies exactly the files electron-builder packs, at their bundle paths', async (context) => {
  const repoRoot = await fixtureRepo(context, {
    'src/main.mjs': 'export const main = true\n',
    'src/preload.cjs': 'module.exports = {}\n',
    'src/unpacked.mjs': 'export const excluded = true\n',
  }, ['src/main.mjs', 'src/preload.cjs', 'package.json'])
  const stagingPath = await mkdtemp(join(tmpdir(), 'ensync-asar-staging-'))
  context.after(() => rm(stagingPath, { recursive: true, force: true }))

  const staged = await stageAsarSources({ repoRoot, stagingPath })

  assert.deepEqual(staged.sort(), ['package.json', 'src/main.mjs', 'src/preload.cjs'])
  assert.equal(await readFile(join(stagingPath, 'src', 'main.mjs'), 'utf8'), 'export const main = true\n')
  assert.equal(await readFile(join(stagingPath, 'src', 'preload.cjs'), 'utf8'), 'module.exports = {}\n')
  assert.equal(JSON.parse(await readFile(join(stagingPath, 'package.json'), 'utf8')).main, 'src/main.mjs')
  // A file outside build.files must not reach the bundle just because it sits in src/.
  await assert.rejects(() => readFile(join(stagingPath, 'src', 'unpacked.mjs'), 'utf8'))
})

test('stageAsarSources refuses a manifest that names a missing file', async (context) => {
  const repoRoot = await fixtureRepo(context, {
    'src/main.mjs': 'export const main = true\n',
  }, ['src/main.mjs', 'src/vanished.mjs', 'package.json'])
  const stagingPath = await mkdtemp(join(tmpdir(), 'ensync-asar-staging-'))
  context.after(() => rm(stagingPath, { recursive: true, force: true }))

  // Silently packing a short bundle is how a missing preload method ships.
  await assert.rejects(
    () => stageAsarSources({ repoRoot, stagingPath }),
    /vanished\.mjs/,
  )
})

test('stageAsarSources rejects a desktop package.json without an asar file manifest', async (context) => {
  const repoRoot = await fixtureRepo(context, { 'src/main.mjs': 'export const main = true\n' }, undefined)
  const stagingPath = await mkdtemp(join(tmpdir(), 'ensync-asar-staging-'))
  context.after(() => rm(stagingPath, { recursive: true, force: true }))

  await assert.rejects(() => stageAsarSources({ repoRoot, stagingPath }), /build\.files/)
})
