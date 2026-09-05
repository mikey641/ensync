import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APP_ORIGIN,
  createAppProtocolHandler,
  HostProcessController,
  verifyUiBundle,
} from '../src/runtime.mjs'
import {
  createNativeWindowMenuTemplate,
  NEW_WINDOW_ACCELERATOR,
} from '../src/native-windows.mjs'
import { createNativeUpdateManager } from '../src/native-updates.mjs'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = resolve(desktopRoot, '..')
const uiRoot = resolve(repositoryRoot, 'dist')

await verifyUiBundle(uiRoot)

const developmentUpdates = createNativeUpdateManager({
  installedVersion: '0.0.0-development',
  platform: process.platform,
  isPackaged: false,
  executablePath: process.execPath,
  manifestUrl: 'https://ensync.vercel.app/releases.json',
  tempRoot: process.cwd(),
  fetchImpl: async () => { throw new Error('Development update smoke check must not use the network.') },
  openInstaller: async () => '',
})
const developmentUpdateState = await developmentUpdates.initialize()
if (developmentUpdateState.phase !== 'unavailable' || developmentUpdateState.canCheck) {
  throw new Error('Development builds did not fail closed for native updates.')
}

for (const platform of ['darwin', 'win32']) {
  const template = createNativeWindowMenuTemplate({
    platform,
    onNewWindow() {},
    onCloseWindow() {},
  })
  const fileMenu = template.find((item) => item.label === 'File')
  const newWindow = fileMenu?.submenu.find((item) => item.label === 'New Window')
  if (newWindow?.accelerator !== NEW_WINDOW_ACCELERATOR) {
    throw new Error(`${platform} does not expose the native New Window accelerator.`)
  }
  if (fileMenu.submenu.some((item) => item.accelerator === 'CmdOrCtrl+T')) {
    throw new Error(`${platform} steals Ensync's renderer-owned New Tab accelerator.`)
  }
}

const host = new HostProcessController({
  bootstrapPath: resolve(desktopRoot, 'src', 'host-bootstrap.mjs'),
  hostEntryPath: resolve(repositoryRoot, 'host', 'server.mjs'),
  cwd: repositoryRoot,
  executable: process.execPath,
  env: { ENSYNC_DEFAULT_PROJECT_PATH: repositoryRoot },
})

try {
  const { port } = await host.start()
  const handle = await createAppProtocolHandler({ uiRoot, hostPort: port })
  const [pageResponse, healthResponse] = await Promise.all([
    handle(new Request(`${APP_ORIGIN}/`)),
    handle(new Request(`${APP_ORIGIN}/api/health`)),
  ])
  if (!pageResponse.ok || !(await pageResponse.text()).includes('<div id="root"></div>')) {
    throw new Error('The packaged UI entry point did not pass the smoke check.')
  }
  const health = await healthResponse.json()
  if (!healthResponse.ok || health.ok !== true || health.service !== 'ensync-host') {
    throw new Error('The packaged host proxy did not pass the smoke check.')
  }
  console.log(`Desktop smoke check passed with Ensync Host API v${health.apiVersion}.`)
} finally {
  await host.stop()
}
