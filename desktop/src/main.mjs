import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from 'electron'

import {
  APP_HOST,
  APP_ORIGIN,
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  createAppProtocolHandler,
  HostProcessController,
} from './runtime.mjs'
import {
  createProjectFolderPickerHandler,
  PROJECT_FOLDER_PICKER_CHANNEL,
} from './project-picker.mjs'
import { createRendererCrashRecovery } from './crash-recovery.mjs'
import {
  createNativeIpcAuthorizer,
  createNativeTitleBarAppearanceHandler,
  createNativeWindowMenuTemplate,
  createNativeWindowRegistry,
  nativeWindowFrameOptions,
  TITLEBAR_APPEARANCE_CHANNEL,
} from './native-windows.mjs'
import {
  createNativeWorkspaceStore,
  createWorkspaceFocusHandler,
  createWorkspaceIdentityIpcManager,
  createWorkspaceOpenProjectHandler,
  isNativeWorkspaceIdentity,
  nativeWorkspaceRestorationOrder,
  NATIVE_WORKSPACE_STATE_FILENAME,
  shouldRetainNativeWorkspaceOnClose,
  WORKSPACE_FOCUS_CHANNEL,
  WORKSPACE_OPEN_PROJECT_CHANNEL,
  WORKSPACE_PROJECT_FOCUS_CHANNEL,
} from './native-workspaces.mjs'
import {
  createWorkspaceRecoveryHandler,
  WORKSPACE_RECOVERY_CHANNEL,
} from './workspace-recovery.mjs'
import {
  CODEX_CONVERSATION_IMPORT_CHANNEL,
  createCodexConversationImportHandler,
} from './codex-conversation-import.mjs'
import {
  createRecentProjectHandlers,
  createRecentProjectStore,
  RECENT_PROJECTS_CHANGED_CHANNEL,
  RECENT_PROJECTS_FILENAME,
  RECENT_PROJECTS_GET_CHANNEL,
  RECENT_PROJECTS_MIGRATE_CHANNEL,
  RECENT_PROJECTS_REMEMBER_CHANNEL,
} from './recent-projects.mjs'
import {
  COMPLETION_NOTIFICATION_PREFERENCES_SET_CHANNEL,
  createDevicePreferencesHandlers,
  createDevicePreferencesStore,
  DEVICE_PREFERENCES_FILENAME,
  DEVICE_PREFERENCES_GET_CHANNEL,
} from './device-preferences.mjs'
import {
  createAuthorizedUpdateHandler,
  createNativeUpdateManager,
  UPDATE_CANCEL_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_GET_STATE_CHANNEL,
  UPDATE_OPEN_INSTALLER_CHANNEL,
  UPDATE_SET_CHANNEL_CHANNEL,
  UPDATE_STATE_CHANNEL,
} from './native-updates.mjs'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const HOST_DAEMON_STATE_FILENAME = 'ensync-host-daemon-v1.json'
const HOST_JOB_JOURNAL_FILENAME = 'ensync-host-jobs-v1.json'
const HOST_PROJECT_ISOLATION_DIRECTORY = 'agent-workspaces-v1'
protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: APP_SCHEME_PRIVILEGES,
}])
const singleInstance = app.requestSingleInstanceLock()

let hostController = null
let appProtocolRegistered = false
let runtimeStart = null
let quitting = false
let nativeBridgeRegistered = false
let updateManager = null
let nativeWorkspaceStore = null
let recentProjectStore = null
let devicePreferencesStore = null
const nativeWindows = createNativeWindowRegistry()
const projectLaunchByWorkspace = new Map()
const isAuthorizedNativeEvent = createNativeIpcAuthorizer({ nativeWindows, isAppUrl })
const workspaceIdentityIpc = createWorkspaceIdentityIpcManager({
  ipcMain,
  isAuthorized: isAuthorizedNativeEvent,
  identityForWebContents: (webContents) => nativeWindows.workspaceForWebContents(webContents),
  retainedIdentities: () => nativeWorkspaceStore?.list() ?? [],
  projectLaunchForIdentity: (identity) => projectLaunchByWorkspace.get(identity?.id) ?? null,
  hasRegisteredWindows: () => nativeWindows.size > 0,
})

function configuredUpdateManifestUrls() {
  try {
    const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'))
    const configured = manifest.ensync?.updateManifestUrls
    if (configured && typeof configured === 'object') {
      return {
        stable: typeof configured.stable === 'string' ? configured.stable : null,
        beta: typeof configured.beta === 'string' ? configured.beta : null,
      }
    }
    return {
      stable: typeof manifest.ensync?.updateManifestUrl === 'string'
        ? manifest.ensync.updateManifestUrl
        : null,
      beta: null,
    }
  } catch {
    return { stable: null, beta: null }
  }
}

function runtimePaths() {
  if (app.isPackaged) {
    return {
      bootstrapPath: join(process.resourcesPath, 'desktop-host-bootstrap.mjs'),
      hostEntryPath: join(process.resourcesPath, 'host', 'server.mjs'),
      uiRoot: join(process.resourcesPath, 'ui'),
    }
  }
  const repositoryRoot = resolve(desktopRoot, '..')
  return {
    bootstrapPath: join(desktopRoot, 'src', 'host-bootstrap.mjs'),
    hostEntryPath: join(repositoryRoot, 'host', 'server.mjs'),
    uiRoot: join(repositoryRoot, 'dist'),
  }
}

function preferredWindow() {
  return nativeWindows.preferred(BrowserWindow.getFocusedWindow())
}

function showWindow(window = preferredWindow()) {
  if (!window) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  nativeWindows.focus(window)
  return true
}

function closePreferredWindow() {
  preferredWindow()?.close()
}

function openNewWindow() {
  const identity = nativeWorkspaceStore?.createIsolated()
  if (!identity) return handleWindowCreationFailure(new Error('Native workspace state is unavailable.'))
  void createWindow(identity).catch((error) => {
    nativeWorkspaceStore?.remove(identity.id)
    handleWindowCreationFailure(error)
  })
}

async function openProjectWindow(project, sourceWorkspace) {
  const identity = nativeWorkspaceStore?.createIsolated()
  if (!identity) return false
  projectLaunchByWorkspace.set(identity.id, {
    projectId: project.projectId,
    projectPath: project.projectPath,
    sourceWorkspace: { id: sourceWorkspace.id, kind: sourceWorkspace.kind },
  })
  try {
    await createWindow(identity)
    return true
  } catch (error) {
    projectLaunchByWorkspace.delete(identity.id)
    nativeWorkspaceStore?.remove(identity.id)
    handleWindowCreationFailure(error)
    return false
  }
}

function installApplicationMenu() {
  const template = createNativeWindowMenuTemplate({
    appName: app.name,
    platform: process.platform,
    onNewWindow: openNewWindow,
    onCloseWindow: closePreferredWindow,
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerNativeBridge() {
  // Identity is the renderer bootstrap prerequisite. Keep it independent from
  // the rest of the bridge so a later native feature cannot leave it missing.
  workspaceIdentityIpc.register()
  if (nativeBridgeRegistered) return
  ipcMain.handle(WORKSPACE_FOCUS_CHANNEL, createWorkspaceFocusHandler({
    isAuthorized: isAuthorizedNativeEvent,
    identityForWebContents: (webContents) => nativeWindows.workspaceForWebContents(webContents),
    retainedIdentities: () => nativeWorkspaceStore?.list() ?? [],
    windowForWorkspace: (workspaceId) => nativeWindows.windowForWorkspace(workspaceId),
    focusWindow: (window) => showWindow(window),
    notifyProjectFocus: (window, project) => {
      window.webContents.send(WORKSPACE_PROJECT_FOCUS_CHANNEL, project)
    },
  }))
  ipcMain.handle(WORKSPACE_OPEN_PROJECT_CHANNEL, createWorkspaceOpenProjectHandler({
    isAuthorized: isAuthorizedNativeEvent,
    identityForWebContents: (webContents) => nativeWindows.workspaceForWebContents(webContents),
    openProjectWindow,
  }))
  ipcMain.handle(TITLEBAR_APPEARANCE_CHANNEL, createNativeTitleBarAppearanceHandler({
    isAuthorized: isAuthorizedNativeEvent,
    platform: process.platform,
    windowForWebContents: (webContents) => BrowserWindow.fromWebContents(webContents),
  }))
  ipcMain.handle(WORKSPACE_RECOVERY_CHANNEL, createWorkspaceRecoveryHandler({
    isAuthorized: isAuthorizedNativeEvent,
    identityForWebContents: (webContents) => nativeWindows.workspaceForWebContents(webContents),
    recoveryFilePath: process.env.ENSYNC_WORKSPACE_RECOVERY_FILE ?? null,
  }))
  ipcMain.handle(CODEX_CONVERSATION_IMPORT_CHANNEL, createCodexConversationImportHandler({
    isAuthorized: isAuthorizedNativeEvent,
    identityForWebContents: (webContents) => nativeWindows.workspaceForWebContents(webContents),
    transcriptPath: process.env.ENSYNC_CODEX_IMPORT_TRANSCRIPT ?? null,
    historyPath: process.env.ENSYNC_CODEX_IMPORT_HISTORY ?? null,
    projectPath: process.env.ENSYNC_CODEX_IMPORT_PROJECT ?? null,
    targetWorkspaceId: process.env.ENSYNC_CODEX_IMPORT_TARGET ?? null,
    confirmation: process.env.ENSYNC_CODEX_IMPORT_CONFIRM ?? null,
  }))
  ipcMain.handle(PROJECT_FOLDER_PICKER_CHANNEL, createProjectFolderPickerHandler({
    isAuthorized: isAuthorizedNativeEvent,
    openDialog: async (event, options) => {
      const parent = BrowserWindow.fromWebContents(event.sender)
      return parent
        ? dialog.showOpenDialog(parent, options)
        : dialog.showOpenDialog(options)
    },
    onError: (error) => console.error('[ensync-folder-picker]', error),
  }))
  const recentProjectHandlers = createRecentProjectHandlers({
    isAuthorized: isAuthorizedNativeEvent,
    store: recentProjectStore,
    onChanged: (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || !nativeWindows.ownsWebContents(window.webContents)
          || !isAppUrl(window.webContents.getURL())) continue
        window.webContents.send(RECENT_PROJECTS_CHANGED_CHANNEL, state)
      }
    },
  })
  ipcMain.handle(RECENT_PROJECTS_GET_CHANNEL, recentProjectHandlers.get)
  ipcMain.handle(RECENT_PROJECTS_MIGRATE_CHANNEL, recentProjectHandlers.migrate)
  ipcMain.handle(RECENT_PROJECTS_REMEMBER_CHANNEL, recentProjectHandlers.remember)
  const devicePreferencesHandlers = createDevicePreferencesHandlers({
    isAuthorized: isAuthorizedNativeEvent,
    store: devicePreferencesStore,
  })
  ipcMain.handle(DEVICE_PREFERENCES_GET_CHANNEL, devicePreferencesHandlers.get)
  ipcMain.handle(
    COMPLETION_NOTIFICATION_PREFERENCES_SET_CHANNEL,
    devicePreferencesHandlers.setCompletionNotifications,
  )
  const updateActions = new Map([
    [UPDATE_GET_STATE_CHANNEL, () => updateManager.getState()],
    [UPDATE_CHECK_CHANNEL, () => updateManager.check()],
    [UPDATE_DOWNLOAD_CHANNEL, () => updateManager.download()],
    [UPDATE_CANCEL_CHANNEL, () => updateManager.cancel()],
    [UPDATE_OPEN_INSTALLER_CHANNEL, () => updateManager.openDownloadedInstaller()],
    [UPDATE_SET_CHANNEL_CHANNEL, (channel) => updateManager.setChannel(channel)],
  ])
  for (const [channel, action] of updateActions) {
    ipcMain.handle(channel, createAuthorizedUpdateHandler({
      isAuthorized: isAuthorizedNativeEvent,
      action,
    }))
  }
  nativeBridgeRegistered = true
}

function unregisterNativeBridge() {
  // Do not create a live-renderer gap during quit/recovery. The process can
  // release its handlers only after the last registered window is gone.
  if (nativeWindows.size > 0) return false
  workspaceIdentityIpc.dispose()
  if (!nativeBridgeRegistered) return true
  ipcMain.removeHandler(PROJECT_FOLDER_PICKER_CHANNEL)
  ipcMain.removeHandler(WORKSPACE_FOCUS_CHANNEL)
  ipcMain.removeHandler(WORKSPACE_OPEN_PROJECT_CHANNEL)
  ipcMain.removeHandler(TITLEBAR_APPEARANCE_CHANNEL)
  ipcMain.removeHandler(WORKSPACE_RECOVERY_CHANNEL)
  ipcMain.removeHandler(CODEX_CONVERSATION_IMPORT_CHANNEL)
  ipcMain.removeHandler(RECENT_PROJECTS_GET_CHANNEL)
  ipcMain.removeHandler(RECENT_PROJECTS_MIGRATE_CHANNEL)
  ipcMain.removeHandler(RECENT_PROJECTS_REMEMBER_CHANNEL)
  ipcMain.removeHandler(DEVICE_PREFERENCES_GET_CHANNEL)
  ipcMain.removeHandler(COMPLETION_NOTIFICATION_PREFERENCES_SET_CHANNEL)
  ipcMain.removeHandler(UPDATE_GET_STATE_CHANNEL)
  ipcMain.removeHandler(UPDATE_CHECK_CHANNEL)
  ipcMain.removeHandler(UPDATE_DOWNLOAD_CHANNEL)
  ipcMain.removeHandler(UPDATE_CANCEL_CHANNEL)
  ipcMain.removeHandler(UPDATE_OPEN_INSTALLER_CHANNEL)
  ipcMain.removeHandler(UPDATE_SET_CHANNEL_CHANNEL)
  nativeBridgeRegistered = false
  return true
}

function broadcastUpdateState(state) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (
      window.isDestroyed()
      || !nativeWindows.ownsWebContents(window.webContents)
      || !isAppUrl(window.webContents.getURL())
    ) continue
    window.webContents.send(UPDATE_STATE_CHANNEL, state)
  }
}

async function stopRuntime() {
  unregisterNativeBridge()
  if (appProtocolRegistered) {
    protocol.unhandle(APP_SCHEME)
    appProtocolRegistered = false
  }
  // Closing Ensync releases only this shell's lease. The detached Host keeps
  // active provider jobs and their output buffer alive for the next launch.
  const stoppingHost = hostController?.release()
  hostController = null
  await Promise.allSettled([stoppingHost])
}

async function ensureRuntime() {
  if (runtimeStart) return runtimeStart
  if (hostController && appProtocolRegistered) return

  const paths = runtimePaths()
  runtimeStart = (async () => {
    const controller = new HostProcessController({
      bootstrapPath: paths.bootstrapPath,
      hostEntryPath: paths.hostEntryPath,
      executable: process.execPath,
      cwd: app.getPath('home'),
      env: {
        ENSYNC_DEFAULT_PROJECT_PATH: app.getPath('home'),
        ENSYNC_HOST_PROJECT_ISOLATION_ROOT: join(app.getPath('userData'), HOST_PROJECT_ISOLATION_DIRECTORY),
      },
      stateFilePath: join(app.getPath('userData'), HOST_DAEMON_STATE_FILENAME),
      journalFilePath: join(app.getPath('userData'), HOST_JOB_JOURNAL_FILENAME),
    })
    await controller.start()
    try {
      const handler = await createAppProtocolHandler({
        uiRoot: paths.uiRoot,
        // Resolve the endpoint for every API request. Healthy traffic reuses
        // the cached lease; if the detached Host actually ended, the controller
        // starts exactly one journal-aware replacement before proxying.
        resolveHostConnection: () => controller.ensureConnected(),
      })
      protocol.handle(APP_SCHEME, handler)
      hostController = controller
      appProtocolRegistered = true
    } catch (error) {
      await controller.stop()
      throw error
    }
  })()

  try {
    await runtimeStart
  } finally {
    runtimeStart = null
  }
}

function isAppUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST
  } catch {
    return false
  }
}

async function createWindow(workspaceIdentity) {
  if (!isNativeWorkspaceIdentity(workspaceIdentity)) {
    throw new Error('A verified native workspace identity is required to create a window.')
  }
  const existingWindow = nativeWindows.windowForWorkspace(workspaceIdentity.id)
  if (existingWindow) {
    showWindow(existingWindow)
    return existingWindow
  }

  // This synchronous assertion must precede BrowserWindow construction: the
  // preload can invoke identity IPC as soon as navigation starts.
  workspaceIdentityIpc.register()
  await ensureRuntime()
  const existingWindowAfterRuntimeStart = nativeWindows.windowForWorkspace(workspaceIdentity.id)
  if (existingWindowAfterRuntimeStart) {
    showWindow(existingWindowAfterRuntimeStart)
    return existingWindowAfterRuntimeStart
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#17181c',
    title: 'Ensync',
    ...nativeWindowFrameOptions(process.platform),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(desktopRoot, 'src', 'preload.cjs'),
      sandbox: true,
      spellcheck: true,
    },
  })
  nativeWindows.add(window, workspaceIdentity)
  const recovery = createRendererCrashRecovery()
  let recoveryBlockedNoticeShown = false
  let preserveWorkspaceRecord = false

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (url.startsWith('https://')) void shell.openExternal(url)
  })
  window.webContents.on('did-finish-load', () => {
    recovery.rendererLoaded()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    if (quitting || window.isDestroyed()) return
    if (!recovery.requestReload(details)) {
      if (!recoveryBlockedNoticeShown) {
        recoveryBlockedNoticeShown = true
        dialog.showErrorBox(
          'Ensync stopped reloading',
          'The workspace renderer ended repeatedly. Ensync kept the last committed workspace snapshot and stopped automatic reloads to avoid a crash loop. Close and reopen the app after checking the installation.',
        )
      }
      return
    }

    void ensureRuntime()
      .then(() => {
        if (!quitting && !window.isDestroyed()) {
          return window.loadURL(`${APP_ORIGIN}/`)
        }
        return undefined
      })
      .catch((error) => {
        console.error('[ensync-renderer-recovery]', error)
        if (!recoveryBlockedNoticeShown) {
          recoveryBlockedNoticeShown = true
          dialog.showErrorBox(
            'Ensync could not recover the workspace',
            error instanceof Error ? error.message : 'The renderer could not be reloaded.',
          )
        }
      })
  })
  window.on('focus', () => {
    nativeWindows.focus(window)
    nativeWorkspaceStore?.touch(workspaceIdentity.id)
  })
  window.once('ready-to-show', () => showWindow(window))
  window.on('closed', () => {
    recovery.dispose()
    projectLaunchByWorkspace.delete(workspaceIdentity.id)
    const retainWorkspace = shouldRetainNativeWorkspaceOnClose({
      identity: workspaceIdentity,
      quitting: quitting || preserveWorkspaceRecord,
      platform: process.platform,
      openWindowCount: nativeWindows.size,
    })
    if (!retainWorkspace) {
      nativeWorkspaceStore?.remove(workspaceIdentity.id)
    }
    nativeWindows.remove(window)
  })
  try {
    await window.loadURL(`${APP_ORIGIN}/`)
    return window
  } catch (error) {
    preserveWorkspaceRecord = true
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
}

if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!showWindow()) openNewWindow()
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void stopRuntime().finally(() => app.quit())
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (nativeWindows.size > 0) showWindow()
    else {
      const identity = nativeWorkspaceStore?.ensureCanonical()
      if (identity) void createWindow(identity).catch(handleStartupFailure)
    }
  })

  // Do not top-level-await app readiness from an ESM main module. Electron waits
  // for module evaluation before completing parts of startup on some platforms.
  void app.whenReady().then(() => {
    nativeWorkspaceStore = createNativeWorkspaceStore({
      filePath: join(app.getPath('userData'), NATIVE_WORKSPACE_STATE_FILENAME),
    })
    recentProjectStore = createRecentProjectStore({
      filePath: join(app.getPath('userData'), RECENT_PROJECTS_FILENAME),
    })
    devicePreferencesStore = createDevicePreferencesStore({
      filePath: join(app.getPath('userData'), DEVICE_PREFERENCES_FILENAME),
    })
    updateManager = createNativeUpdateManager({
      installedVersion: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      executablePath: process.execPath,
      manifestUrls: configuredUpdateManifestUrls(),
      initialChannel: devicePreferencesStore.get().updateChannel,
      tempRoot: app.getPath('temp'),
      openInstaller: (path) => shell.openPath(path),
      persistChannel: (channel) => devicePreferencesStore.setUpdateChannel(channel),
      onStateChange: broadcastUpdateState,
    })
    // Register native IPC before awaiting updater initialization. On macOS an
    // activate event may create a window while that async work is in flight.
    registerNativeBridge()
    installApplicationMenu()
    nativeWorkspaceStore.ensureCanonical()
    return updateManager.initialize()
  }).then(() => {
    const retainedIdentities = nativeWorkspaceStore.list()
    const startupFocusIdentity = retainedIdentities.at(-1)
    const identities = nativeWorkspaceRestorationOrder(retainedIdentities)
    return identities.reduce(
      (previous, identity) => previous.then(() => createWindow(identity)),
      Promise.resolve(),
    ).then(() => {
      // Canonical must hydrate first, but the last-used retained workspace must
      // be visible after restoration. Otherwise a clean secondary window can
      // make the user's saved chats look as if they disappeared.
      if (startupFocusIdentity) {
        showWindow(nativeWindows.windowForWorkspace(startupFocusIdentity.id))
      }
    })
  }).catch(handleStartupFailure)
}

async function handleStartupFailure(error) {
  const message = error instanceof Error ? error.message : 'Unknown desktop startup error.'
  console.error(error)
  await stopRuntime()
  dialog.showErrorBox('Ensync could not start', message)
  app.quit()
}

function handleWindowCreationFailure(error) {
  const message = error instanceof Error ? error.message : 'Unknown window creation error.'
  console.error(error)
  dialog.showErrorBox('Ensync could not open a new window', message)
}
