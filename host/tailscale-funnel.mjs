import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'

// A Tailscale Funnel in front of the local Sync service gives the phone a
// permanent public HTTPS address (https://<machine>.<tailnet>.ts.net[:port]).
// Unlike a Cloudflare quick tunnel it survives restarts, so a linked phone
// never has to scan the QR again. The Host only detects an existing Funnel; it
// never publishes one by itself.

const CANDIDATES = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
]

function loopbackPort(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname.toLowerCase())) return null
    return url.port || (url.protocol === 'https:' ? '443' : '80')
  } catch {
    return null
  }
}

/** Picks the Funnel address that proxies `/` to the given loopback service, if any. */
export function funnelUrlFromStatus(status, localServiceUrl) {
  const port = loopbackPort(localServiceUrl)
  if (!port || !status || typeof status !== 'object') return null
  const allowed = status.AllowFunnel ?? {}
  for (const [hostPort, site] of Object.entries(status.Web ?? {})) {
    if (allowed[hostPort] !== true) continue
    const proxy = site?.Handlers?.['/']?.Proxy
    if (typeof proxy !== 'string' || loopbackPort(proxy) !== port) continue
    const [host, publicPort] = hostPort.split(':')
    if (!/^[a-z0-9.-]+\.ts\.net$/i.test(host)) continue
    return publicPort && publicPort !== '443' ? `https://${host}:${publicPort}` : `https://${host}`
  }
  return null
}

async function findTailscale() {
  for (const path of CANDIDATES) {
    try {
      await access(path)
      return path
    } catch { /* try the next one */ }
  }
  return null
}

function readStatus(binary) {
  return new Promise((resolve) => {
    execFile(binary, ['funnel', 'status', '--json'], { timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null)
      try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
    })
  })
}

/** Resolves the permanent Funnel URL for the local Sync service, or null. */
export async function detectFunnelSyncUrl(localServiceUrl, { binary } = {}) {
  if (!loopbackPort(localServiceUrl)) return null
  const tailscale = binary ?? await findTailscale()
  if (!tailscale) return null
  return funnelUrlFromStatus(await readStatus(tailscale), localServiceUrl)
}
