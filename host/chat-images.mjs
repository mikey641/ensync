import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MANAGED_DIRECTORY_PATTERN = /^[a-f0-9]{24}$/
const MAX_LOCAL_PATH_CHARACTERS = 16_384
const MAX_CHAT_IMAGE_BYTES = 50 * 1024 * 1024
const IMAGE_CONTENT_TYPES = new Map([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])

function pathIsWithin(root, candidate) {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function requiredPath(value, label) {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > MAX_LOCAL_PATH_CHARACTERS
    || value.includes('\0')
  ) {
    throw new ChatImageError('invalid_chat_image_path', `${label} is invalid.`, 400)
  }
  return value
}

function imageCandidate(workspacePath, imagePath) {
  if (/^file:/i.test(imagePath)) {
    try {
      return fileURLToPath(new URL(imagePath))
    } catch {
      throw new ChatImageError('invalid_chat_image_path', 'The local image URL is invalid.', 400)
    }
  }
  return isAbsolute(imagePath) ? resolve(imagePath) : resolve(workspacePath, imagePath)
}

export class ChatImageError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'ChatImageError'
    this.code = code
    this.status = status
  }
}

/**
 * Resolves images only from a renderer-supplied, Host-issued conversation
 * workspace. The managed root shape and canonical paths prevent a Markdown
 * response from turning the image endpoint into an arbitrary local-file read.
 */
export class ChatImageService {
  #workspaceRoot
  #maxBytes

  constructor(options = {}) {
    const workspaceRoot = options.workspaceRoot ?? join(homedir(), '.ensync', 'agent-workspaces-v1')
    if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) {
      throw new TypeError('The Ensync agent-workspace root must be an absolute path.')
    }
    this.#workspaceRoot = resolve(workspaceRoot)
    this.#maxBytes = options.maxBytes ?? MAX_CHAT_IMAGE_BYTES
  }

  async open(input = {}) {
    const workspacePath = requiredPath(input.workspacePath, 'The conversation workspace path')
    const imagePath = requiredPath(input.imagePath, 'The image path')

    let canonicalRoot
    let canonicalWorkspace
    try {
      canonicalRoot = await realpath(this.#workspaceRoot)
      canonicalWorkspace = await realpath(workspacePath)
    } catch {
      throw new ChatImageError(
        'chat_image_workspace_unavailable',
        'The protected conversation workspace is no longer available.',
        404,
      )
    }

    if (!pathIsWithin(canonicalRoot, canonicalWorkspace)) {
      throw new ChatImageError(
        'chat_image_workspace_forbidden',
        'The image is not in an Ensync-managed conversation workspace.',
        403,
      )
    }

    const managedParts = relative(canonicalRoot, canonicalWorkspace).split(sep)
    if (
      managedParts.length < 2
      || !MANAGED_DIRECTORY_PATTERN.test(managedParts[0])
      || !MANAGED_DIRECTORY_PATTERN.test(managedParts[1])
    ) {
      throw new ChatImageError(
        'chat_image_workspace_forbidden',
        'The image is not in a verified Ensync conversation workspace.',
        403,
      )
    }

    const managedWorkspace = join(canonicalRoot, managedParts[0], managedParts[1])
    if (!pathIsWithin(managedWorkspace, canonicalWorkspace)) {
      throw new ChatImageError(
        'chat_image_workspace_forbidden',
        'The conversation workspace path is invalid.',
        403,
      )
    }

    let canonicalImage
    let imageStat
    try {
      canonicalImage = await realpath(imageCandidate(canonicalWorkspace, imagePath))
      imageStat = await stat(canonicalImage)
    } catch (error) {
      if (error instanceof ChatImageError) throw error
      throw new ChatImageError('chat_image_unavailable', 'The local image is missing or inaccessible.', 404)
    }

    if (!pathIsWithin(canonicalWorkspace, canonicalImage)) {
      throw new ChatImageError(
        'chat_image_forbidden',
        'Markdown images must stay inside this conversation’s protected workspace.',
        403,
      )
    }
    if (!imageStat.isFile()) {
      throw new ChatImageError('chat_image_unavailable', 'The local image path is not a file.', 404)
    }

    const contentType = IMAGE_CONTENT_TYPES.get(extname(canonicalImage).toLowerCase())
    if (!contentType) {
      throw new ChatImageError(
        'unsupported_chat_image',
        'Only GIF, JPEG, PNG, and WebP chat images can be displayed.',
        415,
      )
    }
    if (imageStat.size > this.#maxBytes) {
      throw new ChatImageError('chat_image_too_large', 'The local image is too large to display.', 413)
    }

    return {
      path: canonicalImage,
      size: imageStat.size,
      contentType,
    }
  }
}
