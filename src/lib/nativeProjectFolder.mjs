const UNAVAILABLE_MESSAGE = 'The native folder chooser is available in the Ensync desktop app. Enter an absolute path here instead.'
const ERROR_MESSAGE = 'Ensync could not open the system folder chooser.'

function bridgeFor(target) {
  const bridge = target?.ensyncDesktop
  return bridge && typeof bridge.chooseProjectFolder === 'function' ? bridge : null
}

export function nativeProjectFolderPickerAvailable(target = globalThis) {
  return bridgeFor(target) !== null
}

export async function chooseNativeProjectFolder(target = globalThis) {
  const bridge = bridgeFor(target)
  if (!bridge) return { status: 'unavailable', message: UNAVAILABLE_MESSAGE }

  try {
    const result = await bridge.chooseProjectFolder()
    if (result?.status === 'cancelled') return { status: 'cancelled' }
    if (result?.status === 'selected' && typeof result.path === 'string' && result.path.trim()) {
      return { status: 'selected', path: result.path }
    }
    if (result?.status === 'error' && typeof result.message === 'string' && result.message.trim()) {
      return { status: 'error', message: result.message }
    }
    return { status: 'error', message: ERROR_MESSAGE }
  } catch {
    return { status: 'error', message: ERROR_MESSAGE }
  }
}
