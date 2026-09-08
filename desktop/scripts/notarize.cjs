const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { notarize } = require('@electron/notarize')

/**
 * Apple's queue occasionally drops a transient connection while notarytool is
 * waiting, which surfaces as a failed submission through @electron/notarize.
 * Resubmitting the same signed bundle is safe, so one retry heals the blip
 * instead of failing a whole release run. A genuinely rejected bundle fails
 * again on the retry and the build stops.
 */
async function notarizeWithRetry(notarizeOptions) {
  try {
    await notarize(notarizeOptions)
  } catch (error) {
    console.warn(`Apple notarization attempt failed (${error?.message ?? error}); retrying once.`)
    await notarize(notarizeOptions)
  }
}

/**
 * Attach the notarization ticket only when it is missing. @electron/notarize
 * staples the bundle itself, so this stays idempotent across library versions
 * and still hard-fails when the artifact genuinely cannot be stapled.
 */
function stapleWhenMissing(targetPath) {
  let valid = false
  try {
    execFileSync('xcrun', ['stapler', 'validate', targetPath], { stdio: 'ignore' })
    valid = true
  } catch {
    // Ticket missing; staple below.
  }
  if (!valid) {
    execFileSync('xcrun', ['stapler', 'staple', targetPath], { stdio: 'ignore' })
  }
}

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

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  await notarizeWithRetry({ appPath, appleId, appleIdPassword, teamId })
  stapleWhenMissing(appPath)
}
