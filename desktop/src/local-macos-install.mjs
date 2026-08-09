import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export const ENSYNC_MAC_BUNDLE_IDENTIFIER = 'app.ensync.desktop'
export const LOCAL_MAC_INSTALL_PATH = '/Applications/Ensync.app'

async function directoryExists(path) {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function readMacBundleIdentifier(appPath) {
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  const { stdout } = await execFile('/usr/bin/plutil', [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    '-o',
    '-',
    plistPath,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

export function appExecutableIsRunning(processCommands, appPath) {
  const executable = join(appPath, 'Contents', 'MacOS', 'Ensync')
  return String(processCommands ?? '')
    .split(/\r?\n/u)
    .map((command) => command.trim())
    .some((command) => command === executable || command.startsWith(`${executable} `))
}

async function copyMacApp(sourceApp, destinationApp) {
  await execFile('/usr/bin/ditto', [sourceApp, destinationApp])
}

async function readProcessCommands() {
  const { stdout } = await execFile('/bin/ps', ['-axo', 'command='], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

/**
 * Install a locally packaged macOS app at one stable Dock-safe path. The
 * production updater never calls this developer-only helper.
 */
export async function installLocalMacApp(options = {}) {
  const {
    platform = process.platform,
    sourceApp,
    destinationApp = LOCAL_MAC_INSTALL_PATH,
    inspectBundle = readMacBundleIdentifier,
    copyBundle = copyMacApp,
    getProcessCommands = readProcessCommands,
  } = options

  if (platform !== 'darwin') {
    throw new Error('The stable local Ensync app can be installed only on macOS.')
  }
  if (typeof sourceApp !== 'string' || !sourceApp) {
    throw new TypeError('A packaged Ensync.app source path is required.')
  }
  if (!await directoryExists(sourceApp)) {
    throw new Error(`The packaged Ensync app was not found at ${sourceApp}.`)
  }
  const sourceIdentifier = await inspectBundle(sourceApp)
  if (sourceIdentifier !== ENSYNC_MAC_BUNDLE_IDENTIFIER) {
    throw new Error('The packaged source does not have the Ensync bundle identifier.')
  }

  const destinationParent = dirname(destinationApp)
  await mkdir(destinationParent, { recursive: true })
  const suffix = `${Date.now()}-${randomUUID()}`
  const stagingApp = join(destinationParent, `.Ensync.app.install-${suffix}`)
  const backupApp = join(destinationParent, `.Ensync.app.backup-${suffix}`)
  let existingMoved = false
  let stagedPromoted = false

  try {
    await copyBundle(sourceApp, stagingApp)
    if (await inspectBundle(stagingApp) !== ENSYNC_MAC_BUNDLE_IDENTIFIER) {
      throw new Error('The staged app failed its Ensync bundle identifier check.')
    }

    if (await directoryExists(destinationApp)) {
      if (await inspectBundle(destinationApp) !== ENSYNC_MAC_BUNDLE_IDENTIFIER) {
        throw new Error(`Refusing to replace a non-Ensync app at ${destinationApp}.`)
      }
      if (appExecutableIsRunning(await getProcessCommands(), destinationApp)) {
        throw new Error('Quit the installed Ensync app before replacing it.')
      }
      await rename(destinationApp, backupApp)
      existingMoved = true
    }

    await rename(stagingApp, destinationApp)
    stagedPromoted = true
    if (await inspectBundle(destinationApp) !== ENSYNC_MAC_BUNDLE_IDENTIFIER) {
      throw new Error('The installed app failed its Ensync bundle identifier check.')
    }
  } catch (error) {
    if (stagedPromoted) {
      await rm(destinationApp, { recursive: true, force: true }).catch(() => {})
    }
    if (existingMoved) {
      await rename(backupApp, destinationApp).catch(() => {})
    }
    throw error
  } finally {
    await rm(stagingApp, { recursive: true, force: true }).catch(() => {})
  }

  if (existingMoved) {
    await rm(backupApp, { recursive: true, force: true })
  }
  return { destinationApp }
}
