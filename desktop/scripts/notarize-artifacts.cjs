const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { notarize } = require('@electron/notarize')

/**
 * Apple's queue occasionally drops a transient connection while notarytool is
 * waiting, which surfaces as a failed submission through @electron/notarize.
 * Resubmitting the same signed DMG is safe, so one retry heals the blip
 * instead of failing a whole release run. A genuinely rejected DMG fails again
 * on the retry and the build stops.
 */
async function notarizeWithRetry(notarizeOptions) {
  try {
    await notarize(notarizeOptions)
  } catch (error) {
    console.warn(`Apple artifact notarization attempt failed (${error?.message ?? error}); retrying once.`)
    await notarize(notarizeOptions)
  }
}

/**
 * Attach the notarization ticket only when it is missing, keeping the step
 * idempotent across @electron/notarize versions while still hard-failing when
 * the DMG genuinely cannot be stapled.
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

  await notarizeWithRetry({ appPath: diskImages[0], appleId, appleIdPassword, teamId })
  stapleWhenMissing(diskImages[0])
  return []
}
