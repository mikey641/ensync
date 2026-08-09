import { posix, win32 } from 'node:path'

export const LOCAL_FILE_OPEN_CHANNEL = 'ensync:shell:open-local-file'

const REVEALED_MESSAGE = 'Ensync showed that item in the file manager instead of running it.'

// A message can quote any path an agent produced. Anything the operating system
// would execute is revealed in the file manager instead of handed to the system
// opener, so clicking a conversation link can never start a program.
const EXECUTABLE_EXTENSIONS = new Set([
  'app', 'action', 'bat', 'bin', 'cmd', 'com', 'command', 'cpl', 'csh', 'dmg', 'exe', 'gadget',
  'jar', 'js', 'jse', 'ksh', 'lnk', 'msc', 'msi', 'msp', 'osx', 'pif', 'pkg', 'ps1', 'reg',
  'run', 'scpt', 'scptd', 'scr', 'sh', 'terminal', 'vb', 'vbe', 'vbs', 'workflow', 'ws', 'wsf', 'zsh',
])

function isAbsoluteOnSupportedDesktop(path) {
  return posix.isAbsolute(path) || win32.isAbsolute(path)
}

function isExecutableTarget(path) {
  const name = path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false

  return EXECUTABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

export function createLocalFileOpenHandler({
  isAuthorized,
  describePath,
  openPath,
  revealPath,
  onError = () => {},
}) {
  if ([isAuthorized, describePath, openPath, revealPath].some((value) => typeof value !== 'function')) {
    throw new TypeError('Local file open authorization, description, open, and reveal functions are required.')
  }

  return async (event, request) => {
    if (!isAuthorized(event)) {
      return {
        status: 'error',
        message: 'Opening a local file is available only to the Ensync app window.',
      }
    }

    const path = typeof request === 'string' ? request.trim() : ''
    if (!path || !isAbsoluteOnSupportedDesktop(path)) {
      return {
        status: 'error',
        message: 'Ensync can open only an absolute local file path.',
      }
    }

    try {
      const description = await describePath(path)
      if (!description?.exists) {
        return { status: 'missing', message: `That file is no longer at ${path}.` }
      }

      if (isExecutableTarget(path)) {
        await revealPath(path)
        return { status: 'revealed', message: REVEALED_MESSAGE }
      }

      const failure = await openPath(path)
      if (typeof failure === 'string' && failure) {
        await revealPath(path)
        return { status: 'revealed', message: REVEALED_MESSAGE }
      }

      return { status: 'opened' }
    } catch (error) {
      onError(error)
      return { status: 'error', message: `Ensync could not open ${path}.` }
    }
  }
}
