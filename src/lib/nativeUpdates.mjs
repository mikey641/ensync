/**
 * Renderer side of the desktop update service.
 *
 * The main process ships VS Code's `State` object verbatim (see
 * `desktop/src/update/update.mjs`) wrapped in a snapshot that also carries the
 * installed version, the selected channel and mode, and the last feed notice.
 * Every affordance below is derived from the state type, the way VS Code's own
 * update contribution derives its menu items — the main process never sends
 * `can*` flags.
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

export const DisablementReason = Object.freeze({
  NotBuilt: 'not built',
  DisabledByEnvironment: 'disabled by environment',
  ManuallyDisabled: 'manually disabled',
  MissingConfiguration: 'missing configuration',
  InvalidConfiguration: 'invalid configuration',
  UnsupportedPlatform: 'unsupported platform',
  StoreManaged: 'store managed',
  UnsignedBuild: 'unsigned build',
})

export const UPDATE_MODES = Object.freeze([
  { value: 'default', label: 'Automatic', description: 'Check for updates automatically and periodically.' },
  { value: 'start', label: 'On launch only', description: 'Check once per launch; no background checks.' },
  { value: 'manual', label: 'Manual', description: 'Only check when you ask.' },
  { value: 'none', label: 'Off', description: 'Never check for updates.' },
])

const BROWSER_UPDATE_SNAPSHOT = Object.freeze({
  state: Object.freeze({ type: StateType.Disabled, reason: DisablementReason.UnsupportedPlatform }),
  installedVersion: null,
  installedBuildId: null,
  channel: 'stable',
  mode: 'none',
  updateType: 'archive',
  availableVersion: null,
  checkedAt: null,
  notice: 'Native updates are available only in a signed Ensync desktop installation.',
  releaseNotesUrl: null,
  installActionLabel: null,
})

const DISABLEMENT_MESSAGES = Object.freeze({
  [DisablementReason.NotBuilt]: 'Updates are unavailable in development builds. Install a signed Ensync release to use native updates.',
  [DisablementReason.DisabledByEnvironment]: 'Updates are disabled for this launch by the environment.',
  [DisablementReason.ManuallyDisabled]: 'Update checks are turned off. Choose another update mode to turn them back on.',
  [DisablementReason.MissingConfiguration]: 'This build does not have a configured HTTPS update feed.',
  [DisablementReason.InvalidConfiguration]: 'The configured update feed is not a valid HTTPS URL.',
  [DisablementReason.UnsupportedPlatform]: 'Signed Ensync releases are published for macOS and Windows only.',
  [DisablementReason.StoreManaged]: 'Updates for this Microsoft Store installation are delivered by Microsoft Store.',
  [DisablementReason.UnsignedBuild]: 'This installed build is not verified as signed. Native updates are disabled.',
})

function bridgeFor(target) {
  const bridge = target?.ensyncDesktop
  return bridge
    && typeof bridge.getUpdateState === 'function'
    && typeof bridge.checkForUpdates === 'function'
    && typeof bridge.downloadUpdate === 'function'
    && typeof bridge.cancelUpdateDownload === 'function'
    && typeof bridge.applyUpdate === 'function'
    && typeof bridge.setUpdateChannel === 'function'
    && typeof bridge.setUpdateMode === 'function'
    && typeof bridge.onUpdateState === 'function'
    ? bridge
    : null
}

async function invoke(target, method, ...args) {
  const bridge = bridgeFor(target)
  if (!bridge) return BROWSER_UPDATE_SNAPSHOT
  try {
    return await bridge[method](...args)
  } catch {
    return {
      ...BROWSER_UPDATE_SNAPSHOT,
      notice: 'The native update service did not respond. No update action was taken.',
    }
  }
}

export const browserUpdateSnapshot = () => BROWSER_UPDATE_SNAPSHOT
export const getNativeUpdateState = (target = globalThis) => invoke(target, 'getUpdateState')
export const checkForNativeUpdates = (target = globalThis) => invoke(target, 'checkForUpdates')
export const downloadNativeUpdate = (target = globalThis) => invoke(target, 'downloadUpdate')
export const cancelNativeUpdateDownload = (target = globalThis) => invoke(target, 'cancelUpdateDownload')
export const applyNativeUpdate = (target = globalThis) => invoke(target, 'applyUpdate')

export function setNativeUpdateChannel(channel, target = globalThis) {
  if (channel !== 'stable' && channel !== 'beta') return Promise.resolve(BROWSER_UPDATE_SNAPSHOT)
  return invoke(target, 'setUpdateChannel', channel)
}

export function setNativeUpdateMode(mode, target = globalThis) {
  if (!UPDATE_MODES.some((entry) => entry.value === mode)) return Promise.resolve(BROWSER_UPDATE_SNAPSHOT)
  return invoke(target, 'setUpdateMode', mode)
}

export function subscribeToNativeUpdateState(callback, target = globalThis) {
  const bridge = bridgeFor(target)
  return bridge ? bridge.onUpdateState(callback) : () => {}
}

const type = (snapshot) => snapshot?.state?.type ?? StateType.Uninitialized

/** A check is only accepted from Idle, exactly as `AbstractUpdateService` enforces. */
export const canCheckForUpdates = (snapshot) => type(snapshot) === StateType.Idle
export const canDownloadUpdate = (snapshot) => type(snapshot) === StateType.AvailableForDownload
export const canCancelUpdateDownload = (snapshot) => type(snapshot) === StateType.Downloading
export const canApplyUpdate = (snapshot) => type(snapshot) === StateType.Downloaded

/** Switching feeds or modes mid-transfer would strand a partial download. */
export function canChangeUpdateSettings(snapshot) {
  const current = type(snapshot)
  if (current === StateType.Downloading || current === StateType.Updating) return false
  if (current === StateType.Cancelling || current === StateType.Overwriting) return false
  if (current !== StateType.Disabled) return true
  // A permanently disabled build has nothing to re-enable.
  return snapshot.state.reason === DisablementReason.ManuallyDisabled
}

export function isUpdateBusy(snapshot) {
  const current = type(snapshot)
  return current === StateType.CheckingForUpdates
    || current === StateType.Downloading
    || current === StateType.Updating
    || current === StateType.Overwriting
    || current === StateType.Cancelling
}

export function updateStatusLabel(snapshot) {
  const state = snapshot?.state
  switch (type(snapshot)) {
    case StateType.Disabled:
      return state.reason === DisablementReason.StoreManaged ? 'Managed by Store'
        : state.reason === DisablementReason.ManuallyDisabled ? 'Checks off'
          : 'Updates unavailable'
    case StateType.CheckingForUpdates: return 'Checking'
    case StateType.AvailableForDownload: return 'Update available'
    case StateType.Downloading: return 'Downloading'
    case StateType.Downloaded: return 'Ready to install'
    case StateType.Updating: return 'Opening installer'
    case StateType.Ready: return 'Installer opened'
    case StateType.Overwriting: return 'Fetching newer update'
    case StateType.Cancelling: return 'Cancelling'
    case StateType.Restarting: return 'Restarting'
    case StateType.Idle:
      if (state.error) return 'Update error'
      return state.notAvailable ? 'Up to date' : 'Idle'
    default: return 'Not checked'
  }
}

export function updateMessage(snapshot) {
  const state = snapshot?.state
  const version = snapshot?.availableVersion
  switch (type(snapshot)) {
    case StateType.Disabled:
      return DISABLEMENT_MESSAGES[state.reason] ?? 'Native updates are disabled for this build.'
    case StateType.CheckingForUpdates:
      return `Checking the signed ${snapshot.channel} release feed…`
    case StateType.AvailableForDownload:
      return `Ensync ${version} is available as a verified signed ${snapshot.channel} release.`
    case StateType.Downloading:
      return `Downloading Ensync ${version}…`
    case StateType.Downloaded:
      return `Ensync ${version} downloaded and passed checksum and signature verification.`
    case StateType.Updating:
      return 'Opening the verified installer…'
    case StateType.Ready:
      return 'The verified installer was opened. Complete it when ready; Ensync will not quit or restart itself.'
    case StateType.Overwriting:
      return 'A newer release was published; fetching it instead.'
    case StateType.Cancelling:
      return 'Stopping update work…'
    case StateType.Idle:
      if (state.error) return state.error
      if (state.notAvailable) return snapshot.notice ?? `Ensync ${snapshot.installedVersion} is the latest verified release.`
      return snapshot.notice
        ?? `${snapshot.channel === 'beta' ? 'Beta' : 'Stable'} updates are checked and downloaded automatically in the background.`
    default:
      return snapshot?.notice ?? 'Checking whether this build can use signed updates.'
  }
}

/** `{ transferred, total, percent }` while downloading, otherwise `null`. */
export function updateProgress(snapshot) {
  const state = snapshot?.state
  if (state?.type !== StateType.Downloading) return null
  const transferred = state.downloadedBytes ?? 0
  const total = typeof state.totalBytes === 'number' ? state.totalBytes : null
  return {
    transferred,
    total,
    percent: total && total > 0 ? Math.min(100, (transferred / total) * 100) : null,
  }
}
