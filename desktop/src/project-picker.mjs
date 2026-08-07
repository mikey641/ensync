import { posix, win32 } from 'node:path'

export const PROJECT_FOLDER_PICKER_CHANNEL = 'ensync:project-folder:choose'

export const PROJECT_FOLDER_DIALOG_OPTIONS = Object.freeze({
  title: 'Choose an Ensync project folder',
  buttonLabel: 'Choose folder',
  properties: Object.freeze(['openDirectory']),
})

function isAbsoluteOnSupportedDesktop(path) {
  return posix.isAbsolute(path) || win32.isAbsolute(path)
}

export function createProjectFolderPickerHandler({
  isAuthorized,
  openDialog,
  onError = () => {},
}) {
  if (typeof isAuthorized !== 'function' || typeof openDialog !== 'function') {
    throw new TypeError('Project folder picker authorization and dialog functions are required.')
  }

  return async (event) => {
    if (!isAuthorized(event)) {
      return {
        status: 'error',
        message: 'The system folder chooser is available only to the Ensync app window.',
      }
    }

    try {
      const result = await openDialog(event, PROJECT_FOLDER_DIALOG_OPTIONS)
      if (result?.canceled || !Array.isArray(result?.filePaths) || result.filePaths.length === 0) {
        return { status: 'cancelled' }
      }

      const path = result.filePaths[0]
      if (typeof path !== 'string' || !isAbsoluteOnSupportedDesktop(path)) {
        throw new Error('The system folder chooser did not return an absolute folder path.')
      }

      return { status: 'selected', path }
    } catch (error) {
      onError(error)
      return {
        status: 'error',
        message: 'Ensync could not open the system folder chooser.',
      }
    }
  }
}
