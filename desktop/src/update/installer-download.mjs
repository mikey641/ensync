/**
 * Streams a release installer to a private temporary directory, enforcing the
 * declared size, the manifest's SHA-256 and the installed build's signing
 * identity before the file is ever handed back.
 *
 * This replaces upstream's `requestService` + `checksum()` + `fileService.writeFile`
 * pipeline in `updateService.win32.ts`; the progress reporting mirrors the
 * `Downloading` state upstream publishes while the bytes arrive.
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { INSTALLER_LIMIT_BYTES, responseLength, safeInstallerName, secureUrl } from './release-feed.mjs'

export const PROGRESS_INTERVAL_MS = 150

/** An error the update service is allowed to surface verbatim to the user. */
export class InstallerVerificationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InstallerVerificationError'
  }
}

export async function downloadVerifiedInstaller({
  fetchImpl,
  update,
  platform,
  tempRoot,
  signal,
  now = Date.now,
  onProgress = () => {},
  expectedSignerIdentity,
  verifyInstaller,
}) {
  let outputPath = null
  try {
    const response = await fetchImpl(update.url, { cache: 'no-store', redirect: 'follow', signal })
    if (!response.ok || !secureUrl(response.url || update.url) || !response.body) {
      throw new Error('The installer download could not be verified.')
    }
    const total = responseLength(response)
    if (total !== null && total > INSTALLER_LIMIT_BYTES) {
      throw new InstallerVerificationError('The installer is larger than the safety limit.')
    }
    await mkdir(tempRoot, { recursive: true })
    const directory = await mkdtemp(join(tempRoot, 'ensync-update-'))
    outputPath = join(directory, safeInstallerName(update.url, platform, update.version))
    const output = await open(outputPath, 'wx')
    const hash = createHash('sha256')
    const reader = response.body.getReader()
    let transferred = 0
    let lastPublished = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        transferred += value.byteLength
        if (transferred > INSTALLER_LIMIT_BYTES || (total !== null && transferred > total)) {
          throw new InstallerVerificationError('The installer exceeded its declared or allowed size.')
        }
        hash.update(value)
        await output.writeFile(value)
        const timestamp = now()
        if (timestamp - lastPublished >= PROGRESS_INTERVAL_MS) {
          lastPublished = timestamp
          onProgress(transferred, total)
        }
      }
    } finally {
      await output.close()
    }
    if (total !== null && transferred !== total) {
      throw new InstallerVerificationError('The installer download ended before its declared size.')
    }
    if (hash.digest('hex') !== update.sha256hash) {
      throw new InstallerVerificationError('The installer SHA-256 checksum did not match the signed release manifest.')
    }
    const signed = await verifyInstaller({
      platform,
      installerPath: outputPath,
      expectedSignerIdentity,
    })
    if (!signed) {
      throw new InstallerVerificationError('The downloaded installer signature could not be verified.')
    }
    const installerPath = outputPath
    outputPath = null
    return { installerPath, transferred, total: total ?? transferred }
  } finally {
    if (outputPath) await unlink(outputPath).catch(() => {})
  }
}
