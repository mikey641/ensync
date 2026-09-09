import { spawn as defaultSpawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  cloudflaredAsset,
  CloudflareTunnelError,
  cloudflaredDownloadUrl,
  parseQuickTunnelUrl,
  processIsAlive,
  provisionTunnel,
  resolveLocalCloudflaredPath,
  startCloudflared,
  startQuickCloudflared,
  stopCloudflared,
} from './cloudflare-tunnel.mjs'

// Owns the lifecycle of the packaged Cloudflare Tunnel: download/install the
// official cloudflared binary, provision a remotely-managed tunnel through the
// Cloudflare API, keep the encrypted credentials in the tunnel store, and
// start/stop the detached connector. Every side effect is injectable so the
// module can be tested without Cloudflare credentials or a live connector.
export class CloudflareTunnelManager {
  constructor(options) {
    const {
      store,
      userDataPath,
      appBinsDir,
      platform = process.platform,
      arch = process.arch,
      env = process.env,
      fetchImpl = globalThis.fetch,
      spawnImpl = defaultSpawn,
      provisionImpl = provisionTunnel,
      isAlive = processIsAlive,
      kill = (pid) => { try { process.kill(pid) } catch { /* already gone */ } },
      log = () => {},
    } = options
    if (!store) throw new TypeError('A Cloudflare Tunnel store is required.')
    if (typeof userDataPath !== 'string' || !userDataPath) {
      throw new TypeError('An app userData path is required for the cloudflared binary.')
    }
    this.store = store
    this.userDataPath = userDataPath
    this.appBinsDir = appBinsDir
    this.binaryPath = resolveLocalCloudflaredPath({ platform, appBinsDir, env })
    this.platform = platform
    this.arch = arch
    this.env = env
    this.fetchImpl = fetchImpl
    this.spawnImpl = spawnImpl
    this.provisionImpl = provisionImpl
    this.isAlive = isAlive
    this.kill = kill
    this.log = log
    this.child = null
    this.pid = this.store.identity()?.pid ?? null
    this.quickChild = null
    this.quickPid = null
    this.quickUrl = null
    this.quickPrefsPath = join(userDataPath, 'ensync-quick-tunnel-v1.json')
    // A previous shell may have left cloudflared running detached with a known
    // URL. Reattach to it so the phone/Mac URL does not rotate on a relaunch.
    const persistedQuick = this.#readQuickState()
    if (persistedQuick.url && persistedQuick.pid && this.isAlive(persistedQuick.pid)) {
      this.quickPid = persistedQuick.pid
      this.quickUrl = persistedQuick.url
    }
  }

  #readQuickState() {
    try {
      const parsed = JSON.parse(readFileSync(this.quickPrefsPath, 'utf8'))
      return {
        enabled: parsed?.enabled === true,
        url: typeof parsed?.url === 'string' && parsed.url ? parsed.url : null,
        pid: Number.isInteger(parsed?.pid) && parsed.pid >= 1 ? parsed.pid : null,
      }
    } catch {
      return { enabled: false, url: null, pid: null }
    }
  }

  #writeQuickState({ enabled, url = null, pid = null }) {
    if (enabled) {
      mkdirSync(dirname(this.quickPrefsPath), { recursive: true })
      writeFileSync(this.quickPrefsPath, JSON.stringify({
        enabled: true,
        url: typeof url === 'string' && url ? url : null,
        pid: Number.isInteger(pid) && pid >= 1 ? pid : null,
      }), { encoding: 'utf8', mode: 0o600 })
    } else {
      try { rmSync(this.quickPrefsPath, { force: true }) } catch { /* nothing persisted */ }
    }
  }

  #recordQuickRunning(pid, url = null) {
    this.quickPid = Number.isInteger(pid) && pid >= 1 ? pid : null
    this.quickUrl = url ?? this.quickUrl
    if (this.quickUrl) this.#writeQuickState({ enabled: true, url: this.quickUrl, pid: this.quickPid })
    return this.quickPid
  }

  quickEnabled() {
    return this.#readQuickState().enabled
  }

  quickRunning() {
    if (this.quickPid !== null && this.isAlive(this.quickPid)) return true
    this.quickPid = null
    this.quickUrl = null
    this.quickChild = null
    return false
  }

  quickStatus() {
    return {
      enabled: this.quickEnabled(),
      running: this.quickRunning(),
      url: this.quickUrl,
      pid: this.quickPid,
    }
  }

  async startQuick({ serviceUrl = 'http://127.0.0.1:43122', grantMs = 20_000 } = {}) {
    if (this.quickRunning()) return { running: true, url: this.quickUrl }
    await this.ensureBinary()
    let output = ''
    let latestUrl = null
    const child = startQuickCloudflared({
      binaryPath: this.binaryPath,
      serviceUrl,
      spawnImpl: this.spawnImpl,
      env: this.env,
      onOutput: (chunk) => {
        output += chunk
        const found = parseQuickTunnelUrl(output)
        if (found) latestUrl = found
      },
    })
    this.quickChild = child
    this.quickPid = child.pid ?? null
    if (latestUrl) this.#recordQuickRunning(child.pid ?? null, latestUrl)
    // Persist the running PID even before the URL is known so a relaunch can
    // reattach to this exact connector instead of publishing a fresh URL.
    this.#writeQuickState({ enabled: true, url: this.quickUrl ?? null, pid: this.quickPid })
    this.log(`starting quick tunnel over ${serviceUrl}`)
    if (this.quickUrl) return { running: true, url: this.quickUrl }

    const url = await new Promise((resolve) => {
      if (typeof child.once !== 'function') {
        resolve(this.quickUrl ?? null)
        return
      }
      const timer = setTimeout(() => resolve(parseQuickTunnelUrl(output)), grantMs)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(parseQuickTunnelUrl(output))
      })
    })
    this.quickUrl = url
    if (url) this.#recordQuickRunning(child.pid ?? null, url)
    if (child.exitCode != null && child.exitCode !== 0 && !url) {
      throw new CloudflareTunnelError('cloudflared_quick_start_failed', 'cloudflared could not publish a quick tunnel.')
    }
    return { running: Boolean(url && this.quickRunning()), url }
  }

  stopQuick({ disable = false } = {}) {
    if (this.quickChild) stopCloudflared(this.quickChild)
    // A reattached child from a previous shell has no Node handle here; signal
    // it directly so the user can still turn phone access off.
    else if (this.quickPid !== null && this.isAlive(this.quickPid)) this.kill(this.quickPid)
    this.quickChild = null
    this.quickPid = null
    this.quickUrl = null
    if (disable) this.#writeQuickState({ enabled: false })
  }

  #recordRunning(pid) {
    this.pid = Number.isInteger(pid) && pid >= 1 ? pid : null
    if (this.pid === null) this.store.setPid(null)
    return this.pid
  }

  running() {
    if (this.pid !== null && this.isAlive(this.pid)) return true
    if (this.pid !== null) this.store.setPid(null)
    this.pid = null
    return false
  }

  binaryInstalled() {
    if (!this.binaryPath) return false
    if (!existsSync(this.binaryPath)) return false
    if (this.platform === 'win32') return true
    try {
      return (statSync(this.binaryPath).mode & 0o111) !== 0
    } catch {
      return false
    }
  }

  status() {
    const identity = this.store.identity()
    return {
      configured: identity !== null,
      hostname: identity?.hostname ?? null,
      url: identity ? `https://${identity.hostname}` : null,
      binaryInstalled: this.binaryInstalled(),
      running: this.running(),
      pid: this.pid,
      quick: this.quickStatus(),
    }
  }

  async ensureBinary() {
    if (this.binaryInstalled()) return this.binaryPath
    if (!this.binaryPath || !this.appBinsDir) {
      throw new CloudflareTunnelError('cloudflared_missing', 'cloudflared cannot be installed on this platform.')
    }
    const asset = cloudflaredAsset({ platform: this.platform, arch: this.arch })
    const url = cloudflaredDownloadUrl(asset)
    this.log(`downloading cloudflared from ${url}`)
    const response = await this.fetchImpl(url, { redirect: 'follow' })
    if (!response || !response.ok) {
      throw new CloudflareTunnelError('cloudflared_download_failed', `cloudflared download failed (${response?.status ?? 'no response'}).`)
    }

    mkdirSync(this.appBinsDir, { recursive: true })
    const binaryPath = this.binaryPath
    const bytes = Buffer.from(await response.arrayBuffer())
    if (asset.extension === '.exe') {
      writeFileSync(binaryPath, bytes)
    } else {
      const tmpRoot = join(this.appBinsDir, '.extract')
      mkdirSync(tmpRoot, { recursive: true })
      const archivePath = join(tmpRoot, asset.archive)
      try {
        writeFileSync(archivePath, bytes)
        await extractTarball(archivePath, tmpRoot, this.platform === 'win32' ? null : this.spawnImpl)
        const extractedBinary = join(tmpRoot, 'cloudflared')
        chmodSync(extractedBinary, 0o755)
        renameSync(extractedBinary, binaryPath)
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true })
      }
    }
    return binaryPath
  }

  async listAccounts(apiToken) {
    const { listCloudflareAccounts } = await import('./cloudflare-tunnel.mjs')
    return listCloudflareAccounts(apiToken, { fetchImpl: this.fetchImpl })
  }

  async setup({ domain, hostname, apiToken, accountId = null, tunnelName = null }) {
    if (typeof apiToken !== 'string' || !apiToken.trim()) {
      throw new CloudflareTunnelError('cloudflare_token_required', 'A Cloudflare API token is required.')
    }
    await this.ensureBinary()
    const provisioned = await this.provisionImpl({
      token: apiToken.trim(),
      domain,
      hostname,
      accountId,
      tunnelName: tunnelName ?? undefined,
      fetchImpl: this.fetchImpl,
    })
    const saved = this.store.save({
      hostname: provisioned.hostname,
      tunnelId: provisioned.tunnelId,
      accountId: provisioned.accountId ?? accountId ?? '',
      apiToken: apiToken.trim(),
      runToken: provisioned.runToken,
      pid: null,
    })
    await this.start()
    return { hostname: saved.hostname, url: `https://${saved.hostname}` }
  }

  async start() {
    const identity = this.store.identity()
    const credentials = this.store.credentials()
    if (!identity || !credentials) return false
    if (this.running()) return true
    if (!this.binaryInstalled()) await this.ensureBinary()
    const child = startCloudflared({
      binaryPath: this.binaryPath,
      token: credentials.runToken,
      spawnImpl: this.spawnImpl,
      env: this.env,
    })
    this.child = child
    this.#recordRunning(child.pid ?? null)
    if (this.pid) this.store.setPid(this.pid)
    return true
  }

  stop() {
    if (this.child) stopCloudflared(this.child)
    this.child = null
    this.#recordRunning(null)
  }

  async clear() {
    this.stop()
    this.store.clear()
  }
}

async function extractTarball(archivePath, targetDir, spawnImpl) {
  if (!spawnImpl) {
    throw new CloudflareTunnelError('cloudflared_extract_failed', 'An unpacking tool is unavailable on this platform.')
  }
  await new Promise((resolveExtract, rejectExtract) => {
    const child = spawnImpl('tar', ['-xzf', archivePath, '-C', targetDir], { shell: false, stdio: 'ignore' })
    child.once('error', rejectExtract)
    child.once('exit', (code) => {
      if (code === 0) resolveExtract()
      else rejectExtract(new CloudflareTunnelError('cloudflared_extract_failed', `cloudflared extraction failed (${code}).`))
    })
  })
}
