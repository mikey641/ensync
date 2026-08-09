import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createPackage } from '@electron/asar'

import {
  diffBundleTrees,
  normalizeAllowedPath,
  verifyAllowedChanges,
  verifyPreservedBehaviors,
} from '../scripts/verify-local-install-scope.mjs'

async function createAppFixture(root, {
  css,
  main,
  native,
  appJavaScript = '',
  liveTurn = 'params?.threadId === this.#threadId',
}) {
  const app = join(root, 'Ensync.app')
  const resources = join(app, 'Contents', 'Resources')
  const source = join(root, 'asar-source')
  mkdirSync(join(resources, 'ui', 'assets'), { recursive: true })
  mkdirSync(join(resources, 'host'), { recursive: true })
  mkdirSync(join(source, 'src'), { recursive: true })
  writeFileSync(join(resources, 'ui', 'assets', 'index.css'), css)
  writeFileSync(join(resources, 'ui', 'assets', 'App.js'), appJavaScript)
  writeFileSync(join(resources, 'host', 'codex-live-turn.mjs'), liveTurn)
  writeFileSync(join(source, 'package.json'), '{}')
  writeFileSync(join(source, 'src', 'main.mjs'), main)
  writeFileSync(join(source, 'src', 'native-workspaces.mjs'), native)
  await createPackage(source, join(resources, 'app.asar'))
  return app
}

test('local install scope expands app.asar changes to exact embedded files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-install-scope-'))
  const baseRoot = join(directory, 'base')
  const candidateRoot = join(directory, 'candidate')
  mkdirSync(baseRoot)
  mkdirSync(candidateRoot)
  const base = await createAppFixture(baseRoot, {
    css: 'body { color: black }',
    main: 'export const main = true',
    native: 'export const retain = true',
  })
  const candidate = await createAppFixture(candidateRoot, {
    css: 'body { color: green }',
    main: 'export const main = true',
    native: 'export const retain = false',
  })

  const changes = diffBundleTrees(base, candidate)
  assert.deepEqual(changes, [
    'Contents/Resources/app.asar::src/native-workspaces.mjs',
    'Contents/Resources/ui/assets/index.css',
  ])
  assert.throws(
    () => verifyAllowedChanges(changes, ['Contents/Resources/ui/assets/index.css']),
    /native-workspaces\.mjs/,
  )
  assert.equal(verifyAllowedChanges(changes, changes), true)
})

test('local install scope refuses broad, traversal, and unused allowances', () => {
  assert.throws(() => normalizeAllowedPath('Contents/Resources/'), /Broad or unsafe/)
  assert.throws(() => normalizeAllowedPath('../Ensync.app'), /Broad or unsafe/)
  assert.throws(
    () => verifyAllowedChanges(['Contents/Resources/ui/index.html'], ['Contents/Resources/ui/other.css']),
    /did not change/,
  )
})

test('local install scope preserves titlebar and queued-prompt behavior even when files are allowed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-install-behavior-'))
  const baseRoot = join(directory, 'base')
  const candidateRoot = join(directory, 'candidate')
  mkdirSync(baseRoot)
  mkdirSync(candidateRoot)
  const base = await createAppFixture(baseRoot, {
    css: '',
    main: 'nativeWindowFrameOptions TITLEBAR_APPEARANCE_CHANNEL',
    native: '',
    appJavaScript: 'Queue message in this chat Push now Deliver the first queued message to the active Codex turn now',
  })
  const candidate = await createAppFixture(candidateRoot, {
    css: '',
    main: 'export const olderWindow = true',
    native: '',
    appJavaScript: 'Send',
  })

  assert.throws(
    () => verifyPreservedBehaviors(base, candidate),
    /native titlebar\/window chrome/,
  )
  assert.equal(verifyPreservedBehaviors(base, base), true)
})

test('local install scope rejects a candidate missing queued-prompt push behavior', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-install-prompt-behavior-'))
  const baseRoot = join(directory, 'base')
  const candidateRoot = join(directory, 'candidate')
  mkdirSync(baseRoot)
  mkdirSync(candidateRoot)
  const sharedNative = 'nativeWindowFrameOptions TITLEBAR_APPEARANCE_CHANNEL'
  const base = await createAppFixture(baseRoot, {
    css: '',
    main: sharedNative,
    native: '',
    appJavaScript: 'Queue message in this chat Push now Deliver the first queued message to the active Codex turn now',
  })
  const candidate = await createAppFixture(candidateRoot, {
    css: '',
    main: sharedNative,
    native: '',
    appJavaScript: 'Queue message in this chat Deliver the first queued message to the active Codex turn now',
  })

  assert.throws(
    () => verifyPreservedBehaviors(base, candidate),
    /missing required queued-prompt push and live steering markers: Push now/,
  )
})

test('local install scope rejects automatic steering even when Push now remains', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-install-auto-steer-'))
  const baseRoot = join(directory, 'base')
  const candidateRoot = join(directory, 'candidate')
  mkdirSync(baseRoot)
  mkdirSync(candidateRoot)
  const sharedNative = 'nativeWindowFrameOptions TITLEBAR_APPEARANCE_CHANNEL'
  const queueFirstJavaScript = 'Queue message in this chat Push now Deliver the first queued message to the active Codex turn now'
  const base = await createAppFixture(baseRoot, {
    css: '',
    main: sharedNative,
    native: '',
    appJavaScript: queueFirstJavaScript,
  })
  const candidate = await createAppFixture(candidateRoot, {
    css: '',
    main: sharedNative,
    native: '',
    appJavaScript: `${queueFirstJavaScript} Steer the active Codex turn`,
  })

  assert.throws(
    () => verifyPreservedBehaviors(base, candidate),
    /forbidden queued-prompt push and live steering markers: Steer the active Codex turn/,
  )
})

test('local install scope rejects Push now routing that can follow a subagent turn', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ensync-install-live-turn-filter-'))
  const baseRoot = join(directory, 'base')
  const candidateRoot = join(directory, 'candidate')
  mkdirSync(baseRoot)
  mkdirSync(candidateRoot)
  const sharedNative = 'nativeWindowFrameOptions TITLEBAR_APPEARANCE_CHANNEL'
  const queueFirstJavaScript = 'Queue message in this chat Push now Deliver the first queued message to the active Codex turn now'
  const base = await createAppFixture(baseRoot, {
    css: '',
    main: sharedNative,
    native: '',
    appJavaScript: queueFirstJavaScript,
  })
  const candidate = await createAppFixture(candidateRoot, {
    css: '',
    main: sharedNative,
    native: '',
    appJavaScript: queueFirstJavaScript,
    liveTurn: 'params?.turn?.id',
  })

  assert.throws(
    () => verifyPreservedBehaviors(base, candidate),
    /subagent-safe Push now routing/,
  )
})
