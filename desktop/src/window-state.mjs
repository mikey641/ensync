import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const NATIVE_WINDOW_STATE_FILENAME = 'native-window-state-v1.json'
export const DEFAULT_WINDOW_BOUNDS = Object.freeze({ width: 1440, height: 940 })
export const MINIMUM_WINDOW_BOUNDS = Object.freeze({ width: 900, height: 620 })

const FORMAT = 'ensync-native-window-state'
const VERSION = 1
const MAX_RECORDS = 32
const COORDINATE_LIMIT = 100_000

function checksum(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isCoordinate(value) {
  return Number.isSafeInteger(value) && Math.abs(value) <= COORDINATE_LIMIT
}

function isExtent(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= COORDINATE_LIMIT
}

export function normalizeWindowState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!isCoordinate(value.x) || !isCoordinate(value.y)) return null
  if (!isExtent(value.width) || !isExtent(value.height)) return null
  const maximized = value.maximized === undefined ? false : value.maximized
  const fullScreen = value.fullScreen === undefined ? false : value.fullScreen
  if (typeof maximized !== 'boolean' || typeof fullScreen !== 'boolean') return null
  return Object.freeze({
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    maximized,
    fullScreen,
  })
}

/**
 * Reads the presentation a window should reopen with. Maximized and full-screen
 * windows report their restored rectangle so leaving that mode later does not
 * snap the window to a stale size. Electron returns these normal bounds even
 * while minimized, so closing a minimized window does not lose its placement.
 */
export function readNativeWindowState(window) {
  if (!window || typeof window !== 'object') return null
  try {
    if (window.isDestroyed()) return null
    const bounds = window.getNormalBounds()
    return normalizeWindowState({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      maximized: Boolean(window.isMaximized()),
      fullScreen: Boolean(window.isFullScreen()),
    })
  } catch {
    return null
  }
}

function normalizeWorkArea(display) {
  const area = display?.workArea ?? display?.bounds
  if (!area || !isCoordinate(area.x) || !isCoordinate(area.y)
    || !isExtent(area.width) || !isExtent(area.height)) return null
  return area
}

function visibleArea(rect, workArea) {
  const width = Math.min(rect.x + rect.width, workArea.x + workArea.width) - Math.max(rect.x, workArea.x)
  const height = Math.min(rect.y + rect.height, workArea.y + workArea.height) - Math.max(rect.y, workArea.y)
  return width > 0 && height > 0 ? width * height : 0
}

function clampExtent(value, minimum, available) {
  return Math.max(Math.min(minimum, available), Math.min(value, available))
}

/**
 * Turns a saved rectangle into bounds the current displays can actually show.
 * A window whose display was disconnected loses only its position, so it
 * reopens centered at a size the remaining screen can hold rather than
 * off-screen or at a size the user never chose.
 */
export function resolveWindowPlacement({
  state,
  displays = [],
  primaryDisplay = null,
  minimum = MINIMUM_WINDOW_BOUNDS,
  defaults = DEFAULT_WINDOW_BOUNDS,
} = {}) {
  const normalized = normalizeWindowState(state)
  const workAreas = (Array.isArray(displays) ? displays : []).map(normalizeWorkArea).filter(Boolean)
  const primary = normalizeWorkArea(primaryDisplay) ?? workAreas[0] ?? null
  if (primary && !workAreas.some((area) => area.x === primary.x && area.y === primary.y
    && area.width === primary.width && area.height === primary.height)) {
    workAreas.unshift(primary)
  }

  if (!normalized) {
    return {
      bounds: {
        width: primary ? clampExtent(defaults.width, minimum.width, primary.width) : defaults.width,
        height: primary ? clampExtent(defaults.height, minimum.height, primary.height) : defaults.height,
      },
      maximized: false,
      fullScreen: false,
    }
  }

  const presentation = { maximized: normalized.maximized, fullScreen: normalized.fullScreen }
  if (!primary) {
    return { bounds: { x: normalized.x, y: normalized.y, width: normalized.width, height: normalized.height }, ...presentation }
  }

  let target = null
  let bestVisible = 0
  for (const workArea of workAreas) {
    const area = visibleArea(normalized, workArea)
    if (area > bestVisible) {
      bestVisible = area
      target = workArea
    }
  }

  if (!target) {
    return {
      bounds: {
        width: clampExtent(normalized.width, minimum.width, primary.width),
        height: clampExtent(normalized.height, minimum.height, primary.height),
      },
      ...presentation,
    }
  }

  const width = clampExtent(normalized.width, minimum.width, target.width)
  const height = clampExtent(normalized.height, minimum.height, target.height)
  const x = Math.max(target.x, Math.min(normalized.x, target.x + target.width - width))
  const y = Math.max(target.y, Math.min(normalized.y, target.y + target.height - height))
  return { bounds: { x, y, width, height }, ...presentation }
}

const WINDOW_STATE_PERSIST_DELAY_MS = 400
const DEBOUNCED_WINDOW_STATE_EVENTS = Object.freeze(['resize', 'move'])
const IMMEDIATE_WINDOW_STATE_EVENTS = Object.freeze([
  'maximize',
  'unmaximize',
  'enter-full-screen',
  'leave-full-screen',
  'close',
])

/**
 * Couples one native workspace identity to its display-aware placement and
 * live BrowserWindow geometry without making the Electron entry point own the
 * persistence timing details.
 */
export function createWindowStateSession({
  workspaceId,
  store = null,
  displays = [],
  primaryDisplay = null,
  minimum = MINIMUM_WINDOW_BOUNDS,
  persistDelayMs = WINDOW_STATE_PERSIST_DELAY_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const placement = resolveWindowPlacement({
    state: store?.get?.(workspaceId) ?? null,
    displays,
    primaryDisplay,
    minimum,
  })
  const browserWindowOptions = Object.freeze({
    ...placement.bounds,
    minWidth: Math.min(minimum.width, placement.bounds.width),
    minHeight: Math.min(minimum.height, placement.bounds.height),
    ...(placement.fullScreen ? { fullscreen: true } : {}),
  })
  const delay = Number.isFinite(persistDelayMs) && persistDelayMs >= 0
    ? persistDelayMs
    : WINDOW_STATE_PERSIST_DELAY_MS
  let observedWindow = null
  let timer = null

  const clearScheduledPersist = () => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }
  const persist = () => {
    clearScheduledPersist()
    const state = readNativeWindowState(observedWindow)
    if (state) store?.save?.(workspaceId, state)
  }
  const schedulePersist = () => {
    clearScheduledPersist()
    timer = setTimer(persist, delay)
  }
  const dispose = () => {
    clearScheduledPersist()
    if (observedWindow?.removeListener) {
      for (const event of DEBOUNCED_WINDOW_STATE_EVENTS) {
        observedWindow.removeListener(event, schedulePersist)
      }
      for (const event of IMMEDIATE_WINDOW_STATE_EVENTS) {
        observedWindow.removeListener(event, persist)
      }
    }
    observedWindow = null
  }

  return Object.freeze({
    placement,
    browserWindowOptions,
    showWhenReady(window, show) {
      if (!window?.once || typeof show !== 'function') return false
      window.once('ready-to-show', () => {
        if (placement.maximized && !placement.fullScreen) window.maximize?.()
        show(window)
      })
      return true
    },
    observe(window) {
      dispose()
      if (!window?.on) return dispose
      observedWindow = window
      for (const event of DEBOUNCED_WINDOW_STATE_EVENTS) window.on(event, schedulePersist)
      for (const event of IMMEDIATE_WINDOW_STATE_EVENTS) window.on(event, persist)
      return dispose
    },
    forget() {
      return store?.remove?.(workspaceId) ?? false
    },
  })
}

function normalizeRecords(value) {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) return null
  const records = []
  const ids = new Set()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || typeof candidate.workspaceId !== 'string'
      || candidate.workspaceId.length === 0 || candidate.workspaceId.length > 128) return null
    const workspaceId = candidate.workspaceId.toLowerCase()
    if (ids.has(workspaceId)) return null
    const state = normalizeWindowState(candidate.state)
    if (!state) return null
    ids.add(workspaceId)
    records.push(Object.freeze({ workspaceId, state }))
  }
  return records
}

function decode(value) {
  try {
    const envelope = JSON.parse(value)
    if (!envelope || envelope.format !== FORMAT || envelope.version !== VERSION
      || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1
      || typeof envelope.payload !== 'string' || envelope.checksum !== checksum(envelope.payload)) return null
    const records = normalizeRecords(JSON.parse(envelope.payload))
    return records ? { revision: envelope.revision, records } : null
  } catch {
    return null
  }
}

function encode(records, revision) {
  const payload = JSON.stringify(records)
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    revision,
    checksum: checksum(payload),
    payload,
  })
}

/**
 * Remembers where each native workspace window was last arranged. Records are
 * ordered oldest first, so the newest entry is both the eviction survivor and
 * the shape a workspace that has never been placed should inherit.
 */
export function createWindowStateStore({ filePath } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('A window-state path is required.')
  const stagingPath = `${filePath}.staging`
  const readCandidate = (path) => {
    try { return decode(readFileSync(path, 'utf8')) } catch { return null }
  }
  const candidates = [readCandidate(filePath), readCandidate(stagingPath)].filter(Boolean)
  candidates.sort((left, right) => right.revision - left.revision)
  let revision = candidates[0]?.revision ?? 0
  let records = candidates[0]?.records ?? []

  const persist = () => {
    revision += 1
    const encoded = encode(records, revision)
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(stagingPath, encoded, { encoding: 'utf8', mode: 0o600 })
      writeFileSync(filePath, encoded, { encoding: 'utf8', mode: 0o600 })
      try { rmSync(stagingPath) } catch {}
      return true
    } catch {
      // Window geometry is a convenience. A read-only or full disk must never
      // take down a window that is otherwise working.
      return false
    }
  }

  const identifier = (workspaceId) => (typeof workspaceId === 'string' && workspaceId.length > 0
    && workspaceId.length <= 128
    ? workspaceId.toLowerCase()
    : null)

  return Object.freeze({
    list() { return records.map((record) => ({ workspaceId: record.workspaceId, state: { ...record.state } })) },
    get(workspaceId) {
      const id = identifier(workspaceId)
      const record = id ? records.find((item) => item.workspaceId === id) : null
      const fallback = records.at(-1) ?? null
      const resolved = record ?? fallback
      return resolved ? { ...resolved.state } : null
    },
    save(workspaceId, state) {
      const id = identifier(workspaceId)
      const normalized = normalizeWindowState(state)
      if (!id || !normalized) return false
      const existing = records.find((item) => item.workspaceId === id)
      if (existing && records.at(-1) === existing
        && existing.state.x === normalized.x && existing.state.y === normalized.y
        && existing.state.width === normalized.width && existing.state.height === normalized.height
        && existing.state.maximized === normalized.maximized
        && existing.state.fullScreen === normalized.fullScreen) return true
      const retained = records.filter((item) => item.workspaceId !== id)
      records = [...retained, Object.freeze({ workspaceId: id, state: normalized })].slice(-MAX_RECORDS)
      persist()
      return true
    },
    remove(workspaceId) {
      const id = identifier(workspaceId)
      if (!id) return false
      const next = records.filter((item) => item.workspaceId !== id)
      if (next.length === records.length) return false
      records = next
      persist()
      return true
    },
  })
}
