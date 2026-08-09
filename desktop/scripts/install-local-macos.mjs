import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  installLocalMacApp,
  LOCAL_MAC_INSTALL_PATH,
} from '../src/local-macos-install.mjs'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceApp = resolve(desktopRoot, 'release', 'mac-universal', 'Ensync.app')

await installLocalMacApp({ sourceApp })
console.log(`Installed the local Ensync test build at ${LOCAL_MAC_INSTALL_PATH}.`)
