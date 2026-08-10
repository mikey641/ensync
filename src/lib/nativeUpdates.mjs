const BROWSER_UPDATE_STATE = Object.freeze({
  installedVersion: null,
  installedBuildId: null,
  channel: 'stable',
  phase: 'unavailable',
  message: 'Native updates are available only in a signed Ensync desktop installation.',
  availableVersion: null,
  checkedAt: null,
  releaseNotesUrl: null,
  progress: null,
  canCheck: false,
  canDownload: false,
  canCancel: false,
  canInstall: false,
  canChangeChannel: false,
  installActionLabel: null,
})

function bridgeFor(target) {
  const bridge = target?.ensyncDesktop
  return bridge
    && typeof bridge.getUpdateState === 'function'
    && typeof bridge.checkForUpdates === 'function'
    && typeof bridge.downloadUpdate === 'function'
    && typeof bridge.cancelUpdateDownload === 'function'
    && typeof bridge.openUpdateInstaller === 'function'
    && typeof bridge.setUpdateChannel === 'function'
    && typeof bridge.onUpdateState === 'function'
    ? bridge
    : null
}

async function invoke(target, method) {
  const bridge = bridgeFor(target)
  if (!bridge) return BROWSER_UPDATE_STATE
  try {
    return await bridge[method]()
  } catch {
    return {
      ...BROWSER_UPDATE_STATE,
      message: 'The native update service did not respond. No update action was taken.',
    }
  }
}

export const browserUpdateState = () => BROWSER_UPDATE_STATE
export const getNativeUpdateState = (target = globalThis) => invoke(target, 'getUpdateState')
export const checkForNativeUpdates = (target = globalThis) => invoke(target, 'checkForUpdates')
export const downloadNativeUpdate = (target = globalThis) => invoke(target, 'downloadUpdate')
export const cancelNativeUpdateDownload = (target = globalThis) => invoke(target, 'cancelUpdateDownload')
export const openNativeUpdateInstaller = (target = globalThis) => invoke(target, 'openUpdateInstaller')

export async function setNativeUpdateChannel(channel, target = globalThis) {
  const bridge = bridgeFor(target)
  if (!bridge || (channel !== 'stable' && channel !== 'beta')) return BROWSER_UPDATE_STATE
  try {
    return await bridge.setUpdateChannel(channel)
  } catch {
    return {
      ...BROWSER_UPDATE_STATE,
      message: 'The native update service did not save the selected channel.',
    }
  }
}

export function subscribeToNativeUpdateState(callback, target = globalThis) {
  const bridge = bridgeFor(target)
  return bridge ? bridge.onUpdateState(callback) : () => {}
}
