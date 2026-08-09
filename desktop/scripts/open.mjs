import electronPath from 'electron'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchDetachedElectron } from '../src/detached-launch.mjs'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const launched = await launchDetachedElectron({
  electronPath,
  appPath: desktopRoot,
  cwd: desktopRoot,
})

console.log(`Ensync opened independently${launched.pid ? ` (PID ${launched.pid})` : ''}.`)
