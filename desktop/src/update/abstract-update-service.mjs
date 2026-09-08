/**
 * Port of VS Code's `src/vs/platform/update/electron-main/abstractUpdateService.ts`.
 *
 * The structure, state transitions, scheduling and `update.mode` handling follow
 * upstream. The dependency-injection decorators are replaced by a plain options
 * object because Ensync's Electron main process has no service container, and
 * upstream's telemetry and storage collaborators are dropped because Ensync
 * sends no telemetry.
 *
 * Ensync-specific additions, all of them refusals rather than new powers:
 *  - the installed build must itself be verified as signed before any feed is
 *    contacted (`DisablementReason.UnsignedBuild`);
 *  - a Microsoft Store installation delegates to the Store
 *    (`DisablementReason.StoreManaged`);
 *  - the release channel (`update.channel`) is a user preference, where upstream
 *    reads a fixed product quality.
 */

import {
  CancellationToken,
  CancellationTokenSource,
  Disposable,
  Emitter,
  IntervalTimer,
  isCancellationError,
  MutableDisposable,
  Throttler,
  timeout,
  toDisposable,
} from './base.mjs'
import {
  DisablementReason,
  normalizeUpdateChannel,
  State,
  StateType,
  UpdateChannel,
  UpdateMode,
  UpdateType,
} from './update.mjs'

const noopLog = Object.freeze({
  trace: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
})

/**
 * States representing in-flight or pending update work that takes time to tear
 * down when updates are disabled at runtime. Used to decide whether to surface a
 * transient `Cancelling` state.
 */
function isCancellableState(type) {
  switch (type) {
    case StateType.CheckingForUpdates:
    case StateType.AvailableForDownload:
    case StateType.Downloading:
    case StateType.Downloaded:
    case StateType.Updating:
    case StateType.Ready:
    case StateType.Overwriting:
      return true
    default:
      return false
  }
}

/** A connection is never reported as metered unless the host supplies a real probe. */
export function createUnmeteredConnectionService() {
  const emitter = new Emitter()
  return Object.freeze({
    isConnectionMetered: false,
    whenConnectionStateInitialized: Promise.resolve(),
    onDidChangeIsConnectionMetered: emitter.event,
  })
}

export class AbstractUpdateService extends Disposable {
  /** The release feed this service is currently allowed to use, or undefined when disabled. */
  channel = undefined

  #state = { state: State.Uninitialized, deferred: false }
  _overwrite = false
  #overwriteUpdatesCheckInterval = this._register(new IntervalTimer())

  /** Disabled for a non-reversible reason (unsigned build, Store-managed, missing config). */
  #disabledPermanently = false
  /** Whether one-time platform init has run. */
  #postInitialized = false
  /** Cancels the pending scheduled update check, if any. */
  #scheduler = this._register(new MutableDisposable())
  /** Serializes reconfiguration so overlapping setting changes settle on the latest value. */
  #reconfigureThrottler = this._register(new Throttler())
  #initialized = false

  #onStateChange = this._register(new Emitter())
  onStateChange = this.#onStateChange.event

  constructor(options) {
    super()
    const {
      productVersion,
      buildId = null,
      platform,
      isPackaged,
      storeManaged = false,
      disableUpdates = false,
      executablePath,
      feeds,
      configuration,
      meteredConnection = createUnmeteredConnectionService(),
      logService = noopLog,
      fetchImpl = globalThis.fetch,
      tempRoot,
      openInstaller,
      verifyInstalledBuild,
      verifyInstaller,
      now = Date.now,
      supportsUpdateOverwrite = false,
    } = options ?? {}

    this.productVersion = productVersion
    this.buildId = buildId
    this.platform = platform
    this.isPackaged = isPackaged === true
    this.storeManaged = storeManaged === true
    this.disableUpdates = disableUpdates === true
    this.executablePath = executablePath
    this.feeds = Object.freeze({
      [UpdateChannel.Stable]: feeds?.stable ?? null,
      [UpdateChannel.Beta]: feeds?.beta ?? null,
    })
    this.configurationService = configuration
    this.meteredConnectionService = meteredConnection
    this.logService = logService
    this.fetchImpl = fetchImpl
    this.tempRoot = tempRoot
    this.openInstaller = openInstaller
    this.verifyInstalledBuild = verifyInstalledBuild
    this.verifyInstaller = verifyInstaller
    this.now = now
    this.supportsUpdateOverwrite = supportsUpdateOverwrite === true

    /** Set once the installed build's own signature has been read. */
    this.installedSignerIdentity = null

    // Ensync extras surfaced to the renderer alongside the upstream `State`:
    // when the feed was last read, why it offered nothing, and where the notes are.
    this.lastCheckedAt = null
    this.lastFeedNotice = null
    this.lastReleaseNotesUrl = null

    this._register(this.meteredConnectionService.onDidChangeIsConnectionMetered((isMetered) => {
      if (!isMetered) this.#resumeAutomaticUpdates()
    }))
  }

  get state() {
    return this.#state.state
  }

  setState(state, options) {
    if (state.type === StateType.Updating) {
      this.logService.trace('update#setState', state.type)
    } else {
      this.logService.info('update#setState', state.type)
    }
    this.#state = { state, deferred: options?.deferred ?? false }
    this.#onStateChange.fire(state)

    // Clear transient one-time properties from Idle after delivering the event,
    // so a new window never sees a stale error/notAvailable message.
    if (state.type === StateType.Idle && (state.error || state.notAvailable)) {
      this.#state = { state: State.Idle(state.updateType), deferred: false }
    }

    if (this.supportsUpdateOverwrite) {
      if (state.type === StateType.Ready) {
        this.#overwriteUpdatesCheckInterval.cancelAndSet(() => this.#checkForOverwriteUpdates(), 5 * 60 * 1000)
      } else {
        this.#overwriteUpdatesCheckInterval.cancel()
      }
    }
  }

  #setDeferred(deferred) {
    if (this.#state.deferred !== deferred) {
      this.#state = { ...this.#state, deferred }
    }
  }

  /**
   * Must be called before any other call. Upstream hangs this off the
   * `AfterWindowOpen` lifecycle phase; Ensync's main process awaits it directly
   * after the first window is created, for the same reason: no update work
   * should burn CPU before the first window opens.
   */
  async initialize() {
    if (this.#initialized) return this.state
    this.#initialized = true

    if (!this.isPackaged) {
      this.#setDisabledPermanently(DisablementReason.NotBuilt)
      return this.state // updates are never enabled when running out of sources
    }

    if (this.disableUpdates) {
      this.#setDisabledPermanently(DisablementReason.DisabledByEnvironment)
      this.logService.info('update#ctor - updates are disabled by the environment')
      return this.state
    }

    if (this.storeManaged) {
      this.#setDisabledPermanently(DisablementReason.StoreManaged)
      this.logService.info('update#ctor - updates are delivered by the Microsoft Store')
      return this.state
    }

    if (!this.feeds[UpdateChannel.Stable] && !this.feeds[UpdateChannel.Beta]) {
      this.#setDisabledPermanently(DisablementReason.MissingConfiguration)
      this.logService.info('update#ctor - updates are disabled as there is no update URL')
      return this.state
    }

    // Ensync gate: an installed build that cannot prove its own signature must
    // never trust a release feed, so the network is not touched at all.
    if (!(await this.#verifyInstalledBuildSignature())) {
      this.#setDisabledPermanently(DisablementReason.UnsignedBuild)
      this.logService.info('update#ctor - updates are disabled as this build is not verified as signed')
      return this.state
    }

    await this.meteredConnectionService.whenConnectionStateInitialized

    // React to runtime `update.mode`/`update.channel` changes so switching to or
    // from `none`, or between feeds, applies without a restart.
    this._register(this.configurationService.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('update.mode') || event.affectsConfiguration('update.channel')) {
        this.reconfigure().catch((error) => {
          this.logService.error('update#reconfigure - failed to apply update setting change', error)
        })
      }
    }))

    await this.reconfigure()
    return this.state
  }

  async #verifyInstalledBuildSignature() {
    let signature
    try {
      signature = await this.verifyInstalledBuild({ platform: this.platform, executablePath: this.executablePath })
    } catch (error) {
      this.logService.error('update#ctor - failed to read the installed build signature', error)
      return false
    }
    const identity = typeof signature?.signerIdentity === 'string' ? signature.signerIdentity.trim() : ''
    if (signature?.verified !== true || !identity) return false
    this.installedSignerIdentity = identity
    return true
  }

  /**
   * Evaluates the current `update.mode` setting and brings the service into the
   * matching state. Runs on startup and on every change, enabling or disabling
   * updates without a restart.
   */
  reconfigure() {
    if (!this.#initialized) return Promise.resolve()
    return this.#reconfigureThrottler.queue(() => this.#doReconfigure())
  }

  async #doReconfigure() {
    if (this.#disabledPermanently) return

    const updateMode = this.configurationService.getValue('update.mode')
    const channel = this.#getUpdateChannel(updateMode)

    if (!channel) {
      const reason = DisablementReason.ManuallyDisabled

      // Skip if already disabled for this reason, so a repeated write is a no-op.
      if (this.state.type === StateType.Disabled && this.state.reason === reason) return

      await this.#disable(reason)
      return
    }

    if (!this.buildUpdateFeedUrl(channel)) {
      this.#setDisabledPermanently(DisablementReason.InvalidConfiguration)
      this.logService.info('update#ctor - updates are disabled as the update URL is badly formed')
      return
    }

    // A channel switch must not leave a previous channel's verified installer
    // pending, so tear it down exactly as a runtime disable would.
    if (this.channel !== undefined && this.channel !== channel) {
      await this.cancelUpdate().catch((error) => {
        this.logService.warn('update#reconfigure - failed to cancel pending update', error)
      })
      this.setState(State.Idle(this.getUpdateType()))
    }

    this.channel = channel

    // Move to Idle so one-time platform init can act; it requires Idle.
    if (this.state.type === StateType.Disabled || this.state.type === StateType.Uninitialized) {
      this.setState(State.Idle(this.getUpdateType()))
    }

    if (!this.#postInitialized) {
      await this.postInitialize()
      this.#postInitialized = true
    }

    this.#scheduleAccordingToMode(updateMode)
  }

  /**
   * Disables updates for a reversible reason (user preference), cancelling the
   * scheduled check loop and any in-flight or pending update before moving to
   * Disabled.
   */
  async #disable(reason) {
    this.#scheduler.clear()

    // Show a transient Cancelling state only when there is work to tear down.
    if (isCancellableState(this.state.type)) {
      this.setState(State.Cancelling)
    }

    try {
      await this.cancelUpdate()
    } catch (error) {
      this.logService.warn('update#disable - failed to cancel pending update', error)
    }

    this.channel = undefined
    this.logService.info('update#disable - updates are disabled by user preference')
    this.setState(State.Disabled(reason))
  }

  /** Disables updates for a non-reversible reason; later setting changes are ignored. */
  #setDisabledPermanently(reason) {
    this.#disabledPermanently = true
    this.#scheduler.clear()
    this.setState(State.Disabled(reason))
  }

  #scheduleAccordingToMode(updateMode) {
    this.#scheduler.clear()

    if (updateMode === UpdateMode.Manual) {
      this.logService.info('update#ctor - manual checks only; automatic updates are disabled by user preference')
      return
    }

    if (this.#state.deferred && !this.meteredConnectionService.isConnectionMetered) {
      this.#resumeAutomaticUpdates()
      return
    }

    if (this.state.type !== StateType.Idle) return
    this.#setDeferred(false)

    if (updateMode === UpdateMode.Start) {
      this.logService.info('update#ctor - startup checks only; automatic updates are disabled by user preference')

      // Check for updates only once after 30 seconds
      this.#scheduleCheckForUpdates(30 * 1000, false)
    } else {
      // Start checking for updates after 30 seconds
      this.#scheduleCheckForUpdates(30 * 1000, true)
    }
  }

  #resumeAutomaticUpdates() {
    if (this.#disabledPermanently || !this.#postInitialized || !this.channel) return

    const updateMode = this.configurationService.getValue('update.mode')
    if (updateMode === UpdateMode.None || updateMode === UpdateMode.Manual) return

    if (this.state.type === StateType.AvailableForDownload) {
      if (this.#state.deferred) this.resumeDeferredDownload()
      return
    }

    if (this.state.type === StateType.Ready) {
      if (this.#state.deferred) void this.#checkForOverwriteUpdates()
      return
    }

    if (this.state.type !== StateType.Idle) return

    if (updateMode === UpdateMode.Start && !this.#state.deferred) return
    this.#setDeferred(false)
    this.#scheduleCheckForUpdates(0, updateMode === UpdateMode.Default)
  }

  #getUpdateChannel(updateMode) {
    if (updateMode === UpdateMode.None) return undefined
    return normalizeUpdateChannel(this.configurationService.getValue('update.channel')) ?? UpdateChannel.Stable
  }

  #scheduleCheckForUpdates(delay = 60 * 60 * 1000, repeat = true) {
    const promise = timeout(delay)
    this.#scheduler.value = toDisposable(() => promise.cancel())

    promise
      .then(() => this.checkForUpdates(false))
      .then(() => {
        if (repeat) {
          // Check again after 1 hour
          this.#scheduleCheckForUpdates(60 * 60 * 1000, true)
        }
      })
      .catch((error) => {
        if (!isCancellationError(error)) this.logService.error(error)
      })
  }

  async checkForUpdates(explicit) {
    this.logService.trace('update#checkForUpdates, state = ', this.state.type)

    if (this.state.type !== StateType.Idle) return this.state

    if (!explicit && this.meteredConnectionService.isConnectionMetered) {
      this.#setDeferred(true)
      this.logService.info('update#checkForUpdates - skipping automatic check because connection is metered')
      return this.state
    }

    this.#setDeferred(false)
    await this.doCheckForUpdates(explicit)
    return this.state
  }

  async downloadUpdate(explicit) {
    this.logService.trace('update#downloadUpdate, state = ', this.state.type)

    if (this.state.type !== StateType.AvailableForDownload) return this.state

    if (!explicit && this.meteredConnectionService.isConnectionMetered) {
      this.#setDeferred(true)
      this.logService.info('update#downloadUpdate - skipping download because connection is metered')
      return this.state
    }

    this.#setDeferred(false)
    await this.doDownloadUpdate(this.state)
    return this.state
  }

  async doDownloadUpdate() {
    // noop
  }

  resumeDeferredDownload() {
    void this.downloadUpdate(false)
  }

  deferAutomaticDownload(update, explicit) {
    if (explicit || !this.meteredConnectionService.isConnectionMetered) return false

    this.logService.info('update#deferAutomaticDownload - deferring download because connection is metered')
    this.setState(State.AvailableForDownload(update), { deferred: true })
    return true
  }

  async applyUpdate() {
    this.logService.trace('update#applyUpdate, state = ', this.state.type)

    if (this.state.type !== StateType.Downloaded) return this.state

    await this.doApplyUpdate()
    return this.state
  }

  async doApplyUpdate() {
    // noop
  }

  /**
   * Upstream quits and restarts into the pending update. Ensync never quits or
   * restarts itself, so this is deliberately inert: the user applies the
   * verified installer through `applyUpdate()` and relaunches when ready.
   */
  async quitAndInstall() {
    this.logService.trace('update#quitAndInstall, state = ', this.state.type)

    if (this.state.type !== StateType.Ready) return this.state

    this.logService.info('update#quitAndInstall - Ensync does not quit or restart itself; the installer stays with the user')
    this.doQuitAndInstall()
    return this.state
  }

  async #checkForOverwriteUpdates(explicit = false) {
    if (this.state.type !== StateType.Ready) return false

    if (this.#deferOverwriteCheckIfMetered(explicit)) return false

    this.#setDeferred(false)
    const pendingUpdateVersion = this.state.update.version

    if (!pendingUpdateVersion || pendingUpdateVersion === 'unknown') return false

    let isLatest
    const source = new CancellationTokenSource()
    try {
      const timeoutPromise = timeout(2000, source.token).then(() => { source.cancel(); return undefined })
      isLatest = await Promise.race([this.doIsLatestVersion(pendingUpdateVersion, source.token), timeoutPromise])
    } catch (error) {
      this.logService.warn('update#checkForOverwriteUpdates(): failed to check for updates')
      this.logService.warn(error)
      return false
    } finally {
      source.dispose(true)
    }

    if (isLatest === false && this.state.type === StateType.Ready) {
      if (this.#deferOverwriteCheckIfMetered(explicit)) return false

      this.logService.info('update#readyStateCheck: newer update available, restarting update machinery')

      try {
        await this.cancelPendingUpdate()
      } catch (error) {
        this.logService.error('update#checkForOverwriteUpdates(): failed to cancel pending update, aborting overwrite')
        this.logService.error(error)
        return false
      }

      if (this.#deferOverwriteCheckIfMetered(explicit)) return false

      this._overwrite = true
      this.setState(State.Overwriting(this.state.update, explicit))
      await this.doCheckForUpdates(explicit, pendingUpdateVersion)
      return true
    }

    return false
  }

  #deferOverwriteCheckIfMetered(explicit) {
    if (explicit || !this.meteredConnectionService.isConnectionMetered) return false

    this.#setDeferred(true)
    this.logService.info('update#checkForOverwriteUpdates - deferring overwrite because connection is metered')
    return true
  }

  async isLatestVersion(version, token = CancellationToken.None) {
    if (this.meteredConnectionService.isConnectionMetered) {
      this.logService.info('update#isLatestVersion - skipping automatic check because connection is metered')
      return undefined
    }

    return this.doIsLatestVersion(version, token)
  }

  async doIsLatestVersion() {
    return undefined
  }

  async _applySpecificUpdate() {
    // noop
  }

  getUpdateType() {
    return UpdateType.Archive
  }

  doQuitAndInstall() {
    // noop — see quitAndInstall().
  }

  async postInitialize() {
    // noop
  }

  async cancelPendingUpdate() {
    // noop
  }

  /**
   * Aborts in-flight or pending update work when updates are being disabled at
   * runtime. Platform services override this to also abort in-flight
   * checks/downloads.
   */
  async cancelUpdate() {
    await this.cancelPendingUpdate()
  }

  buildUpdateFeedUrl() {
    throw new Error('buildUpdateFeedUrl must be implemented by a platform update service.')
  }

  async doCheckForUpdates() {
    throw new Error('doCheckForUpdates must be implemented by a platform update service.')
  }
}
