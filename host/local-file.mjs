import { open, stat } from 'node:fs/promises'
import { basename, posix, win32 } from 'node:path'

// A conversation can reference a build log or a bundled asset. Ensync reads a
// bounded prefix so a display request can never pull a huge file into memory,
// and reports the real size so the viewer can say the text was cut.
export const MAX_DISPLAY_BYTES = 512 * 1024

function isAbsoluteOnSupportedDesktop(path) {
  return posix.isAbsolute(path) || win32.isAbsolute(path)
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return null

  return name.slice(dot + 1).toLowerCase().slice(0, 16)
}

/**
 * Reads an absolute local path for display inside Ensync. Every outcome is a
 * reported status rather than a thrown error, so the viewer can explain what
 * happened instead of failing the whole request.
 */
export async function readLocalFileForDisplay(requestedPath) {
  const path = typeof requestedPath === 'string' ? requestedPath.trim() : ''
  const name = path ? basename(path.replace(/[/\\]+$/, '')) : ''

  if (!path || !isAbsoluteOnSupportedDesktop(path)) {
    return {
      status: 'invalid',
      path,
      name,
      message: 'Ensync can display only an absolute local file path.',
    }
  }

  let stats
  try {
    stats = await stat(path)
  } catch {
    return { status: 'missing', path, name, message: `No file exists at ${path}.` }
  }

  if (stats.isDirectory()) {
    return { status: 'directory', path, name, message: `${path} is a folder, not a file.` }
  }
  if (!stats.isFile()) {
    return { status: 'invalid', path, name, message: `${path} is not a regular file.` }
  }

  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(Math.min(stats.size, MAX_DISPLAY_BYTES))
    const { bytesRead } = buffer.length > 0
      ? await handle.read(buffer, 0, buffer.length, 0)
      : { bytesRead: 0 }
    const slice = buffer.subarray(0, bytesRead)

    if (slice.includes(0)) {
      return {
        status: 'binary',
        path,
        name,
        message: 'This file is not text, so Ensync cannot display its contents.',
      }
    }

    const truncated = stats.size > slice.length
    let text = slice.toString('utf8')
    // A cut at the byte cap can split a multi-byte character. Drop that partial
    // character rather than showing a replacement mark the file does not have.
    if (truncated && text.endsWith('�')) text = text.slice(0, -1)

    return {
      status: 'ok',
      path,
      name,
      text,
      bytes: stats.size,
      truncated,
      language: extensionOf(name),
    }
  } catch {
    return { status: 'unreadable', path, name, message: `Ensync could not read ${path}.` }
  } finally {
    await handle?.close()
  }
}
