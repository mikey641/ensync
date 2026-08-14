import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  createWindowStateStore,
  DEFAULT_WINDOW_BOUNDS,
  MINIMUM_WINDOW_BOUNDS,
  NATIVE_WINDOW_STATE_FILENAME,
  normalizeWindowState,
  readNativeWindowState,
  resolveWindowPlacement,
} from '../src/window-state.mjs'

const laptop = Object.freeze({ workArea: { x: 0, y: 25, width: 1512, height: 945 } })
const external = Object.freeze({ workArea: { x: 1512, y: 0, width: 2560, height: 1415 } })
const workspaceId = '3f3a2b1c-1111-4a2b-8c3d-4e5f60718293'
const otherWorkspaceId = '3f3a2b1c-2222-4a2b-8c3d-4e5f60718293'

const maximizedOnLaptop = Object.freeze({
  x: 0,
  y: 25,
  width: 1512,
  height: 945,
  maximized: true,
  fullScreen: false,
})

test('window state normalization keeps whole-pixel geometry and rejects unusable records', () => {
  assert.deepEqual(
    normalizeWindowState({ x: 12, y: 34, width: 1200, height: 800, maximized: false, fullScreen: false }),
    { x: 12, y: 34, width: 1200, height: 800, maximized: false, fullScreen: false },
  )
  assert.deepEqual(normalizeWindowState({ ...maximizedOnLaptop }), maximizedOnLaptop)

  assert.equal(normalizeWindowState(null), null)
  assert.equal(normalizeWindowState('1440x940'), null)
  assert.equal(normalizeWindowState({ x: 0, y: 0, width: 0, height: 800 }), null)
  assert.equal(normalizeWindowState({ x: 0, y: 0, width: 1200, height: Number.NaN }), null)
  assert.equal(normalizeWindowState({ x: 1.5, y: 0, width: 1200, height: 800 }), null)
  assert.equal(normalizeWindowState({ x: 0, y: 0, width: 1200, height: 800, maximized: 'yes' }), null)
  assert.equal(normalizeWindowState({ x: 0, y: 0, width: 9_000_000, height: 800 }), null)
})

test('a window with no saved state opens at the default size without a forced position', () => {
  const placement = resolveWindowPlacement({ state: null, displays: [laptop] })

  assert.deepEqual(placement, {
    bounds: { width: DEFAULT_WINDOW_BOUNDS.width, height: DEFAULT_WINDOW_BOUNDS.height },
    maximized: false,
    fullScreen: false,
  })
})

test('a saved window that still fits its display reopens at the exact same rectangle', () => {
  const state = { x: 1600, y: 120, width: 2000, height: 1200, maximized: false, fullScreen: false }

  const placement = resolveWindowPlacement({ state, displays: [laptop, external] })

  assert.deepEqual(placement, {
    bounds: { x: 1600, y: 120, width: 2000, height: 1200 },
    maximized: false,
    fullScreen: false,
  })
})

test('maximized and full-screen windows reopen in the same presentation', () => {
  assert.deepEqual(
    resolveWindowPlacement({ state: maximizedOnLaptop, displays: [laptop] }),
    { bounds: { x: 0, y: 25, width: 1512, height: 945 }, maximized: true, fullScreen: false },
  )
  assert.deepEqual(
    resolveWindowPlacement({
      state: { x: 40, y: 60, width: 1200, height: 800, maximized: false, fullScreen: true },
      displays: [laptop],
    }),
    { bounds: { x: 40, y: 60, width: 1200, height: 800 }, maximized: false, fullScreen: true },
  )
})

test('a window saved on a disconnected display reopens visible on the remaining screen', () => {
  const state = { x: 2400, y: 400, width: 1600, height: 1000, maximized: false, fullScreen: false }

  const placement = resolveWindowPlacement({ state, displays: [laptop] })

  assert.equal(placement.bounds.x, undefined)
  assert.equal(placement.bounds.y, undefined)
  assert.equal(placement.bounds.width, 1512)
  assert.equal(placement.bounds.height, 945)
})

test('an oversized saved window is clamped into the work area but never below the minimum size', () => {
  const oversized = resolveWindowPlacement({
    state: { x: 0, y: 25, width: 4000, height: 3000, maximized: false, fullScreen: false },
    displays: [laptop],
  })
  assert.deepEqual(oversized.bounds, { x: 0, y: 25, width: 1512, height: 945 })

  const tiny = resolveWindowPlacement({
    state: { x: 10, y: 40, width: 300, height: 200, maximized: false, fullScreen: false },
    displays: [laptop],
  })
  assert.equal(tiny.bounds.width, MINIMUM_WINDOW_BOUNDS.width)
  assert.equal(tiny.bounds.height, MINIMUM_WINDOW_BOUNDS.height)
})

test('a window hanging off the edge of its display is pulled back into the work area', () => {
  const placement = resolveWindowPlacement({
    state: { x: 1400, y: 900, width: 1200, height: 800, maximized: false, fullScreen: false },
    displays: [laptop],
  })

  assert.ok(placement.bounds.x + placement.bounds.width <= laptop.workArea.x + laptop.workArea.width)
  assert.ok(placement.bounds.y + placement.bounds.height <= laptop.workArea.y + laptop.workArea.height)
  assert.ok(placement.bounds.x >= laptop.workArea.x)
  assert.ok(placement.bounds.y >= laptop.workArea.y)
})

test('window state is read from the restored rectangle, not the maximized one', () => {
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    getNormalBounds: () => ({ x: 120, y: 90, width: 1440, height: 940 }),
    isMaximized: () => true,
    isFullScreen: () => false,
  }

  assert.deepEqual(readNativeWindowState(window), {
    x: 120,
    y: 90,
    width: 1440,
    height: 940,
    maximized: true,
    fullScreen: false,
  })
})

test('minimized and destroyed windows report no state so a stashed window is never saved', () => {
  const base = {
    getNormalBounds: () => ({ x: 0, y: 0, width: 1440, height: 940 }),
    isMaximized: () => false,
    isFullScreen: () => false,
  }

  assert.equal(readNativeWindowState({ ...base, isDestroyed: () => false, isMinimized: () => true }), null)
  assert.equal(readNativeWindowState({ ...base, isDestroyed: () => true, isMinimized: () => false }), null)
  assert.equal(readNativeWindowState(null), null)
})

test('saved window state survives a store restart for the same workspace', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-window-state-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, NATIVE_WINDOW_STATE_FILENAME)

  const first = createWindowStateStore({ filePath })
  assert.equal(first.get(workspaceId), null)
  first.save(workspaceId, maximizedOnLaptop)

  const restored = createWindowStateStore({ filePath })
  assert.deepEqual(restored.get(workspaceId), maximizedOnLaptop)

  const envelope = JSON.parse(await readFile(filePath, 'utf8'))
  assert.equal(envelope.format, 'ensync-native-window-state')
  assert.equal(envelope.version, 1)
})

test('a brand-new workspace inherits the most recently saved window state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-window-state-inherit-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createWindowStateStore({ filePath: join(directory, NATIVE_WINDOW_STATE_FILENAME) })

  store.save(workspaceId, { x: 0, y: 25, width: 1200, height: 800, maximized: false, fullScreen: false })
  store.save(otherWorkspaceId, maximizedOnLaptop)

  assert.deepEqual(store.get('9a9a9a9a-3333-4a2b-8c3d-4e5f60718293'), maximizedOnLaptop)
  assert.deepEqual(store.get(workspaceId), {
    x: 0, y: 25, width: 1200, height: 800, maximized: false, fullScreen: false,
  })
})

test('window state ignores unusable records and a corrupt file instead of blocking startup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-window-state-corrupt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, NATIVE_WINDOW_STATE_FILENAME)
  await writeFile(filePath, '{ not json', 'utf8')

  const store = createWindowStateStore({ filePath })
  assert.equal(store.get(workspaceId), null)
  assert.equal(store.save(workspaceId, { width: 10, height: 10 }), false)
  assert.equal(store.get(workspaceId), null)
  assert.equal(store.save(workspaceId, maximizedOnLaptop), true)
  assert.deepEqual(createWindowStateStore({ filePath }).get(workspaceId), maximizedOnLaptop)
})

test('closed workspaces drop their window state and the store stays bounded', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-window-state-bounds-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = createWindowStateStore({ filePath: join(directory, NATIVE_WINDOW_STATE_FILENAME) })

  store.save(workspaceId, maximizedOnLaptop)
  assert.equal(store.remove(workspaceId), true)
  assert.equal(store.remove(workspaceId), false)

  for (let index = 0; index < 40; index += 1) {
    const id = `3f3a2b1c-${String(index).padStart(4, '0')}-4a2b-8c3d-4e5f60718293`
    store.save(id, { x: index, y: 25, width: 1200, height: 800, maximized: false, fullScreen: false })
  }
  const retained = store.list().map((record) => record.workspaceId)
  assert.equal(retained.length, 32)
  assert.equal(retained.includes('3f3a2b1c-0000-4a2b-8c3d-4e5f60718293'), false)
  assert.equal(retained.at(-1), '3f3a2b1c-0039-4a2b-8c3d-4e5f60718293')
  assert.equal(store.get('3f3a2b1c-0039-4a2b-8c3d-4e5f60718293').x, 39)
  // An evicted workspace still opens like the newest window rather than a stock one.
  assert.equal(store.get('3f3a2b1c-0000-4a2b-8c3d-4e5f60718293').x, 39)
})

test('every native window is built from resolved placement instead of a fixed size', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../src/main.mjs'), 'utf8')
  const createWindowBlock = source.slice(
    source.indexOf('async function createWindow('),
    source.indexOf('if (!singleInstance)'),
  )

  assert.ok(createWindowBlock.includes('resolveWindowPlacement({'))
  assert.ok(createWindowBlock.indexOf('resolveWindowPlacement({') < createWindowBlock.indexOf('new BrowserWindow('))
  assert.ok(createWindowBlock.includes('...placement.bounds'))
  assert.ok(createWindowBlock.includes('fullscreen: placement.fullScreen'))
  assert.ok(createWindowBlock.includes('window.maximize()'))
  assert.ok(createWindowBlock.indexOf('window.maximize()') < createWindowBlock.indexOf("window.once('ready-to-show'"))
  assert.equal(/\bwidth: 1440\b/.test(createWindowBlock), false)
  assert.equal(/\bheight: 940\b/.test(createWindowBlock), false)
})

test('window geometry is captured while the window still exists and before the workspace is dropped', async () => {
  const source = await readFile(resolve(import.meta.dirname, '../src/main.mjs'), 'utf8')
  const createWindowBlock = source.slice(
    source.indexOf('async function createWindow('),
    source.indexOf('if (!singleInstance)'),
  )

  assert.ok(createWindowBlock.includes("window.on('close', persistWindowState)"))
  assert.ok(createWindowBlock.indexOf("window.on('close', persistWindowState)")
    < createWindowBlock.indexOf("window.on('closed'"))
  for (const event of ['resize', 'move']) assert.ok(createWindowBlock.includes(`'${event}'`))
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    assert.ok(createWindowBlock.includes(`'${event}'`))
  }

  const readyBlock = source.slice(source.indexOf('void app.whenReady()'))
  assert.ok(readyBlock.includes('windowStateStore = createWindowStateStore({'))
  assert.ok(readyBlock.indexOf('windowStateStore = createWindowStateStore({')
    < readyBlock.indexOf('createWindow(identity)'))
})

test('the window-state module ships in the packaged app', async () => {
  const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'))
  assert.ok(manifest.build.files.includes('src/window-state.mjs'))
})
