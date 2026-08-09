const { readFile, writeFile } = require('node:fs/promises')

const PACKAGE_VERSION_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/

function rewriteWindowsStoreManifestVersion(source, packageVersion) {
  const components = PACKAGE_VERSION_PATTERN.test(packageVersion)
    ? packageVersion.split('.').map(Number)
    : []
  if (components.length !== 4 || components.some((component) => component > 65_535)) {
    throw new Error('The guarded Windows Store package version is invalid.')
  }
  const identity = source.match(/<Identity\b[^>]*>/i)?.[0]
  if (!identity) throw new Error('The generated AppX manifest has no Identity element.')
  const updatedIdentity = identity.replace(
    /\bVersion\s*=\s*(["'])[^"']*\1/i,
    `Version="${packageVersion}"`,
  )
  if (updatedIdentity === identity) throw new Error('The generated AppX manifest has no package version.')
  return source.replace(identity, updatedIdentity)
}

async function appxManifestCreated(manifestPath) {
  const source = await readFile(manifestPath, 'utf8')
  const updated = rewriteWindowsStoreManifestVersion(
    source,
    process.env.ENSYNC_WINDOWS_STORE_PACKAGE_VERSION || '',
  )
  await writeFile(manifestPath, updated, 'utf8')
}

module.exports = appxManifestCreated
module.exports.rewriteWindowsStoreManifestVersion = rewriteWindowsStoreManifestVersion
