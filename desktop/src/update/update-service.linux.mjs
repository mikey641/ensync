/**
 * Stands in for VS Code's `src/vs/platform/update/electron-main/updateService.linux.ts`.
 *
 * Upstream checks the feed and opens the download page in a browser. Ensync
 * publishes no signed Linux artifact — `electron-builder` targets only macOS and
 * Windows — so this service refuses instead of pointing at a build that does not
 * exist. It exists so every platform resolves to a real service rather than to
 * `undefined`.
 */

import { AbstractUpdateService } from './abstract-update-service.mjs'
import { DisablementReason, State, UpdateType } from './update.mjs'

export class LinuxUpdateService extends AbstractUpdateService {
  async initialize() {
    this.setState(State.Disabled(DisablementReason.UnsupportedPlatform))
    this.logService.info('update#ctor - updates are disabled as no signed build is published for this platform')
    return this.state
  }

  getUpdateType() {
    return UpdateType.Archive
  }

  buildUpdateFeedUrl() {
    return undefined
  }

  async doCheckForUpdates() {
    // noop — this platform has no release feed.
  }
}
