const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const IDENTITY_NAME_PATTERN = /^[A-Za-z0-9.-]{3,50}$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export const WINDOWS_STORE_INPUT_NAMES = Object.freeze([
  'ENSYNC_WINDOWS_STORE_IDENTITY_NAME',
  'ENSYNC_WINDOWS_STORE_PUBLISHER',
  'ENSYNC_WINDOWS_STORE_PUBLISHER_DISPLAY_NAME',
  'GITHUB_RUN_NUMBER',
])

function requiredValue(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Windows Store packaging is missing ${name}.`)
  }
  return value.trim()
}

function boundedComponent(value, label, { minimum = 0 } = {}) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > 65_535) {
    throw new Error(`${label} must be an integer from ${minimum} to 65535.`)
  }
  return parsed
}

export function windowsStorePackageVersion(productVersion, buildNumber) {
  const match = typeof productVersion === 'string' ? productVersion.match(SEMVER_PATTERN) : null
  if (!match) throw new Error('Windows Store packaging requires a semantic product version.')
  const productMajor = boundedComponent(match[1], 'Product major version')
  const productMinor = boundedComponent(match[2], 'Product minor version')
  const storeMajor = productMajor + 1
  if (storeMajor > 65_535) throw new Error('Product major version is too large for Microsoft Store packaging.')
  const storeBuild = boundedComponent(buildNumber, 'GITHUB_RUN_NUMBER', { minimum: 1 })
  return `${storeMajor}.${productMinor}.${storeBuild}.0`
}

export function resolveWindowsStorePackageConfig(environment = process.env, { productVersion } = {}) {
  const identityName = requiredValue(environment, 'ENSYNC_WINDOWS_STORE_IDENTITY_NAME')
  const publisher = requiredValue(environment, 'ENSYNC_WINDOWS_STORE_PUBLISHER')
  const publisherDisplayName = requiredValue(environment, 'ENSYNC_WINDOWS_STORE_PUBLISHER_DISPLAY_NAME')
  const buildNumber = requiredValue(environment, 'GITHUB_RUN_NUMBER')

  if (!IDENTITY_NAME_PATTERN.test(identityName) || identityName.startsWith('.') || identityName.endsWith('.')) {
    throw new Error('ENSYNC_WINDOWS_STORE_IDENTITY_NAME must be the exact 3-50 character Partner Center package identity name.')
  }
  if (publisher.length > 8_192 || CONTROL_CHARACTER_PATTERN.test(publisher) || !/^[A-Za-z][A-Za-z0-9.]*=/.test(publisher)) {
    throw new Error('ENSYNC_WINDOWS_STORE_PUBLISHER must be the exact Partner Center publisher distinguished name.')
  }
  if (publisherDisplayName.length > 256 || CONTROL_CHARACTER_PATTERN.test(publisherDisplayName)) {
    throw new Error('ENSYNC_WINDOWS_STORE_PUBLISHER_DISPLAY_NAME must be the exact Partner Center publisher display name.')
  }

  return Object.freeze({
    applicationId: 'Ensync',
    identityName,
    publisher,
    publisherDisplayName,
    packageVersion: windowsStorePackageVersion(productVersion, buildNumber),
  })
}

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function tagAttribute(source, tagName, attributeName) {
  const tag = source.match(new RegExp(`<${tagName}\\b[^>]*>`, 'i'))?.[0]
  const value = tag?.match(new RegExp(`\\b${attributeName}="([^"]*)"`, 'i'))?.[1]
  return typeof value === 'string' ? decodeXml(value) : null
}

function elementText(source, elementName) {
  const value = source.match(new RegExp(`<${elementName}\\b[^>]*>([^<]*)</${elementName}>`, 'i'))?.[1]
  return typeof value === 'string' ? decodeXml(value.trim()) : null
}

export function inspectWindowsStoreManifest(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('The AppX manifest is missing.')
  return Object.freeze({
    identityName: tagAttribute(source, 'Identity', 'Name'),
    publisher: tagAttribute(source, 'Identity', 'Publisher'),
    packageVersion: tagAttribute(source, 'Identity', 'Version'),
    architecture: tagAttribute(source, 'Identity', 'ProcessorArchitecture'),
    applicationId: tagAttribute(source, 'Application', 'Id'),
    publisherDisplayName: elementText(source, 'PublisherDisplayName'),
  })
}

export function verifyWindowsStoreManifest(source, expected) {
  const actual = inspectWindowsStoreManifest(source)
  const fields = ['identityName', 'publisher', 'publisherDisplayName', 'packageVersion', 'applicationId']
  for (const field of fields) {
    if (actual[field] !== expected[field]) {
      throw new Error(`AppX manifest ${field} does not match the guarded Partner Center configuration.`)
    }
  }
  if (actual.architecture !== 'x64') throw new Error('The AppX manifest is not an x64 package.')
  return actual
}
