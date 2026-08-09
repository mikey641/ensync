import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBuildInfo, normalizeBuildInfo, readBuildInfoFile } from '../src/build-info.mjs'
import { collectBuildInfo, writeBuildInfo } from '../scripts/write-build-info.mjs'

const sourceCommit = '35642bfda02d82e007a1639dbd2c642b67c01b7d'

test('build identity records exact version, source state, channel, and time', () => {
  const build = createBuildInfo({
    appVersion: '1.2.3-beta.2',
    channel: 'beta',
    sourceCommit,
    sourceDirty: false,
    builtAt: '2026-08-07T10:20:30.000Z',
  })
  assert.equal(build.buildId.length, 16)
  assert.equal(build.sourceCommit, sourceCommit)
  assert.deepEqual(normalizeBuildInfo(build), build)
  assert.equal(normalizeBuildInfo({ ...build, sourceDirty: true }), null)
  assert.equal(normalizeBuildInfo(build, { expectedVersion: '1.2.4' }), null)
})

test('packaging build identity supports explicit CI provenance without reading mutable Git state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-build-info-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const packagePath = join(directory, 'package.json')
  const outputPath = join(directory, 'generated', 'build-info.json')
  await writeFile(packagePath, JSON.stringify({ version: '1.2.3' }))
  const environment = {
    ENSYNC_BUILD_CHANNEL: 'stable',
    ENSYNC_SOURCE_COMMIT: sourceCommit,
    ENSYNC_SOURCE_DIRTY: 'false',
    ENSYNC_BUILD_TIME: '2026-08-07T11:22:33.000Z',
  }

  const collected = await collectBuildInfo({ environment, packagePath })
  const written = await writeBuildInfo({ environment, packagePath, outputPath })
  assert.deepEqual(written, collected)
  assert.deepEqual(readBuildInfoFile(outputPath), written)
  assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).channel, 'stable')
})
