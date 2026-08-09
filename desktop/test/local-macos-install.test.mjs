import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appExecutableIsRunning,
  ENSYNC_MAC_BUNDLE_IDENTIFIER,
  installLocalMacApp,
} from '../src/local-macos-install.mjs'

async function createFakeApp(path, identifier, marker) {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'bundle-id'), identifier)
  await writeFile(join(path, 'marker'), marker)
}

const inspectFakeBundle = async (path) => (
  await readFile(join(path, 'bundle-id'), 'utf8')
).trim()
const copyFakeBundle = (source, destination) => cp(source, destination, { recursive: true })

test('the local macOS installer atomically replaces the stable Ensync bundle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-local-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceApp = join(root, 'release', 'Ensync.app')
  const destinationApp = join(root, 'Applications', 'Ensync.app')
  await createFakeApp(sourceApp, ENSYNC_MAC_BUNDLE_IDENTIFIER, 'new')
  await createFakeApp(destinationApp, ENSYNC_MAC_BUNDLE_IDENTIFIER, 'old')

  const result = await installLocalMacApp({
    platform: 'darwin',
    sourceApp,
    destinationApp,
    inspectBundle: inspectFakeBundle,
    copyBundle: copyFakeBundle,
    getProcessCommands: async () => '',
  })

  assert.deepEqual(result, { destinationApp })
  assert.equal(await readFile(join(destinationApp, 'marker'), 'utf8'), 'new')
  assert.deepEqual(
    (await readdir(join(root, 'Applications'))).filter((name) => name.startsWith('.Ensync.app.')),
    [],
  )
})

test('the local macOS installer refuses a different app or a running stable Ensync', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-local-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sourceApp = join(root, 'release', 'Ensync.app')
  const destinationApp = join(root, 'Applications', 'Ensync.app')
  await createFakeApp(sourceApp, ENSYNC_MAC_BUNDLE_IDENTIFIER, 'new')
  await createFakeApp(destinationApp, 'example.other-app', 'other')

  await assert.rejects(installLocalMacApp({
    platform: 'darwin',
    sourceApp,
    destinationApp,
    inspectBundle: inspectFakeBundle,
    copyBundle: copyFakeBundle,
    getProcessCommands: async () => '',
  }), /non-Ensync app/u)
  assert.equal(await readFile(join(destinationApp, 'marker'), 'utf8'), 'other')

  await writeFile(join(destinationApp, 'bundle-id'), ENSYNC_MAC_BUNDLE_IDENTIFIER)
  await assert.rejects(installLocalMacApp({
    platform: 'darwin',
    sourceApp,
    destinationApp,
    inspectBundle: inspectFakeBundle,
    copyBundle: copyFakeBundle,
    getProcessCommands: async () => `${join(destinationApp, 'Contents', 'MacOS', 'Ensync')}\n`,
  }), /Quit the installed Ensync app/u)
  assert.equal(await readFile(join(destinationApp, 'marker'), 'utf8'), 'other')
})

test('running-process detection matches only the exact installed Ensync executable', () => {
  const appPath = '/Applications/Ensync.app'
  assert.equal(appExecutableIsRunning(
    '/Applications/Ensync.app/Contents/MacOS/Ensync --flag\n',
    appPath,
  ), true)
  assert.equal(appExecutableIsRunning(
    '/tmp/Ensync.app/Contents/MacOS/Ensync\n',
    appPath,
  ), false)
})
