import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

// Dependency-free Cloudflare Tunnel bridge for the desktop shell. Everything
// that talks to the network or spawns a process is injectable so the module
// can be tested without a Cloudflare account or an installed cloudflared.
//
// Lifecycle:
//   1. resolve a cloudflared binary (explicit env, an already-downloaded copy,
//      or a PATH hit);
//   2. provision a remotely-managed tunnel through the Cloudflare REST API:
//      create tunnel -> fetch its run token -> configure ingress to point the
//      public hostname at the local loopback service -> add a proxied CNAME;
//   3. run `cloudflared tunnel --no-autoupdate run --token <token>` detached;
//   4. persist the non-secret identity (hostname/tunnel id) locally while the
//      caller encrypts the two secrets (API token and run token) itself.
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4'
const CLOUDFLARED_RELEASE_TEMPLATE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-{platform}-{arch}{extension}'

export class CloudflareTunnelError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message)
    this.name = 'CloudflareTunnelError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export function cloudflaredAsset({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'darwin') {
    const macArch = arch === 'arm64' ? 'arm64' : 'amd64'
    return {
      platform: 'darwin',
      arch: macArch,
      archive: `cloudflared-darwin-${macArch}.tgz`,
      extension: '.tgz',
      binaryName: 'cloudflared',
    }
  }
  if (platform === 'win32') {
    const winArch = arch === 'arm64' ? 'arm64' : 'amd64'
    return {
      platform: 'windows',
      arch: winArch,
      archive: `cloudflared-windows-${winArch}.exe`,
      extension: '.exe',
      binaryName: `cloudflared-${winArch}.exe`,
    }
  }
  if (platform === 'linux') {
    const linuxArch = arch === 'arm64' ? 'arm64' : 'amd64'
    let binaryName = `cloudflared-linux-${linuxArch}`
    if (binaryName.endsWith('-amd64')) binaryName = 'cloudflared-linux-amd64'
    return {
      platform: 'linux',
      arch: linuxArch,
      archive: binaryName,
      extension: '',
      binaryName,
    }
  }
  throw new CloudflareTunnelError(
    'cloudflared_platform_unsupported',
    `cloudflared has no packaged build for ${platform}/${arch}.`,
  )
}

export function cloudflaredDownloadUrl(asset = cloudflaredAsset()) {
  return CLOUDFLARED_RELEASE_TEMPLATE.replace('{platform}', asset.platform)
    .replace('{arch}', asset.arch)
    .replace('{extension}', asset.extension)
}

/** Force a stable, hidden filename for the downloaded binary on every platform. */
export function cloudflaredBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

export function resolveLocalCloudflaredPath({ platform = process.platform, appBinsDir, env = process.env }) {
  if (typeof env.ENSYNC_CLOUDFLARED_PATH === 'string' && env.ENSYNC_CLOUDFLARED_PATH.trim()) {
    return env.ENSYNC_CLOUDFLARED_PATH.trim()
  }
  if (typeof appBinsDir === 'string' && appBinsDir) {
    return join(appBinsDir, cloudflaredBinaryName(platform))
  }
  return null
}

async function cloudflareApiFetch(fetchImpl, token, path, init = {}) {
  const response = await fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new CloudflareTunnelError(
      'cloudflare_response_invalid',
      'Cloudflare returned an unreadable response.',
      response.status,
    )
  }
  if (!response.ok || payload?.success === false) {
    const firstError = payload?.errors?.[0] ?? {}
    throw new CloudflareTunnelError(
      String(firstError.code ?? 'cloudflare_request_failed'),
      String(firstError.message ?? 'Cloudflare rejected the request.'),
      response.status,
      payload?.errors ?? null,
    )
  }
  if (!payload || typeof payload !== 'object' || !('result' in payload)) {
    throw new CloudflareTunnelError(
      'cloudflare_response_invalid',
      'Cloudflare returned an unexpected payload.',
      response.status,
    )
  }
  return payload.result
}

export async function listCloudflareAccounts(token, { fetchImpl } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A Cloudflare fetch implementation is required.')
  const result = await cloudflareApiFetch(fetchImpl, token, '/accounts')
  return Array.isArray(result) ? result : []
}

export async function resolveZone(token, domain, { fetchImpl } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A Cloudflare fetch implementation is required.')
  if (typeof domain !== 'string' || !domain.trim()) {
    throw new CloudflareTunnelError('cloudflare_domain_required', 'Enter the Cloudflare domain that will host the phone URL.')
  }
  const result = await cloudflareApiFetch(fetchImpl, token, `/zones?name=${encodeURIComponent(domain.trim())}`)
  const zone = Array.isArray(result) ? result[0] : result
  if (!zone?.id) {
    throw new CloudflareTunnelError(
      'cloudflare_zone_not_found',
      `No Cloudflare zone was found for ${domain.trim()}. Add the domain to Cloudflare first.`,
      404,
    )
  }
  return { id: zone.id, accountId: typeof zone.account?.id === 'string' ? zone.account.id : null }
}

export async function resolveZoneId(token, domain, options) {
  const zone = await resolveZone(token, domain, options)
  return zone.id
}

function tunnelSecret() {
  return randomBytes(32).toString('base64')
}

export function defaultTunnelName({ now = Date.now } = {}) {
  return `ensync-${now().toString(36)}`
}

export async function createCloudflareTunnel(token, accountId, { name = defaultTunnelName(), fetchImpl } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A Cloudflare fetch implementation is required.')
  if (typeof accountId !== 'string' || !accountId) {
    throw new CloudflareTunnelError('cloudflare_account_required', 'A Cloudflare Account ID is required.')
  }
  const result = await cloudflareApiFetch(fetchImpl, token, `/accounts/${encodeURIComponent(accountId)}/tunnels`, {
    method: 'POST',
    body: JSON.stringify({ name, tunnel_secret: tunnelSecret() }),
  })
  if (!result?.id) {
    throw new CloudflareTunnelError('cloudflare_tunnel_create_failed', 'Cloudflare did not return a tunnel id.')
  }
  return result
}

export async function cloudflareTunnelToken(token, accountId, tunnelId, { fetchImpl } = {}) {
  const result = await cloudflareApiFetch(
    fetchImpl,
    token,
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`,
  )
  if (typeof result === 'string' && result) return result
  if (typeof result?.token === 'string' && result.token) return result.token
  throw new CloudflareTunnelError(
    'cloudflare_tunnel_token_missing',
    'Cloudflare did not return a run token for the tunnel.',
  )
}

export async function configureTunnelIngress(
  token,
  accountId,
  tunnelId,
  { hostname, serviceUrl = 'http://127.0.0.1:43122', fetchImpl },
) {
  if (typeof hostname !== 'string' || !hostname.trim()) {
    throw new CloudflareTunnelError('cloudflare_hostname_required', 'Enter the public hostname for the phone URL.')
  }
  await cloudflareApiFetch(
    fetchImpl,
    token,
    `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
    {
      method: 'PUT',
      body: JSON.stringify({
        config: {
          ingress: [
            { hostname: hostname.trim(), service: serviceUrl },
            { service: 'http_status:404' },
          ],
        },
      }),
    },
  )
  return hostname.trim()
}

export async function createTunnelDnsRoute(
  token,
  zoneId,
  { hostname, tunnelId, fetchImpl },
) {
  return cloudflareApiFetch(fetchImpl, token, `/zones/${encodeURIComponent(zoneId)}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'CNAME',
      name: hostname.trim(),
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
    }),
  })
}

/**
 * Create a remotely-managed tunnel end to end. Returns only non-secret identity
 * plus the two secrets the caller must encrypt before persisting.
 */
export async function provisionTunnel(options) {
  const {
    token,
    accountId,
    domain,
    hostname,
    serviceUrl = 'http://127.0.0.1:43122',
    tunnelName,
    fetchImpl,
  } = options
  if (typeof token !== 'string' || !token) {
    throw new CloudflareTunnelError('cloudflare_token_required', 'A Cloudflare API token is required.')
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A Cloudflare fetch implementation is required.')

  const zone = await resolveZone(token, domain, { fetchImpl })
  const resolvedAccountId = accountId || zone.accountId || null
  if (typeof resolvedAccountId !== 'string' || !resolvedAccountId) {
    throw new CloudflareTunnelError('cloudflare_account_required', 'A Cloudflare Account ID is required.')
  }
  const tunnel = await createCloudflareTunnel(token, resolvedAccountId, { name: tunnelName, fetchImpl })
  const runToken = await cloudflareTunnelToken(token, resolvedAccountId, tunnel.id, { fetchImpl })
  const routedHostname = await configureTunnelIngress(token, resolvedAccountId, tunnel.id, {
    hostname,
    serviceUrl,
    fetchImpl,
  })
  await createTunnelDnsRoute(token, zone.id, { hostname: routedHostname, tunnelId: tunnel.id, fetchImpl })

  return {
    tunnelId: tunnel.id,
    hostname: routedHostname,
    runToken,
    accountId: resolvedAccountId,
  }
}

export function cloudflaredRunArgs({ token, noAutoupdate = true } = {}) {
  if (typeof token !== 'string' || !token) {
    throw new CloudflareTunnelError('cloudflared_token_required', 'A tunnel run token is required.')
  }
  const args = ['tunnel']
  if (noAutoupdate) args.push('--no-autoupdate')
  args.push('run', '--token', token)
  return args
}

/**
 * A quick tunnel has no Cloudflare account, token, zone, or DNS step. cloudflared
 * prints a disposable `https://<words>.trycloudflare.com` URL that points the
 * public internet at the local loopback service. It is the zero-config path:
 * the only cost is that the URL changes whenever the connector restarts.
 */
export function cloudflaredQuickRunArgs({ serviceUrl = 'http://127.0.0.1:43122', noAutoupdate = true } = {}) {
  if (typeof serviceUrl !== 'string' || !serviceUrl.trim()) {
    throw new CloudflareTunnelError('cloudflared_service_missing', 'A local loopback service URL is required.')
  }
  const args = ['tunnel']
  if (noAutoupdate) args.push('--no-autoupdate')
  args.push('--url', serviceUrl.trim())
  return args
}

const QUICK_TUNNEL_URL_PATTERN = /\bhttps:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i

/** Extract the quick-tunnel URL from cloudflared's log output, if present. */
export function parseQuickTunnelUrl(output) {
  if (typeof output !== 'string') return null
  const match = output.match(QUICK_TUNNEL_URL_PATTERN)
  return match ? match[0] : null
}

export function startCloudflared({ binaryPath, token, spawnImpl = spawn, env = process.env }) {
  if (typeof spawnImpl !== 'function') throw new TypeError('A spawn implementation is required.')
  if (typeof binaryPath !== 'string' || !binaryPath) {
    throw new CloudflareTunnelError('cloudflared_missing', 'cloudflared is not installed.')
  }
  const child = spawnImpl(binaryPath, cloudflaredRunArgs({ token }), {
    env: { ...env, NO_COLOR: '1' },
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref?.()
  return child
}

/**
 * Start the no-account quick tunnel. Unlike the named run, stdout is captured so
 * the caller can parse the printed trycloudflare.com URL. `onOutput` is optional
 * and receives the raw stream text as it arrives.
 */
export function startQuickCloudflared({
  binaryPath,
  serviceUrl = 'http://127.0.0.1:43122',
  spawnImpl = spawn,
  env = process.env,
  onOutput = () => {},
} = {}) {
  if (typeof spawnImpl !== 'function') throw new TypeError('A spawn implementation is required.')
  if (typeof binaryPath !== 'string' || !binaryPath) {
    throw new CloudflareTunnelError('cloudflared_missing', 'cloudflared is not installed.')
  }
  const child = spawnImpl(binaryPath, cloudflaredQuickRunArgs({ serviceUrl }), {
    env: { ...env, NO_COLOR: '1' },
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  for (const stream of [child.stdout, child.stderr]) {
    if (stream && typeof stream.on === 'function') {
      stream.setEncoding?.('utf8')
      stream.on('data', (chunk) => {
        if (typeof onOutput === 'function') onOutput(chunk.toString())
      })
    }
  }
  child.unref?.()
  return child
}

export function stopCloudflared(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill()
}

export function processIsAlive(pid, killImpl = (candidate) => {
  try {
    process.kill(candidate, 0)
    return true
  } catch {
    return false
  }
}) {
  if (!Number.isInteger(pid) || pid < 1) return false
  if (pid === process.pid) return true
  try {
    return killImpl(pid)
  } catch {
    return false
  }
}

export function publicTunnelUrl(hostname) {
  if (typeof hostname !== 'string' || !hostname.trim()) return null
  return `https://${hostname.trim()}`
}

/** Normalize a persisted tunnel record without trusting arbitrary file input. */
export function normalizeTunnelState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const hostname = typeof value.hostname === 'string' ? value.hostname.trim() : ''
  const tunnelId = typeof value.tunnelId === 'string' ? value.tunnelId : ''
  const accountId = typeof value.accountId === 'string' ? value.accountId : ''
  if (!hostname || !tunnelId) return null
  return Object.freeze({
    hostname,
    tunnelId,
    accountId,
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : null,
  })
}
