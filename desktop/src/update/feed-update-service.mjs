/**
 * The check/download/apply half of the update service, shared by the macOS and
 * Windows services.
 *
 * Upstream splits here because macOS delegates to Squirrel.Mac and Windows drives
 * Inno Setup, so the two files have almost nothing in common. Ensync fetches a
 * static signed manifest and downloads the installer itself on both platforms,
 * so that machinery lives once and the platform files stay as thin as upstream's:
 * they choose the `UpdateType`, the wording, and how the installer is applied.
 */

import { unlink } from 'node:fs/promises'

import { CancellationToken, isCancellationError } from './base.mjs'
import { downloadVerifiedInstaller, InstallerVerificationError } from './installer-download.mjs'
import { compareVersions, fetchReleaseManifest, resolveUpdateCandidate, secureUrl } from './release-feed.mjs'
import { AbstractUpdateService } from './abstract-update-service.mjs'
import { State, StateType } from './update.mjs'

export class FeedUpdateService extends AbstractUpdateService {
  /** `{ update, installerPath }` once a verified installer is on disk. */
  availableUpdate = undefined

  /** Aborts an in-flight check/download chain (e.g. when updates are disabled at runtime). */
  #checkAbortController = undefined
  /** Settles when the in-flight check/download chain has fully unwound. */
  #checkPromise = undefined
  /** Set while the user cancelled a download, to distinguish it from a failure. */
  #downloadCancelled = false

  buildUpdateFeedUrl(channel) {
    return secureUrl(this.feeds[channel])?.href
  }

  async doCheckForUpdates(explicit, pendingVersion) {
    if (!this.channel) return

    const url = this.buildUpdateFeedUrl(this.channel)
    if (!url) {
      this.setState(State.Idle(this.getUpdateType()))
      return
    }

    // Only set CheckingForUpdates if we're not already in Overwriting state
    if (this.state.type !== StateType.Overwriting) {
      this.setState(State.CheckingForUpdates(explicit))
    }

    this.#checkAbortController?.abort()
    const controller = this.#checkAbortController = new AbortController()
    const { signal } = controller

    const promise = (async () => {
      const manifest = await fetchReleaseManifest(this.fetchImpl, url, controller)
      if (signal.aborted) return

      // During an overwrite check the comparison is against the pending update,
      // not the installed build, so an equal release is not offered again.
      const against = pendingVersion ?? this.productVersion
      const candidate = resolveUpdateCandidate(manifest, this.platform, against, this.channel)
      this.lastCheckedAt = new Date(this.now()).toISOString()

      if (!candidate.available) {
        this.lastFeedNotice = candidate.reason
        this.lastReleaseNotesUrl = candidate.notesUrl ?? null
        this.#restoreOrIdle(explicit)
        return
      }

      this.lastFeedNotice = null
      this.lastReleaseNotesUrl = candidate.update.notesUrl ?? null

      if (this.deferAutomaticDownload(candidate.update, explicit)) return

      await this.#download(candidate.update, explicit, signal)
    })().catch((error) => {
      if (signal.aborted || isCancellationError(error)) return
      this.logService.error('update#doCheckForUpdates', error)

      // only show message when explicitly checking for updates
      const message = explicit ? this.#describe(error) : undefined
      this.lastFeedNotice = message ?? this.lastFeedNotice

      if (this.state.type === StateType.Overwriting) {
        this._overwrite = false
        this.setState(State.Ready(this.state.update, this.state.explicit, false))
      } else {
        this.setState(State.Idle(this.getUpdateType(), message))
      }
    })

    this.#checkPromise = promise

    void promise.finally(() => {
      if (this.#checkAbortController === controller) this.#checkAbortController = undefined
      if (this.#checkPromise === promise) this.#checkPromise = undefined
    })

    await promise
  }

  /** Nothing newer was published: restore a pending update, or report Idle. */
  #restoreOrIdle(explicit) {
    if (this.state.type === StateType.Overwriting) {
      this._overwrite = false
      this.setState(State.Ready(this.state.update, this.state.explicit, false))
      return
    }
    this.setState(State.Idle(this.getUpdateType(), undefined, explicit || undefined))
  }

  #describe(error) {
    if (error instanceof SyntaxError) {
      return `The ${this.channel} release feed returned invalid JSON. No update was offered.`
    }
    if (error instanceof InstallerVerificationError) {
      return `${error.message} Nothing was installed.`
    }
    return `The ${this.channel} release feed could not be verified. No update was offered.`
  }

  async doDownloadUpdate(state) {
    this.#checkAbortController?.abort()
    const controller = this.#checkAbortController = new AbortController()
    try {
      await this.#download(state.update, true, controller.signal)
    } catch (error) {
      if (controller.signal.aborted || isCancellationError(error)) return
      this.logService.error('update#doDownloadUpdate', error)
      this.setState(State.Idle(this.getUpdateType(), this.#describe(error)))
    } finally {
      if (this.#checkAbortController === controller) this.#checkAbortController = undefined
    }
  }

  async #download(update, explicit, signal) {
    await this.#discardPendingInstaller()
    this.#downloadCancelled = false

    const startTime = this.now()
    this.setState(State.Downloading(update, explicit, this._overwrite, 0, undefined, startTime))

    let result
    try {
      result = await downloadVerifiedInstaller({
        fetchImpl: this.fetchImpl,
        update,
        platform: this.platform,
        tempRoot: this.tempRoot,
        signal,
        now: this.now,
        expectedSignerIdentity: this.installedSignerIdentity,
        verifyInstaller: this.verifyInstaller,
        onProgress: (transferred, total) => {
          if (this.state.type !== StateType.Downloading) return
          this.setState(State.Downloading(update, explicit, this._overwrite, transferred, total ?? undefined, startTime))
        },
      })
    } catch (error) {
      // A user-cancelled download keeps the candidate so it can be retried.
      if (this.#downloadCancelled || signal.aborted) {
        this.#downloadCancelled = false
        if (this.state.type === StateType.Downloading) {
          this.setState(State.AvailableForDownload(update))
        }
        return
      }
      this.logService.error('update#download', error)
      this.lastFeedNotice = this.#describe(error)
      this.setState(State.Idle(this.getUpdateType(), this.lastFeedNotice))
      return
    }

    this.availableUpdate = { update, installerPath: result.installerPath }
    this.setState(State.Downloading(update, explicit, this._overwrite, result.transferred, result.total, startTime))
    this.setState(State.Downloaded(update, explicit, this._overwrite))
    this.logService.info(`Update downloaded: ${JSON.stringify({ version: update.version })}`)
  }

  /**
   * Ensync's stand-in for upstream's background installer: the verified file is
   * handed to the OS and the user finishes it. Nothing is installed, quit or
   * restarted on their behalf.
   */
  async doApplyUpdate() {
    if (this.state.type !== StateType.Downloaded || !this.availableUpdate) return

    const { update } = this.state
    const explicit = this.state.explicit
    this.setState(State.Updating(update, explicit))

    try {
      const errorMessage = await this.openInstaller(this.availableUpdate.installerPath)
      if (errorMessage) throw new Error(errorMessage)
    } catch (error) {
      this.logService.error('update#doApplyUpdate - failed to open the verified installer', error)
      this.setState(State.Downloaded(update, explicit, this._overwrite))
      this.lastFeedNotice = 'Ensync could not open the verified installer. It was not installed.'
      return
    }

    this.lastFeedNotice = null
    this.setState(State.Ready(update, explicit, this._overwrite))
  }

  /** Ensync extra: the user can abandon an in-flight download. */
  cancelDownload() {
    if (this.state.type !== StateType.Downloading) return this.state
    this.#downloadCancelled = true
    this.#checkAbortController?.abort()
    return this.state
  }

  async doIsLatestVersion(version, token = CancellationToken.None) {
    if (!this.channel) return undefined

    const url = this.buildUpdateFeedUrl(this.channel)
    if (!url) return undefined

    try {
      const manifest = await fetchReleaseManifest(this.fetchImpl, url)
      if (token.isCancellationRequested) return undefined
      const latest = manifest?.latest?.version
      const comparison = compareVersions(latest, version)
      return comparison === null ? undefined : comparison <= 0
    } catch (error) {
      this.logService.error('update#isLatestVersion(): failed to check for updates')
      this.logService.error(error)
      return undefined
    }
  }

  async cancelUpdate() {
    const hadInFlightCheck = Boolean(this.#checkAbortController)
    this.#checkAbortController?.abort()
    this.#checkAbortController = undefined

    if (hadInFlightCheck) {
      try {
        await this.#checkPromise
      } catch {
        // the chain swallows its own errors; ignore
      }
    }

    await this.cancelPendingUpdate()
  }

  async cancelPendingUpdate() {
    await this.#discardPendingInstaller()
  }

  async #discardPendingInstaller() {
    const pending = this.availableUpdate
    this.availableUpdate = undefined
    if (pending?.installerPath) await unlink(pending.installerPath).catch(() => {})
  }
}
