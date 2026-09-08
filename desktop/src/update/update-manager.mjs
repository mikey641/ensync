/**
 * Assembles the update service for this process and exposes it to `main.mjs`.
 *
 * Upstream builds the equivalent graph in `src/vs/code/electron-main/app.ts` out
 * of injected services; Ensync has no service container, so the collaborators
 * (configuration, metered connection, signature verification, logging) are wired
 * here and every one of them stays replaceable from a test.
 *
 * The public surface is upstream's `IUpdateService`
 * (`checkForUpdates` / `downloadUpdate` / `applyUpdate` / `quitAndInstall`) plus
 * two Ensync affordances: cancelling an in-flight download, and choosing the
 * release channel.
 */

import { Emitter } from './base.mjs'
import { verifyDownloadedInstaller, verifyInstalledNativeBuild } from './code-signature.mjs'
import { createUpdateConfiguration } from './update-configuration.mjs'
import { createPlatformUpdateService } from './update-service-factory.mjs'
import { createUpdateSnapshot } from './update-ipc.mjs'
import { normalizeUpdateChannel, normalizeUpdateMode } from './update.mjs'

const consoleLog = Object.freeze({
  trace: () => {},
  info: (...args) => console.log('[ensync-update]', ...args),
  warn: (...args) => console.warn('[ensync-update]', ...args),
  error: (...args) => console.error('[ensync-update]', ...args),
})

export function createUpdateManager({
  installedVersion,
  installedBuildId = null,
  platform,
  storeManaged = false,
  isPackaged,
  executablePath,
  manifestUrls,
  manifestUrl,
  preferences,
  tempRoot,
  openInstaller,
  disableUpdates = false,
  fetchImpl = globalThis.fetch,
  verifyInstalledBuild = (input) => verifyInstalledNativeBuild(input),
  verifyInstaller = (input) => verifyDownloadedInstaller(input),
  now = Date.now,
  logService = consoleLog,
  onSnapshotChange = () => {},
}) {
  if (!preferences || typeof preferences.get !== 'function') {
    throw new TypeError('An update-preferences store is required.')
  }

  const configuration = createUpdateConfiguration(() => preferences.get())
  const feeds = manifestUrls && typeof manifestUrls === 'object'
    ? { stable: manifestUrls.stable ?? null, beta: manifestUrls.beta ?? null }
    : { stable: manifestUrl ?? null, beta: null }

  const service = createPlatformUpdateService({
    productVersion: installedVersion,
    buildId: installedBuildId,
    platform,
    isPackaged,
    storeManaged,
    disableUpdates,
    executablePath,
    feeds,
    configuration,
    logService,
    fetchImpl,
    tempRoot,
    openInstaller,
    verifyInstalledBuild,
    verifyInstaller,
    now,
  })

  const changes = new Emitter()
  const snapshot = () => createUpdateSnapshot(service)

  // Upstream strips the transient `error` / `notAvailable` fields off `Idle`
  // immediately after firing, so a window that opens later never sees a stale
  // message. That means the state a caller could read back is already cleaned,
  // and only the emitted event carries the outcome. Remembering the last emitted
  // snapshot lets an IPC call return what just happened while `getSnapshot()`
  // still answers a fresh window with the cleaned state.
  let lastEmitted = null
  let emitCount = 0
  service.onStateChange(() => {
    lastEmitted = snapshot()
    emitCount += 1
    changes.fire(lastEmitted)
    onSnapshotChange(lastEmitted)
  })

  /** The snapshot for the transition this call caused, or the current one. */
  async function outcomeOf(operation) {
    const before = emitCount
    await operation()
    return emitCount > before ? lastEmitted : snapshot()
  }

  /** A preference write that reconfigures the running service without a restart. */
  async function applyPreference(write, ...keys) {
    try {
      await write()
    } catch (error) {
      logService.error('update#applyPreference - failed to save the update preference', error)
      service.lastFeedNotice = 'The update preference could not be saved. Nothing was changed.'
      return snapshot()
    }
    return outcomeOf(async () => {
      configuration.notifyChanged(...keys)
      await service.reconfigure()
    })
  }

  return Object.freeze({
    /** The underlying platform service, for tests and for future main-process callers. */
    service,

    initialize: () => outcomeOf(() => service.initialize()),

    getSnapshot: snapshot,

    checkForUpdates: (explicit = true) => outcomeOf(() => service.checkForUpdates(explicit)),

    downloadUpdate: (explicit = true) => outcomeOf(() => service.downloadUpdate(explicit)),

    cancelDownload: () => outcomeOf(() => service.cancelDownload?.()),

    applyUpdate: () => outcomeOf(() => service.applyUpdate()),

    quitAndInstall: () => outcomeOf(() => service.quitAndInstall()),

    async setChannel(value) {
      const channel = normalizeUpdateChannel(value)
      if (!channel || channel === configuration.getValue('update.channel')) return snapshot()
      return applyPreference(() => preferences.setUpdateChannel(channel), 'update.channel')
    },

    async setMode(value) {
      const mode = normalizeUpdateMode(value)
      if (!mode || mode === configuration.getValue('update.mode')) return snapshot()
      return applyPreference(() => preferences.setUpdateMode(mode), 'update.mode')
    },

    onSnapshotChange: changes.event,

    dispose() {
      changes.dispose()
      configuration.dispose()
      service.dispose()
    },
  })
}
