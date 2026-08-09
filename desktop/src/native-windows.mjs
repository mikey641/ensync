export const NEW_WINDOW_ACCELERATOR = 'CmdOrCtrl+N'
export const CLOSE_WINDOW_ACCELERATOR = 'CmdOrCtrl+Shift+W'
export const RELOAD_ACCELERATOR = 'CmdOrCtrl+R'
export const FORCE_RELOAD_ACCELERATOR = 'CmdOrCtrl+Shift+R'
export const TITLEBAR_APPEARANCE_CHANNEL = 'ensync:window:set-titlebar-appearance'

const TITLEBAR_HEIGHT = 46

function isResolvedTheme(value) {
  return value === 'dark' || value === 'light'
}

export function nativeTitleBarOverlayOptions(theme = 'dark') {
  if (!isResolvedTheme(theme)) throw new TypeError('A resolved light or dark title-bar theme is required.')
  return theme === 'light'
    ? { color: '#ffffff', symbolColor: '#202123', height: TITLEBAR_HEIGHT }
    : { color: '#191919', symbolColor: '#ececec', height: TITLEBAR_HEIGHT }
}

export function nativeWindowFrameOptions(platform = process.platform) {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: nativeTitleBarOverlayOptions('dark'),
  }
}

export function createNativeTitleBarAppearanceHandler(options) {
  const {
    isAuthorized,
    platform = process.platform,
    windowForWebContents,
  } = options ?? {}
  if (typeof isAuthorized !== 'function' || typeof windowForWebContents !== 'function') {
    throw new TypeError('Native title-bar authorization and window lookup are required.')
  }

  return (event, theme) => {
    if (!isAuthorized(event) || !isResolvedTheme(theme)) return false
    if (platform === 'darwin') return true
    const window = windowForWebContents(event?.sender)
    if (!usable(window) || typeof window.setTitleBarOverlay !== 'function') return false
    window.setTitleBarOverlay(nativeTitleBarOverlayOptions(theme))
    return true
  }
}

function assertCallback(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function.`)
}

/**
 * Builds the application-owned menu entries used by Electron. Keeping this
 * definition free of Electron imports makes the cross-platform accelerators
 * and their non-overlap with renderer-owned tab shortcuts directly testable.
 */
export function createNativeWindowMenuTemplate(options) {
  const {
    appName = 'Ensync',
    onCloseWindow,
    onNewWindow,
    platform = process.platform,
  } = options ?? {}

  assertCallback(onNewWindow, 'onNewWindow')
  assertCallback(onCloseWindow, 'onCloseWindow')

  const fileSubmenu = [
    {
      label: 'New Window',
      accelerator: NEW_WINDOW_ACCELERATOR,
      click: onNewWindow,
    },
    { type: 'separator' },
    {
      label: 'Close Window',
      accelerator: CLOSE_WINDOW_ACCELERATOR,
      click: onCloseWindow,
    },
  ]

  if (platform !== 'darwin') {
    fileSubmenu.push({ type: 'separator' }, { role: 'quit' })
  }

  const template = []
  if (platform === 'darwin') {
    template.push({
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  template.push(
    { label: 'File', submenu: fileSubmenu },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: RELOAD_ACCELERATOR },
        { role: 'forceReload', accelerator: FORCE_RELOAD_ACCELERATOR },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  )
  return template
}

function usable(window) {
  return Boolean(window && !window.isDestroyed())
}

export function createNativeIpcAuthorizer({ nativeWindows, isAppUrl }) {
  if (!nativeWindows || typeof nativeWindows.ownsWebContents !== 'function'
    || typeof isAppUrl !== 'function') {
    throw new TypeError('Native IPC window and origin authorization is required.')
  }
  return (event) => {
    const sender = event?.sender
    const senderUrl = event?.senderFrame?.url || sender?.getURL?.()
    return Boolean(
      sender
      && nativeWindows.ownsWebContents(sender)
      && isAppUrl(senderUrl),
    )
  }
}

/**
 * Tracks every native window without coupling the ownership rules to Electron.
 * The most recently focused usable window is the target for app activation,
 * second-instance focus, and Close Window.
 */
export function createNativeWindowRegistry() {
  const windows = new Set()
  const workspaceByWindow = new Map()
  let lastFocusedWindow = null

  return {
    add(window, workspaceIdentity = null) {
      if (!window) throw new TypeError('A native window is required.')
      windows.add(window)
      if (workspaceIdentity) workspaceByWindow.set(window, workspaceIdentity)
      lastFocusedWindow = window
    },
    focus(window) {
      if (windows.has(window) && usable(window)) lastFocusedWindow = window
    },
    remove(window) {
      windows.delete(window)
      workspaceByWindow.delete(window)
      if (lastFocusedWindow !== window) return
      lastFocusedWindow = [...windows].reverse().find(usable) ?? null
    },
    preferred(focusedWindow = null) {
      if (windows.has(focusedWindow) && usable(focusedWindow)) return focusedWindow
      if (windows.has(lastFocusedWindow) && usable(lastFocusedWindow)) return lastFocusedWindow
      return [...windows].reverse().find(usable) ?? null
    },
    ownsWebContents(webContents) {
      if (!webContents) return false
      return [...windows].some((window) => usable(window) && window.webContents === webContents)
    },
    workspaceForWebContents(webContents) {
      const window = [...windows].find((candidate) => usable(candidate) && candidate.webContents === webContents)
      return window ? workspaceByWindow.get(window) ?? null : null
    },
    windowForWorkspace(id) {
      if (typeof id !== 'string' || !id) return null
      return [...windows].find((window) => usable(window) && workspaceByWindow.get(window)?.id === id) ?? null
    },
    get size() {
      return windows.size
    },
  }
}
