import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RELEASE_SECRET_NAMES,
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

  const errors = validateReleasePrerequisites({ GITHUB_REF_NAME: 'release-latest' })
  assert.equal(errors.length, 4)
  assert.equal(errors.some((error) => error.includes('macOS')), true)
  assert.equal(errors.some((error) => error.includes('Windows Store')), true)
  assert.equal(errors.some((error) => error.includes('Vercel')), true)
  assert.equal(errors.some((error) => error.includes('semantic version')), true)
})
