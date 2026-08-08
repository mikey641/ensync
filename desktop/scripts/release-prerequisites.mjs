import { resolveWindowsStorePackageConfig, WINDOWS_STORE_INPUT_NAMES } from './windows-store.mjs'

const MAC_SIGNING_NAMES = [
  'MACOS_CSC_LINK',
  'MACOS_CSC_KEY_PASSWORD',
  'ENSYNC_APPLE_ID',
  'ENSYNC_APPLE_APP_SPECIFIC_PASSWORD',
  'ENSYNC_APPLE_TEAM_ID',
]

const WINDOWS_CERTIFICATE_NAMES = [
  'WINDOWS_CSC_LINK',
  'WINDOWS_CSC_KEY_PASSWORD',
]

const WINDOWS_AZURE_CONFIG_NAMES = [
  'ENSYNC_WINDOWS_AZURE_PUBLISHER_NAME',
  'ENSYNC_WINDOWS_AZURE_ENDPOINT',
  'ENSYNC_WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME',
  'ENSYNC_WINDOWS_AZURE_CODE_SIGNING_ACCOUNT_NAME',
]

const WINDOWS_AZURE_AUTH_NAMES = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
]

const VERCEL_NAMES = [
  'VERCEL_TOKEN',
  'VERCEL_ORG_ID',
  'VERCEL_PROJECT_ID',
]

const GITHUB_RELEASE_NAMES = [
  'ENSYNC_RELEASE_REPOSITORY',
  'ENSYNC_RELEASE_TOKEN',
]

function hasValue(environment, name) {
  return typeof environment[name] === 'string' && environment[name].trim().length > 0
}

function inspectGroup(environment, names) {
  const present = names.filter((name) => hasValue(environment, name))
  return {
    any: present.length > 0,
    complete: present.length === names.length,
    missing: names.filter((name) => !present.includes(name)),
  }
}

function incompleteMessage(label, group) {
  return `${label} is incomplete; missing ${group.missing.join(', ')}.`
}

export function resolveWindowsSigning(environment = process.env, { required = false } = {}) {
  const certificate = inspectGroup(environment, WINDOWS_CERTIFICATE_NAMES)
  const azureConfig = inspectGroup(environment, WINDOWS_AZURE_CONFIG_NAMES)
  const azureAuth = inspectGroup(environment, WINDOWS_AZURE_AUTH_NAMES)
  const azureAny = azureConfig.any || azureAuth.any
  const azureComplete = azureConfig.complete && azureAuth.complete

  if (certificate.any && !certificate.complete) {
    throw new Error(incompleteMessage('Windows certificate signing', certificate))
  }
  if (azureAny && !azureConfig.complete) {
    throw new Error(incompleteMessage('Windows Trusted Signing configuration', azureConfig))
  }
  if (azureAny && !azureAuth.complete) {
    throw new Error(incompleteMessage('Windows Trusted Signing authentication', azureAuth))
  }
  if (certificate.complete && azureComplete) {
    throw new Error('Configure either a Windows PFX certificate or Microsoft Trusted Signing, not both.')
  }
  if (certificate.complete) return { mode: 'certificate', azureSignOptions: null }
  if (azureComplete) {
    return {
      mode: 'azure',
      azureSignOptions: {
        publisherName: environment.ENSYNC_WINDOWS_AZURE_PUBLISHER_NAME.trim(),
        endpoint: environment.ENSYNC_WINDOWS_AZURE_ENDPOINT.trim(),
        certificateProfileName: environment.ENSYNC_WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME.trim(),
        codeSigningAccountName: environment.ENSYNC_WINDOWS_AZURE_CODE_SIGNING_ACCOUNT_NAME.trim(),
      },
    }
  }
  if (required) {
    throw new Error('Windows signing is missing; configure a PFX certificate or Microsoft Trusted Signing.')
  }
  return { mode: 'unsigned', azureSignOptions: null }
}

export function validateReleasePrerequisites(environment = process.env) {
  const errors = []
  const mac = inspectGroup(environment, MAC_SIGNING_NAMES)
  const vercel = inspectGroup(environment, VERCEL_NAMES)
  const githubRelease = inspectGroup(environment, GITHUB_RELEASE_NAMES)

  if (!mac.complete) errors.push(incompleteMessage('macOS signing and notarization', mac))
  const store = inspectGroup(environment, WINDOWS_STORE_INPUT_NAMES)
  if (!store.complete) errors.push(incompleteMessage('Windows Store package identity', store))
  if (!vercel.complete) errors.push(incompleteMessage('Vercel production deployment', vercel))
  if (!githubRelease.complete) errors.push(incompleteMessage('public GitHub binary release', githubRelease))

  const releaseRepository = environment.ENSYNC_RELEASE_REPOSITORY
  if (hasValue(environment, 'ENSYNC_RELEASE_REPOSITORY')
    && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(releaseRepository.trim())) {
    errors.push('ENSYNC_RELEASE_REPOSITORY must be an owner/repository name.')
  }

  const tag = environment.GITHUB_REF_NAME
  if (tag && !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
    errors.push(`Release tag ${tag} is not a supported semantic version tag.`)
  }
  if (store.complete && tag && /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
    try {
      resolveWindowsStorePackageConfig(environment, { productVersion: tag.slice(1) })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  const visibility = environment.ENSYNC_RELEASE_REPOSITORY_VISIBILITY
  if (visibility !== 'public') errors.push(
    'The binary release repository must exist and be verified public because the production manifest uses public GitHub asset URLs.',
  )
  return errors
}

export const RELEASE_SECRET_NAMES = Object.freeze({
  macos: MAC_SIGNING_NAMES,
  windowsCertificate: WINDOWS_CERTIFICATE_NAMES,
  windowsAzureConfig: WINDOWS_AZURE_CONFIG_NAMES,
  windowsAzureAuth: WINDOWS_AZURE_AUTH_NAMES,
  windowsStore: WINDOWS_STORE_INPUT_NAMES,
  vercel: VERCEL_NAMES,
  githubRelease: GITHUB_RELEASE_NAMES,
})
