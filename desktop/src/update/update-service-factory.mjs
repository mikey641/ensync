/**
 * Chooses the platform update service, mirroring the `switch (process.platform)`
 * in VS Code's `src/vs/code/electron-main/app.ts` where the update service is
 * registered.
 */

import { DarwinUpdateService } from './update-service.darwin.mjs'
import { LinuxUpdateService } from './update-service.linux.mjs'
import { Win32UpdateService } from './update-service.win32.mjs'

export function createPlatformUpdateService(options) {
  switch (options.platform) {
    case 'darwin':
      return new DarwinUpdateService(options)
    case 'win32':
      return new Win32UpdateService(options)
    default:
      return new LinuxUpdateService(options)
  }
}
