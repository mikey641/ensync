/**
 * Port of VS Code's `src/vs/platform/update/electron-main/updateService.win32.ts`.
 *
 * Upstream downloads an Inno Setup package, optionally applies it in the
 * background, and spawns it with `/silent` from `doQuitAndInstall()` as the app
 * exits. Ensync downloads and verifies the NSIS installer the same way, but
 * stops at handing it to the user: `quitAndInstall()` is inert, so the elaborate
 * mutex, cancel-flag and relaunch-argument machinery upstream needs to survive a
 * silent install has no counterpart here.
 */

import { FeedUpdateService } from './feed-update-service.mjs'
import { UpdateType } from './update.mjs'

export class Win32UpdateService extends FeedUpdateService {
  constructor(options) {
    super({ ...options, supportsUpdateOverwrite: false })
  }

  getUpdateType() {
    return UpdateType.Setup
  }

  doQuitAndInstall() {
    this.logService.info('update#quitAndInstall(): Ensync does not run the installer silently on quit; the user completes it')
  }
}
