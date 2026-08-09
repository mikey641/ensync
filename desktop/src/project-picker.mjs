import { posix, win32 } from 'node:path'

export const PROJECT_FOLDER_PICKER_CHANNEL = 'ensync:project-folder:choose'
export const CHAT_FILE_PICKER_CHANNEL = 'ensync:chat-files:choose'
export const CHAT_FILE_PICKER_LIMIT = 64

export const PROJECT_FOLDER_DIALOG_OPTIONS = Object.freeze({
  title: 'Choose an Ensync project folder',
  buttonLabel: 'Choose folder',
  properties: Object.freeze(['openDirectory']),
})

export const CHAT_FILE_DIALOG_OPTIONS = Object.freeze({
  title: 'Choose files to attach',
  buttonLabel: 'Attach',
  properties: Object.freeze(['openFile', 'multiSelections']),
})

function isAbsoluteOnSupportedDesktop(path) {
  return posix.isAbsolute(path) || win32.isAbsolute(path)
}

function fileNameForSupportedDesktop(path) {
  return win32.isAbsolute(path) ? win32.basename(path) : posix.basename(path)
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

export function createChatFilePickerHandler({
  isAuthorized,
  openDialog,
  onError = () => {},
}) {
  if (typeof isAuthorized !== 'function' || typeof openDialog !== 'function') {
    throw new TypeError('Chat file picker authorization and dialog functions are required.')
  }

  return async (event) => {
    if (!isAuthorized(event)) {
      return {
        status: 'error',
        message: 'The system file chooser is available only to the Ensync app window.',
      }
    }

    try {
      const result = await openDialog(event, CHAT_FILE_DIALOG_OPTIONS)
      if (result?.canceled || !Array.isArray(result?.filePaths) || result.filePaths.length === 0) {
        return { status: 'cancelled' }
      }

      const uniquePaths = [...new Set(result.filePaths)]
      if (uniquePaths.length > CHAT_FILE_PICKER_LIMIT) {
        return {
          status: 'error',
          message: `Choose no more than ${CHAT_FILE_PICKER_LIMIT} files at a time.`,
        }
      }

      const files = uniquePaths.map((path) => {
        if (typeof path !== 'string' || !isAbsoluteOnSupportedDesktop(path)) {
          throw new Error('The system file chooser did not return an absolute file path.')
        }
        const name = fileNameForSupportedDesktop(path)
        if (!name) throw new Error('The system file chooser did not return a file name.')
        return { name, path }
      })

      return { status: 'selected', files }
    } catch (error) {
      onError(error)
      return {
        status: 'error',
        message: 'Ensync could not open the system file chooser.',
      }
    }
  }
}
