import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RELEASE_SECRET_NAMES,
  resolveReleaseMode,
  resolveWindowsSigning,
  validateReleasePrerequisites,
} from '../scripts/release-prerequisites.mjs'

function completeEnvironment() {
  const environment = {}
  for (const name of RELEASE_SECRET_NAMES.macos) environment[name] = `value-${name}`
  environment.ENSYNC_WINDOWS_STORE_IDENTITY_NAME = '12345Ensync'
  environment.ENSYNC_WINDOWS_STORE_PUBLISHER = 'CN=12345678-1234-1234-1234-123456789012'
  environment.ENSYNC_WINDOWS_STORE_PUBLISHER_DISPLAY_NAME = 'Mikey Hasson'
  environment.GITHUB_RUN_NUMBER = '42'
  for (const name of RELEASE_SECRET_NAMES.vercel) environment[name] = `value-${name}`
  for (const name of RELEASE_SECRET_NAMES.distribution) environment[name] = `value-${name}`
  environment.ENSYNC_RELEASE_REPOSITORY = 'ensync/ensync-downloads'
  environment.ENSYNC_SOURCE_REPOSITORY = 'ensync/ensync-private'
  environment.GITHUB_REF_NAME = 'v1.2.3'
  environment.ENSYNC_RELEASE_REPOSITORY_VISIBILITY = 'public'
  return environment
}

test('release preflight accepts macOS signing, Store identity, and deployment credentials', () => {
  assert.deepEqual(validateReleasePrerequisites(completeEnvironment()), [])
})

test('Windows packaging accepts complete Microsoft Trusted Signing without a PFX', () => {
  const environment = {}
  for (const name of RELEASE_SECRET_NAMES.windowsAzureConfig) environment[name] = `value-${name}`
  for (const name of RELEASE_SECRET_NAMES.windowsAzureAuth) environment[name] = `value-${name}`

  const resolved = resolveWindowsSigning(environment, { required: true })
  assert.equal(resolved.mode, 'azure')
  assert.equal(resolved.azureSignOptions.publisherName, 'value-ENSYNC_WINDOWS_AZURE_PUBLISHER_NAME')
})

test('release preflight rejects partial, competing, or missing signing configuration', () => {
  assert.throws(
    () => resolveWindowsSigning({ WINDOWS_CSC_LINK: 'certificate' }),
    /WINDOWS_CSC_KEY_PASSWORD/,
  )

  const competing = completeEnvironment()
  for (const name of RELEASE_SECRET_NAMES.windowsCertificate) competing[name] = `value-${name}`
  for (const name of RELEASE_SECRET_NAMES.windowsAzureConfig) competing[name] = `value-${name}`
  for (const name of RELEASE_SECRET_NAMES.windowsAzureAuth) competing[name] = `value-${name}`
  assert.throws(() => resolveWindowsSigning(competing), /not both/)

  const privateRelease = completeEnvironment()
  privateRelease.ENSYNC_RELEASE_REPOSITORY_VISIBILITY = 'private'
  assert.match(validateReleasePrerequisites(privateRelease)[0], /must be public/)

  const sharedRepository = completeEnvironment()
  sharedRepository.ENSYNC_RELEASE_REPOSITORY = sharedRepository.ENSYNC_SOURCE_REPOSITORY
  assert.equal(validateReleasePrerequisites(sharedRepository).some((error) => /separate/.test(error)), true)

  const errors = validateReleasePrerequisites({ GITHUB_REF_NAME: 'release-latest' })
  assert.equal(errors.length, 6)
  assert.equal(errors.some((error) => error.includes('macOS')), true)
  assert.equal(errors.some((error) => error.includes('Windows Store')), true)
  assert.equal(errors.some((error) => error.includes('Vercel')), true)
  assert.equal(errors.some((error) => error.includes('binary distribution')), true)
  assert.equal(errors.some((error) => error.includes('must be public')), true)
  assert.equal(errors.some((error) => error.includes('semantic version')), true)
})

function macosOnlyEnvironment() {
  const environment = {}
  for (const name of RELEASE_SECRET_NAMES.macos) environment[name] = `value-${name}`
  for (const name of RELEASE_SECRET_NAMES.vercel) environment[name] = `value-${name}`
  for (const name of RELEASE_SECRET_NAMES.distribution) environment[name] = `value-${name}`
  environment.ENSYNC_RELEASE_REPOSITORY = 'ensync/ensync-downloads'
  environment.ENSYNC_SOURCE_REPOSITORY = 'ensync/ensync-private'
  environment.ENSYNC_RELEASE_REPOSITORY_VISIBILITY = 'public'
  environment.ENSYNC_RELEASE_MODE = 'macos-only'
  environment.ENSYNC_RELEASE_VERSION = '0.1.0-beta.1'
  environment.ENSYNC_RELEASE_CHANNEL = 'beta'
  return environment
}

test('resolveReleaseMode defaults to full and rejects unknown values', () => {
  assert.equal(resolveReleaseMode({}), 'full')
  assert.equal(resolveReleaseMode({ ENSYNC_RELEASE_MODE: 'macos-only' }), 'macos-only')
  assert.throws(() => resolveReleaseMode({ ENSYNC_RELEASE_MODE: 'windows-only' }), /ENSYNC_RELEASE_MODE/)
})

test('macOS-only preflight accepts Apple, Vercel, and distribution without Windows identity', () => {
  assert.deepEqual(validateReleasePrerequisites(macosOnlyEnvironment()), [])
})

test('macOS-only preflight enforces semantic version and channel rules', () => {
  const missingVersion = macosOnlyEnvironment()
  delete missingVersion.ENSYNC_RELEASE_VERSION
  assert.match(validateReleasePrerequisites(missingVersion)[0], /ENSYNC_RELEASE_VERSION/)

  const stablePrerelease = macosOnlyEnvironment()
  stablePrerelease.ENSYNC_RELEASE_CHANNEL = 'stable'
  assert.match(validateReleasePrerequisites(stablePrerelease).join(' '), /stable .*prerelease/)

  const betaPlainVersion = macosOnlyEnvironment()
  betaPlainVersion.ENSYNC_RELEASE_VERSION = '0.1.0'
  assert.match(validateReleasePrerequisites(betaPlainVersion).join(' '), /beta .*prerelease/)
})
