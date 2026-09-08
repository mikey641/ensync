const EMPTY_QUICK = Object.freeze({
  enabled: false,
  running: false,
  url: null,
  pid: null,
})

const EMPTY_STATUS = Object.freeze({
  configured: false,
  hostname: null,
  url: null,
  binaryInstalled: false,
  running: false,
  pid: null,
  quick: EMPTY_QUICK,
})

function tunnelBridge(target) {
  const bridge = target?.ensyncDesktop
  if (bridge
    && typeof bridge.getCloudflareTunnelStatus === 'function'
    && typeof bridge.setupCloudflareTunnel === 'function') {
    return bridge
  }
  return null
}

export function cloudflareTunnelAvailable(target = globalThis) {
  return tunnelBridge(target) !== null
}

function normalizeQuick(value) {
  if (!value || typeof value !== 'object') return { ...EMPTY_QUICK }
  return {
    enabled: value.enabled === true,
    running: value.running === true,
    url: typeof value.url === 'string' ? value.url : null,
    pid: Number.isInteger(value.pid) ? value.pid : null,
  }
}

function normalizeStatus(value) {
  if (!value || typeof value !== 'object') return { ...EMPTY_STATUS }
  return {
    configured: value.configured === true,
    hostname: typeof value.hostname === 'string' ? value.hostname : null,
    url: typeof value.url === 'string' ? value.url : null,
    binaryInstalled: value.binaryInstalled === true,
    running: value.running === true,
    pid: Number.isInteger(value.pid) ? value.pid : null,
    quick: normalizeQuick(value.quick),
  }
}

export async function readCloudflareTunnelStatus(target = globalThis) {
  const bridge = tunnelBridge(target)
  if (!bridge) return { ...EMPTY_STATUS }
  try {
    return normalizeStatus(await bridge.getCloudflareTunnelStatus())
  } catch {
    return { ...EMPTY_STATUS }
  }
}

async function guarded(promise) {
  try {
    return await promise
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'The phone connection action failed.' }
  }
}

export function setupCloudflareTunnel(input, target = globalThis) {
  const bridge = tunnelBridge(target)
  if (!bridge) return Promise.resolve({ ok: false, error: 'Phone access is available only in the Ensync desktop app.' })
  return guarded(bridge.setupCloudflareTunnel(input))
}

export function startCloudflareTunnel(target = globalThis) {
  const bridge = tunnelBridge(target)
  if (!bridge) return Promise.resolve({ ok: false, error: 'Phone access is available only in the Ensync desktop app.' })
  return guarded(bridge.startCloudflareTunnel())
}

export function stopCloudflareTunnel(target = globalThis) {
  const bridge = tunnelBridge(target)
  if (!bridge) return Promise.resolve({ ok: false, error: 'Phone access is available only in the Ensync desktop app.' })
  return guarded(bridge.stopCloudflareTunnel())
}

export function clearCloudflareTunnel(target = globalThis) {
  const bridge = tunnelBridge(target)
  if (!bridge) return Promise.resolve({ ok: false, error: 'Phone access is available only in the Ensync desktop app.' })
  return guarded(bridge.clearCloudflareTunnel())
}

export function startCloudflareQuickTunnel(target = globalThis) {
  const bridge = tunnelBridge(target)
  if (!bridge) return Promise.resolve({ ok: false, error: 'Phone access is available only in the Ensync desktop app.' })
  return guarded(bridge.startCloudflareQuickTunnel())
}

export function stopCloudflareQuickTunnel(target = globalThis) {
  const bridge = tunnelBridge(target)
  if (!bridge) return Promise.resolve({ ok: false, error: 'Phone access is available only in the Ensync desktop app.' })
  return guarded(bridge.stopCloudflareQuickTunnel())
}
