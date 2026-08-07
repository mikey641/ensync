const BROWSER_UPDATE_STATE = Object.freeze({
  installedVersion: null,
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

export function subscribeToNativeUpdateState(callback, target = globalThis) {
  const bridge = bridgeFor(target)
  return bridge ? bridge.onUpdateState(callback) : () => {}
}
