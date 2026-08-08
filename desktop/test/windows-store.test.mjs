import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  inspectWindowsStoreManifest,
  resolveWindowsStorePackageConfig,
  verifyWindowsStoreManifest,
  windowsStorePackageVersion,
} from '../scripts/windows-store.mjs'

function environment(overrides = {}) {
  return {
    ENSYNC_WINDOWS_STORE_IDENTITY_NAME: '12345Ensync',
    ENSYNC_WINDOWS_STORE_PUBLISHER: 'CN=12345678-1234-1234-1234-123456789012',
    ENSYNC_WINDOWS_STORE_PUBLISHER_DISPLAY_NAME: 'Mikey & Hasson',
    GITHUB_RUN_NUMBER: '42',
    ...overrides,
  }
}

test('Store package versions are monotonic CI quads with a Store-reserved final zero', () => {
  assert.equal(windowsStorePackageVersion('0.1.0-beta.1', '42'), '1.1.42.0')
  assert.equal(windowsStorePackageVersion('1.4.3', '43'), '2.4.43.0')
  assert.throws(() => windowsStorePackageVersion('latest', '42'), /semantic/)
  assert.throws(() => windowsStorePackageVersion('1.2.3', '0'), /1 to 65535/)
})

test('Store identity uses exact guarded Partner Center values', () => {
  assert.deepEqual(resolveWindowsStorePackageConfig(environment(), { productVersion: '0.1.0' }), {
    applicationId: 'Ensync',
    identityName: '12345Ensync',
    publisher: 'CN=12345678-1234-1234-1234-123456789012',
    publisherDisplayName: 'Mikey & Hasson',
    packageVersion: '1.1.42.0',
  })
  assert.throws(
    () => resolveWindowsStorePackageConfig(environment({ ENSYNC_WINDOWS_STORE_IDENTITY_NAME: 'wrong identity' }), { productVersion: '0.1.0' }),
    /package identity name/,
  )
  assert.throws(
    () => resolveWindowsStorePackageConfig(environment({ ENSYNC_WINDOWS_STORE_PUBLISHER: '' }), { productVersion: '0.1.0' }),
    /missing ENSYNC_WINDOWS_STORE_PUBLISHER/,
  )
})

test('Store package attestation verifies AppX identity without claiming Store certification', () => {
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
    <Package>
      <Identity Name="12345Ensync" Publisher="CN=12345678-1234-1234-1234-123456789012" Version="1.1.42.0" ProcessorArchitecture="x64" />
      <Properties><PublisherDisplayName>Mikey &amp; Hasson</PublisherDisplayName></Properties>
      <Applications><Application Id="Ensync" Executable="Ensync.exe" /></Applications>
    </Package>`
  const expected = resolveWindowsStorePackageConfig(environment(), { productVersion: '0.1.0' })
  assert.equal(inspectWindowsStoreManifest(manifest).publisherDisplayName, 'Mikey & Hasson')
  assert.deepEqual(verifyWindowsStoreManifest(manifest, expected), {
    identityName: expected.identityName,
    publisher: expected.publisher,
    packageVersion: expected.packageVersion,
    architecture: 'x64',
    applicationId: expected.applicationId,
    publisherDisplayName: expected.publisherDisplayName,
  })
  assert.throws(
    () => verifyWindowsStoreManifest(manifest.replace('Version="1.1.42.0"', 'Version="1.1.41.0"'), expected),
    /packageVersion/,
  )
})

test('desktop packaging exposes only the guarded Store command and AppX target', async () => {
  const desktopRoot = resolve(import.meta.dirname, '..')
  const manifest = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts.test, 'node test/run-tests.mjs')
  assert.match(manifest.scripts['package:win-store'], /windows-store/)
  assert.equal(manifest.build.appx.applicationId, 'Ensync')
  assert.deepEqual(manifest.build.appx.capabilities, [
    'runFullTrust',
    'internetClient',
    'privateNetworkClientServer',
  ])
})

test('release workflow retains Store packages privately and excludes them from public release downloads', async () => {
  const workflow = await readFile(resolve(import.meta.dirname, '../../.github/workflows/desktop-release.yml'), 'utf8')
  assert.match(workflow, /package:win-store/)
  assert.match(workflow, /desktop\/release\/\*\.appx/)
  assert.match(workflow, /name: ensync-macos-/)
  assert.doesNotMatch(workflow, /release-assets\/\*\.appx/)
})
