/**
 * Incremental update of the installed /Applications/Ensync.app.
 *
 * Copies changed host backend files and (optionally) rebuilt UI assets
 * directly into the existing app bundle, then relaunches the app.
 * This avoids a full electron-builder repackage for every code change.
 *
 * Usage:
 *   node scripts/update-app.mjs            # update host + rebuild UI
 *   node scripts/update-app.mjs --host-only # skip UI rebuild, host files only
 */
import {
  APP_BUNDLE,
  performIncrementalUpdate,
  pathExists,
} from './app-bundle-update.mjs'

const HOST_ONLY = process.argv.includes('--host-only')

async function main() {
  if (!await pathExists(APP_BUNDLE)) {
    console.error(`${APP_BUNDLE} not found. Build and install the app first.`)
    process.exit(1)
  }

  console.log(`Updating ${APP_BUNDLE}...`)

  const { changed, total, relaunched } = await performIncrementalUpdate({
    rebuildUi: !HOST_ONLY,
    killAndRelaunch: true,
  })

  for (const file of changed) console.log(`  ${file}`)
  if (total === 0) console.log('  (all files already up to date)')

  console.log(`\n${total} file(s) updated.`)
  if (relaunched) console.log(`Launched ${APP_BUNDLE}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
