/**
 * Port of VS Code's `src/vs/platform/update/common/update.ts`.
 *
 * Updates are run as a state machine:
 *
 *      Uninitialized
 *           ↓
 *          Idle
 *          ↓  ↑
 *   Checking for Updates  →  Available for Download
 *         ↓                    ↓
 *                     ←   Overwriting
 *     Downloading              ↑
 *                     →      Ready
 *         ↓                    ↑
 *     Downloaded      →     Updating
 *
 * Available: There is an update available for download.
 * Downloaded: A verified installer is on disk, waiting for the user to apply it.
 * Ready: The verified installer has been opened; finishing it completes the update.
 * Overwriting: A newer update is being fetched to replace the pending one.
 * Cancelling: Updates are being disabled at runtime; in-flight/pending work is
 *             being torn down before Disabled.
 *
 * Ensync deviation from upstream: `quitAndInstall()` never quits or restarts the
 * app. `Restarting` therefore exists for interface fidelity but is unreachable,
 * and `Ready` means "the installer is open, finish it when you are ready".
 */

export const StateType = Object.freeze({
  Uninitialized: 'uninitialized',
  Idle: 'idle',
  Disabled: 'disabled',
  CheckingForUpdates: 'checking for updates',
  AvailableForDownload: 'available for download',
  Downloading: 'downloading',
  Downloaded: 'downloaded',
  Updating: 'updating',
  Ready: 'ready',
  Overwriting: 'overwriting',
  Cancelling: 'cancelling',
  Restarting: 'restarting',
})

export const UpdateType = Object.freeze({
  /** An installer that replaces the installed app (Windows NSIS). */
  Setup: 'setup',
  /** An archive or disk image the user applies (macOS DMG). */
  Archive: 'archive',
})

export const DisablementReason = Object.freeze({
  NotBuilt: 'not built',
  DisabledByEnvironment: 'disabled by environment',
  ManuallyDisabled: 'manually disabled',
  MissingConfiguration: 'missing configuration',
  InvalidConfiguration: 'invalid configuration',
  /** Ensync: the platform has no signed release channel (Linux, and anything else). */
  UnsupportedPlatform: 'unsupported platform',
  /** Ensync: the Microsoft Store owns updates for this installation. */
  StoreManaged: 'store managed',
  /** Ensync: the installed build is not verified as signed, so it cannot trust a feed. */
  UnsignedBuild: 'unsigned build',
})

/** The release feeds Ensync publishes. Upstream calls this the product "quality". */
export const UpdateChannel = Object.freeze({
  Stable: 'stable',
  Beta: 'beta',
})

/** `update.mode` values, verbatim from upstream's configuration contribution. */
export const UpdateMode = Object.freeze({
  None: 'none',
  Manual: 'manual',
  Start: 'start',
  Default: 'default',
})

export const State = Object.freeze({
  Uninitialized: Object.freeze({ type: StateType.Uninitialized }),
  Disabled: (reason) => Object.freeze({ type: StateType.Disabled, reason }),
  Idle: (updateType, error, notAvailable) => Object.freeze({
    type: StateType.Idle, updateType, error, notAvailable,
  }),
  CheckingForUpdates: (explicit) => Object.freeze({ type: StateType.CheckingForUpdates, explicit }),
  AvailableForDownload: (update, canInstall) => Object.freeze({
    type: StateType.AvailableForDownload, update, canInstall,
  }),
  Downloading: (update, explicit, overwrite, downloadedBytes, totalBytes, startTime) => Object.freeze({
    type: StateType.Downloading, update, explicit, overwrite, downloadedBytes, totalBytes, startTime,
  }),
  Downloaded: (update, explicit, overwrite) => Object.freeze({
    type: StateType.Downloaded, update, explicit, overwrite,
  }),
  Updating: (update, explicit, currentProgress, maxProgress) => Object.freeze({
    type: StateType.Updating, update, explicit, currentProgress, maxProgress,
  }),
  Ready: (update, explicit, overwrite) => Object.freeze({
    type: StateType.Ready, update, explicit, overwrite,
  }),
  Overwriting: (update, explicit) => Object.freeze({ type: StateType.Overwriting, update, explicit }),
  Cancelling: Object.freeze({ type: StateType.Cancelling }),
  Restarting: (update) => Object.freeze({ type: StateType.Restarting, update }),
})

export function normalizeUpdateChannel(value) {
  return value === UpdateChannel.Beta || value === UpdateChannel.Stable ? value : null
}

export function normalizeUpdateMode(value) {
  return Object.values(UpdateMode).includes(value) ? value : null
}
