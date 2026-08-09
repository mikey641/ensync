import assert from 'node:assert/strict'
import test from 'node:test'

import {
  manifestFilename,
  prepareChannelRelease,
  prepareChannelRollback,
  validateChannelManifest,
} from '../scripts/release-feed.mjs'

const sourceCommits = {
  one: '1111111111111111111111111111111111111111',
  two: '2222222222222222222222222222222222222222',
  three: '3333333333333333333333333333333333333333',
}

function manifest(version, sourceRevision, channel = 'stable') {
  const tag = `v${version}`
  const platform = (name, extension, buildId) => ({
    status: 'available',
    reason: null,
    version,
    url: `https://github.com/ensync/downloads/releases/download/${tag}/Ensync-${version}-${name}.${extension}`,
    sha256: name === 'mac' ? 'a'.repeat(64) : 'b'.repeat(64),
    signed: true,
    notarized: name === 'mac' ? true : null,
    buildId,
    architectures: name === 'mac' ? ['universal'] : ['x64'],
  })
  return {
    schemaVersion: 1,
    channel,
    sourceRevision,
    feedUpdatedAt: '2026-08-07T10:00:00.000Z',
    latest: {
      version,
      publishedAt: '2026-08-07T10:00:00.000Z',
      notesUrl: `https://github.com/ensync/downloads/releases/tag/${tag}`,
    },
    platforms: {
      macos: platform('mac', 'dmg', 'a'.repeat(16)),
      windows: platform('windows', 'exe', 'b'.repeat(16)),
    },
    history: [],
  }
}

function empty(channel) {
  return {
    schemaVersion: 1,
    channel,
    latest: { version: null, publishedAt: null, notesUrl: null },
    platforms: {},
    history: [],
  }
}

test('stable and beta feeds have separate names and version rules', () => {
  assert.equal(manifestFilename('stable'), 'releases.json')
  assert.equal(manifestFilename('beta'), 'releases-beta.json')
  assert.throws(() => validateChannelManifest(manifest('1.2.3-beta.1', sourceCommits.one), 'stable'), /prerelease/)
  assert.throws(() => validateChannelManifest(manifest('1.2.3', sourceCommits.one, 'beta'), 'beta'), /prerelease/)
})

test('promotion retains the previous verified release and refuses version regression', () => {
  const first = manifest('1.2.3', sourceCommits.one)
  const second = manifest('1.2.4', sourceCommits.two)
  const promoted = prepareChannelRelease({
    current: first,
    candidate: second,
    channel: 'stable',
    updatedAt: '2026-08-07T12:00:00.000Z',
  })
  assert.equal(promoted.latest.version, '1.2.4')
  assert.equal(promoted.history.length, 1)
  assert.equal(promoted.history[0].version, '1.2.3')
  assert.equal(promoted.history[0].platforms.macos.sha256, first.platforms.macos.sha256)
  assert.throws(() => prepareChannelRelease({
    current: promoted,
    candidate: manifest('1.2.3', sourceCommits.three),
    channel: 'stable',
  }), /not newer/)
})

test('rollback repoints only the feed to retained immutable metadata', () => {
  const first = prepareChannelRelease({
    current: empty('stable'),
    candidate: manifest('1.2.3', sourceCommits.one),
    channel: 'stable',
  })
  const second = prepareChannelRelease({
    current: first,
    candidate: manifest('1.2.4', sourceCommits.two),
    channel: 'stable',
  })
  const rolledBack = prepareChannelRollback({
    current: second,
    channel: 'stable',
    version: '1.2.3',
    updatedAt: '2026-08-07T14:00:00.000Z',
  })
  assert.equal(rolledBack.latest.version, '1.2.3')
  assert.deepEqual(rolledBack.platforms, first.platforms)
  assert.equal(rolledBack.sourceRevision, sourceCommits.one)
  assert.deepEqual(rolledBack.rollback, {
    fromVersion: '1.2.4',
    toVersion: '1.2.3',
    preparedAt: '2026-08-07T14:00:00.000Z',
  })
  assert.equal(rolledBack.history.some((entry) => entry.version === '1.2.4'), true)
  assert.throws(() => prepareChannelRollback({
    current: rolledBack,
    channel: 'stable',
    version: '1.2.2',
  }), /not retained/)
})
