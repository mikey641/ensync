/**
 * Port of VS Code's `src/vs/platform/update/electron-main/updateService.darwin.ts`.
 *
 * Upstream points Electron's `autoUpdater` (Squirrel.Mac) at a feed URL and lets
 * it download and stage the update. Ensync publishes a static manifest, which
 * Squirrel cannot drive — it has no way to answer "204, you are up to date" — so
 * the check, download, checksum and Gatekeeper assessment happen here and the
 * verified disk image is handed to the user. Nothing is quit or restarted for
 * them, so upstream's `IRelaunchHandler` has no counterpart.
 */

import { FeedUpdateService } from './feed-update-service.mjs'
import { UpdateType } from './update.mjs'

export class DarwinUpdateService extends FeedUpdateService {
  constructor(options) {
    super({ ...options, supportsUpdateOverwrite: false })
  }

  getUpdateType() {
    return UpdateType.Archive
  }

  doQuitAndInstall() {
    this.logService.info('update#quitAndInstall(): Ensync does not run quitAndInstall on macOS; the disk image stays open for the user')
  }
}
