/**
 * The main-process side of the update IPC, standing in for VS Code's
 * `updateIpc.ts` channel. Upstream ships the raw `State` to every window; Ensync
 * ships a snapshot that also carries the installed version, the selected feed
 * and mode, and the last feed notice, so a window can render the whole settings
 * pane from one message.
 *
 * Every handler refuses a sender that is not a registered Ensync app window,
 * before any native work runs.
 */

import { supportedPlatform } from './release-feed.mjs'
import { DisablementReason, State, StateType, UpdateChannel, UpdateMode, UpdateType } from './update.mjs'

export const UPDATE_STATE_CHANNEL = 'ensync:updates:state'
export const UPDATE_GET_STATE_CHANNEL = 'ensync:updates:get-state'
export const UPDATE_CHECK_CHANNEL = 'ensync:updates:check'
export const UPDATE_DOWNLOAD_CHANNEL = 'ensync:updates:download'
export const UPDATE_CANCEL_CHANNEL = 'ensync:updates:cancel'
export const UPDATE_APPLY_CHANNEL = 'ensync:updates:apply'
export const UPDATE_QUIT_AND_INSTALL_CHANNEL = 'ensync:updates:quit-and-install'
export const UPDATE_SET_CHANNEL_CHANNEL = 'ensync:updates:set-channel'
export const UPDATE_SET_MODE_CHANNEL = 'ensync:updates:set-mode'

/** `structuredClone`-safe copy of a `State`; `undefined` fields are dropped. */
function plainState(state) {
  return Object.freeze(JSON.parse(JSON.stringify(state)))
}

export function createUpdateSnapshot(service) {
  const state = service.state
  const update = state.update ?? null
  return Object.freeze({
    state: plainState(state),
    installedVersion: service.productVersion ?? null,
    installedBuildId: service.buildId ?? null,
    channel: service.configurationService.getValue('update.channel'),
    mode: service.configurationService.getValue('update.mode'),
    updateType: service.getUpdateType(),
    availableVersion: update?.productVersion ?? update?.version ?? null,
    checkedAt: service.lastCheckedAt ?? null,
    notice: service.lastFeedNotice ?? null,
    releaseNotesUrl: update?.notesUrl ?? service.lastReleaseNotesUrl ?? null,
    installActionLabel: update?.installActionLabel
      ?? supportedPlatform(service.platform)?.installActionLabel
      ?? null,
  })
}

export function unauthorizedUpdateSnapshot() {
  return Object.freeze({
    state: plainState(State.Disabled(DisablementReason.ManuallyDisabled)),
    installedVersion: null,
    installedBuildId: null,
    channel: UpdateChannel.Stable,
    mode: UpdateMode.None,
    updateType: UpdateType.Archive,
    availableVersion: null,
    checkedAt: null,
    notice: 'Native update controls are available only to a registered Ensync app window.',
    releaseNotesUrl: null,
    installActionLabel: null,
  })
}

export function createAuthorizedUpdateHandler({ isAuthorized, action }) {
  if (typeof isAuthorized !== 'function' || typeof action !== 'function') {
    throw new TypeError('Update IPC authorization and action are required.')
  }
  return async (event, ...args) => (isAuthorized(event) ? action(...args) : unauthorizedUpdateSnapshot())
}

/** The channel-to-action table `main.mjs` registers on `ipcMain`. */
export function updateIpcActions(manager) {
  return new Map([
    [UPDATE_GET_STATE_CHANNEL, () => manager.getSnapshot()],
    [UPDATE_CHECK_CHANNEL, () => manager.checkForUpdates(true)],
    [UPDATE_DOWNLOAD_CHANNEL, () => manager.downloadUpdate(true)],
    [UPDATE_CANCEL_CHANNEL, () => manager.cancelDownload()],
    [UPDATE_APPLY_CHANNEL, () => manager.applyUpdate()],
    [UPDATE_QUIT_AND_INSTALL_CHANNEL, () => manager.quitAndInstall()],
    [UPDATE_SET_CHANNEL_CHANNEL, (channel) => manager.setChannel(channel)],
    [UPDATE_SET_MODE_CHANNEL, (mode) => manager.setMode(mode)],
  ])
}

export { StateType }
