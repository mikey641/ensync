const path = require('node:path')

module.exports = async function notarizeMacArtifacts(context) {
  const diskImages = context.artifactPaths.filter((artifactPath) => path.extname(artifactPath).toLowerCase() === '.dmg')
  if (diskImages.length === 0) return []

  const appleId = process.env.ENSYNC_APPLE_ID
  const appleIdPassword = process.env.ENSYNC_APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.ENSYNC_APPLE_TEAM_ID
  const supplied = [appleId, appleIdPassword, teamId].filter(Boolean).length
  if (supplied === 0) {
    console.log('macOS artifact notarization skipped: no Ensync notarization secrets were supplied.')
    return []
  }
  if (supplied !== 3) {
    throw new Error(
      'macOS artifact notarization requires ENSYNC_APPLE_ID, ENSYNC_APPLE_APP_SPECIFIC_PASSWORD, and ENSYNC_APPLE_TEAM_ID together.',
    )
  }

  if (diskImages.length !== 1) {
    throw new Error(`Expected exactly one macOS DMG for notarization, found ${diskImages.length}.`)
  }

  const { notarize, staple } = require('@electron/notarize')
  await notarize({
    appPath: diskImages[0],
    appleId,
    appleIdPassword,
    teamId,
  })
  await staple({ appPath: diskImages[0] })
  return []
}
