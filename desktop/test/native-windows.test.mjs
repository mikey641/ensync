import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  CLOSE_WINDOW_ACCELERATOR,
  createNativeIpcAuthorizer,
  createNativeTitleBarAppearanceHandler,
  createNativeWindowMenuTemplate,
  createNativeWindowRegistry,
  FORCE_RELOAD_ACCELERATOR,
  nativeTitleBarOverlayOptions,
  nativeWindowFrameOptions,
  NEW_WINDOW_ACCELERATOR,
  RELOAD_ACCELERATOR,
} from '../src/native-windows.mjs'

function fileMenu(template) {
  return template.find((item) => item.label === 'File')
}

function fakeWindow(name) {
  return {
    name,
    destroyed: false,
    webContents: { name: `${name}-contents` },
    isDestroyed() { return this.destroyed },
  }
}

test('native windows integrate system controls into the app title bar on macOS and Windows', () => {
  assert.deepEqual(nativeWindowFrameOptions('darwin'), {
    titleBarStyle: 'hiddenInset',
  })
  assert.deepEqual(nativeWindowFrameOptions('win32'), {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#191919',
      symbolColor: '#ececec',
      height: 46,
    },
  })
})

test('native title-bar appearance accepts only authorized resolved themes', () => {
  const sender = { name: 'renderer' }
  const overlays = []
  const window = fakeWindow('themed')
  window.setTitleBarOverlay = (options) => overlays.push(options)
  const handler = createNativeTitleBarAppearanceHandler({
    isAuthorized: (event) => event?.sender === sender,
    platform: 'win32',
    windowForWebContents: (webContents) => webContents === sender ? window : null,
  })

  assert.equal(handler({ sender }, 'light'), true)
  assert.deepEqual(overlays, [nativeTitleBarOverlayOptions('light')])
  assert.equal(handler({ sender }, 'system'), false)
  assert.equal(handler({ sender: {} }, 'dark'), false)
  assert.equal(overlays.length, 1)
})

test('macOS title-bar appearance keeps native traffic lights without an overlay mutation', () => {
  let lookedUp = false
  const handler = createNativeTitleBarAppearanceHandler({
    isAuthorized: () => true,
    platform: 'darwin',
    windowForWebContents: () => { lookedUp = true; return null },
  })

  assert.equal(handler({ sender: {} }, 'dark'), true)
  assert.equal(lookedUp, false)
})

test('the native renderer suppresses decorative controls and reserves the Windows overlay area', async () => {
  const [mainSource, appSource, cssSource] = await Promise.all([
    readFile(resolve(import.meta.dirname, '../src/main.mjs'), 'utf8'),
    readFile(resolve(import.meta.dirname, '../../src/App.tsx'), 'utf8'),
    readFile(resolve(import.meta.dirname, '../../src/index.css'), 'utf8'),
  ])

  assert.match(mainSource, /\.\.\.nativeWindowFrameOptions\(process\.platform\)/)
  assert.match(appSource, /!window\.ensyncDesktop && <div className="traffic-lights"/)
  assert.match(cssSource, /env\(titlebar-area-width, 100vw\)/)
})

test('macOS and Windows expose only Cmd/Ctrl+N as the native New Window shortcut', () => {
  for (const platform of ['darwin', 'win32']) {
    let opened = 0
    let closed = 0
    const template = createNativeWindowMenuTemplate({
      platform,
      onNewWindow: () => { opened += 1 },
      onCloseWindow: () => { closed += 1 },
    })
    const items = fileMenu(template).submenu
    const newWindow = items.find((item) => item.label === 'New Window')
    const closeWindow = items.find((item) => item.label === 'Close Window')

    assert.equal(newWindow.accelerator, NEW_WINDOW_ACCELERATOR)
    assert.equal(NEW_WINDOW_ACCELERATOR, 'CmdOrCtrl+N')
    assert.equal(closeWindow.accelerator, CLOSE_WINDOW_ACCELERATOR)
    assert.equal(CLOSE_WINDOW_ACCELERATOR, 'CmdOrCtrl+Shift+W')
    assert.equal(items.some((item) => item.accelerator === 'CmdOrCtrl+T'), false)
    assert.equal(items.some((item) => item.accelerator === 'CmdOrCtrl+W'), false)

    newWindow.click()
    closeWindow.click()
    assert.equal(opened, 1)
    assert.equal(closed, 1)
  }
})

test('native menus expose standard reload shortcuts for reconnectable Host jobs', () => {
  for (const platform of ['darwin', 'win32']) {
    const template = createNativeWindowMenuTemplate({
      platform,
      onNewWindow: () => {},
      onCloseWindow: () => {},
    })
    const menuItems = template.flatMap((item) => [item, ...(item.submenu ?? [])])
    const reload = menuItems.find((item) => item.role === 'reload')
    const forceReload = menuItems.find((item) => item.role === 'forceReload')

    assert.equal(reload.accelerator, RELOAD_ACCELERATOR)
    assert.equal(RELOAD_ACCELERATOR, 'CmdOrCtrl+R')
    assert.equal(forceReload.accelerator, FORCE_RELOAD_ACCELERATOR)
    assert.equal(FORCE_RELOAD_ACCELERATOR, 'CmdOrCtrl+Shift+R')
  }
})

test('native window registry keeps windows independently addressable and prefers recent focus', () => {
  const registry = createNativeWindowRegistry()
  const first = fakeWindow('first')
  const second = fakeWindow('second')

  const firstIdentity = { id: '11111111-1111-4111-8111-111111111111', kind: 'canonical' }
  const secondIdentity = { id: '22222222-2222-4222-8222-222222222222', kind: 'isolated' }
  registry.add(first, firstIdentity)
  registry.add(second, secondIdentity)
  assert.equal(registry.size, 2)
  assert.equal(registry.preferred(), second)
  assert.equal(registry.ownsWebContents(first.webContents), true)
  assert.equal(registry.ownsWebContents(second.webContents), true)
  assert.strictEqual(registry.workspaceForWebContents(first.webContents), firstIdentity)
  assert.strictEqual(registry.workspaceForWebContents(second.webContents), secondIdentity)
  assert.strictEqual(registry.windowForWorkspace(firstIdentity.id), first)
  assert.strictEqual(registry.windowForWorkspace(secondIdentity.id), second)
  assert.equal(registry.windowForWorkspace('missing'), null)

  registry.focus(first)
  assert.equal(registry.preferred(), first)
  assert.equal(registry.preferred(second), second)

  registry.remove(first)
  assert.equal(registry.size, 1)
  assert.equal(registry.preferred(), second)
  assert.equal(registry.ownsWebContents(first.webContents), false)
  assert.equal(registry.workspaceForWebContents(first.webContents), null)
  assert.equal(registry.windowForWorkspace(firstIdentity.id), null)

  second.destroyed = true
  assert.equal(registry.preferred(), null)
  assert.equal(registry.ownsWebContents(second.webContents), false)
})

test('native IPC authorization requires the live registered sender and trusted app frame', () => {
  const registry = createNativeWindowRegistry()
  const window = fakeWindow('authorized')
  window.webContents.getURL = () => 'ensync://app/'
  registry.add(window, { id: '11111111-1111-4111-8111-111111111111', kind: 'canonical' })
  const authorize = createNativeIpcAuthorizer({
    nativeWindows: registry,
    isAppUrl: (value) => value === 'ensync://app/',
  })

  assert.equal(authorize({ sender: window.webContents, senderFrame: { url: 'ensync://app/' } }), true)
  assert.equal(authorize({ sender: window.webContents, senderFrame: { url: 'https://attacker.invalid/' } }), false)
  assert.equal(authorize({ sender: { getURL: () => 'ensync://app/' } }), false)
  window.destroyed = true
  assert.equal(authorize({ sender: window.webContents, senderFrame: { url: 'ensync://app/' } }), false)
})

test('desktop packages the native multi-window contract', async () => {
  const packagePath = resolve(import.meta.dirname, '../package.json')
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  assert.ok(manifest.build.files.includes('src/native-windows.mjs'))
  assert.ok(manifest.build.files.includes('src/native-workspaces.mjs'))
  assert.ok(manifest.build.files.includes('src/recent-projects.mjs'))
  assert.ok(manifest.build.files.includes('src/workspace-recovery.mjs'))
  assert.ok(manifest.build.files.includes('src/native-updates.mjs'))
})
