import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import * as windowState from '../src/window-state.mjs'

const workspaceId = '3f3a2b1c-1111-4a2b-8c3d-4e5f60718293'
const compactDisplay = Object.freeze({ workArea: { x: 0, y: 24, width: 1280, height: 720 } })
const externalDisplay = Object.freeze({ workArea: { x: 1280, y: 0, width: 2560, height: 1440 } })
const tinyDisplay = Object.freeze({ workArea: { x: 0, y: 20, width: 800, height: 560 } })

function fakeWindow(bounds, { minimized = false } = {}) {
  const window = new EventEmitter()
  Object.assign(window, {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isMaximized: () => false,
    isFullScreen: () => false,
    getNormalBounds: () => bounds,
  })
  return window
}

test('a native window session constrains new and restored windows to the current display', () => {
  const createSession = windowState.createWindowStateSession
  const newWindow = typeof createSession === 'function'
    ? createSession({
        workspaceId,
        primaryDisplay: compactDisplay,
        displays: [externalDisplay, compactDisplay],
      })
    : null

  assert.deepEqual(newWindow?.placement, {
    bounds: { width: 1280, height: 720 },
    maximized: false,
    fullScreen: false,
  })
  assert.deepEqual(newWindow?.browserWindowOptions, {
    width: 1280,
    height: 720,
    minWidth: 900,
    minHeight: 620,
  })

  const savedState = {
    x: 1100,
    y: 650,
    width: 1200,
    height: 800,
    maximized: false,
    fullScreen: false,
  }
  const restoredWindow = typeof createSession === 'function'
    ? createSession({
        workspaceId,
        primaryDisplay: compactDisplay,
        displays: [compactDisplay],
        store: { get: () => savedState },
      })
    : null

  assert.deepEqual(restoredWindow?.placement.bounds, { x: 80, y: 24, width: 1200, height: 720 })
})

test('a work area smaller than the normal minimum remains the hard window bound', () => {
  const session = windowState.createWindowStateSession?.({
    workspaceId,
    primaryDisplay: tinyDisplay,
    displays: [tinyDisplay],
  })

  assert.deepEqual(session?.placement.bounds, { width: 800, height: 560 })
  assert.deepEqual(session?.browserWindowOptions, {
    width: 800,
    height: 560,
    minWidth: 800,
    minHeight: 560,
  })
})

test('fullscreen is passed only when restoring a fullscreen window', () => {
  const normal = windowState.createWindowStateSession?.({ workspaceId, displays: [compactDisplay] })
  const fullscreen = windowState.createWindowStateSession?.({
    workspaceId,
    displays: [compactDisplay],
    store: {
      get: () => ({
        x: 40,
        y: 40,
        width: 1000,
        height: 640,
        maximized: false,
        fullScreen: true,
      }),
    },
  })

  assert.equal(Object.hasOwn(normal?.browserWindowOptions ?? {}, 'fullscreen'), false)
  assert.equal(fullscreen?.browserWindowOptions?.fullscreen, true)
})

test('a maximized window waits for renderer readiness before maximizing and showing', () => {
  const session = windowState.createWindowStateSession?.({
    workspaceId,
    displays: [compactDisplay],
    store: {
      get: () => ({
        x: 40,
        y: 40,
        width: 1000,
        height: 640,
        maximized: true,
        fullScreen: false,
      }),
    },
  })
  const calls = []
  const window = fakeWindow({ x: 40, y: 40, width: 1000, height: 640 })
  window.maximize = () => calls.push('maximize')

  const registered = session?.showWhenReady?.(window, () => calls.push('show'))
  assert.equal(registered, true)
  assert.deepEqual(calls, [])

  window.emit('ready-to-show')
  assert.deepEqual(calls, ['maximize', 'show'])
})

test('a native window session persists live normal bounds and removes discarded workspace state', async (t) => {
  const createSession = windowState.createWindowStateSession
  assert.equal(typeof createSession, 'function')

  const directory = await mkdtemp(join(tmpdir(), 'ensync-window-session-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = windowState.createWindowStateStore({
    filePath: join(directory, windowState.NATIVE_WINDOW_STATE_FILENAME),
  })
  const session = createSession({ workspaceId, displays: [compactDisplay], store })
  const window = fakeWindow({ x: 40, y: 60, width: 1000, height: 640 })

  const dispose = session.observe(window)
  window.emit('close')
  assert.deepEqual(store.get(workspaceId), {
    x: 40,
    y: 60,
    width: 1000,
    height: 640,
    maximized: false,
    fullScreen: false,
  })

  dispose()
  session.forget()
  assert.equal(store.list().length, 0)
})

test('closing while minimized still persists the window normal bounds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-window-minimized-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = windowState.createWindowStateStore({
    filePath: join(directory, windowState.NATIVE_WINDOW_STATE_FILENAME),
  })
  const session = windowState.createWindowStateSession({ workspaceId, displays: [compactDisplay], store })
  const window = fakeWindow({ x: 30, y: 50, width: 980, height: 630 }, { minimized: true })

  session.observe(window)
  window.emit('close')

  assert.deepEqual(store.get(workspaceId), {
    x: 30,
    y: 50,
    width: 980,
    height: 630,
    maximized: false,
    fullScreen: false,
  })
})

test('the packaged desktop includes native window-state handling', async () => {
  const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'))
  assert.ok(manifest.build.files.includes('src/window-state.mjs'))
})
