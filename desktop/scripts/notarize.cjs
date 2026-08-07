const path = require('node:path')

module.exports = async function notarizeMacApplication(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appleId = process.env.ENSYNC_APPLE_ID
  const appleIdPassword = process.env.ENSYNC_APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.ENSYNC_APPLE_TEAM_ID
  const supplied = [appleId, appleIdPassword, teamId].filter(Boolean).length

  if (supplied === 0) {
    console.log('Apple notarization skipped: no Ensync notarization secrets were supplied.')
    return
  }
  if (supplied !== 3) {
    throw new Error(
      'Apple notarization requires ENSYNC_APPLE_ID, ENSYNC_APPLE_APP_SPECIFIC_PASSWORD, and ENSYNC_APPLE_TEAM_ID together.',
    )
  }

  const { notarize, staple } = require('@electron/notarize')
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  })
  await staple({ appPath })
}
