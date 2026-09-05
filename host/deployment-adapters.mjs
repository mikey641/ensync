import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VERCEL_API = 'https://api.vercel.com'
const VERCEL_ISSUER = 'https://vercel.com'
const VERCEL_CLI_CLIENT_ID = 'cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp'
const MAX_FAILURE_LOG = 16_384
const AUTH_EXPIRY_SKEW_SECONDS = 30

function bounded(value, maximum = 4_096) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : null
}

function authCandidates(platform, home, env) {
  const candidates = []
  if (platform === 'darwin') candidates.push(join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'))
  if (platform === 'win32' && env.APPDATA) candidates.push(join(env.APPDATA, 'com.vercel.cli', 'Data', 'auth.json'))
  if (env.XDG_DATA_HOME) candidates.push(join(env.XDG_DATA_HOME, 'com.vercel.cli', 'auth.json'))
  candidates.push(join(home, '.local', 'share', 'com.vercel.cli', 'auth.json'))
  candidates.push(join(home, '.vercel', 'auth.json'))
  return [...new Set(candidates)]
}

async function readJson(path, read = readFile) {
  try {
    return JSON.parse(await read(path, 'utf8'))
  } catch {
    return null
  }
}

function deploymentState(deployment) {
  const state = String(deployment?.readyState ?? deployment?.state ?? '').toUpperCase()
  if (state === 'READY') return 'ready'
  if (['ERROR', 'CANCELED', 'CANCELLED'].includes(state)) return 'failed'
  return 'building'
}

function exactCommit(deployment) {
  const meta = deployment?.meta
  return typeof meta?.githubCommitSha === 'string'
    ? meta.githubCommitSha.toLowerCase()
    : typeof meta?.gitlabCommitSha === 'string'
      ? meta.gitlabCommitSha.toLowerCase()
      : typeof meta?.bitbucketCommitSha === 'string'
        ? meta.bitbucketCommitSha.toLowerCase()
        : null
}

export class VercelDeploymentAdapter {
  constructor(options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.readFile = options.readFile ?? readFile
    this.writeFile = options.writeFile ?? writeFile
    this.home = options.home ?? homedir()
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.apiBase = options.apiBase ?? VERCEL_API
    this.issuer = options.issuer ?? VERCEL_ISSUER
    this.now = options.now ?? Date.now
    this.authRefreshes = new Map()
  }

  async inspect(record) {
    const config = await readJson(join(record.repositoryPath, '.vercel', 'project.json'), this.readFile)
    if (!bounded(config?.projectId, 256)) {
      return { available: false, provider: 'vercel', reason: 'No linked Vercel project was found for this repository.' }
    }
    const credentials = await this.#credentials()
    if (!credentials.length) {
      return { available: false, provider: 'vercel', reason: 'Vercel CLI authentication is unavailable on this Host.' }
    }
    if (typeof this.fetch !== 'function') {
      return { available: false, provider: 'vercel', reason: 'This Host cannot contact the Vercel deployment API.' }
    }
    const query = new URLSearchParams({ projectId: config.projectId, limit: '20' })
    if (config.orgId) query.set('teamId', config.orgId)
    let payload
    let auth
    try {
      const authorized = await this.#authorizedFetch(`${this.apiBase}/v6/deployments?${query}`, credentials)
      const { response } = authorized
      auth = authorized.token
      if (!response) throw new Error('Vercel CLI authentication was rejected after automatic refresh.')
      if (!response.ok) throw new Error(`Vercel deployment lookup returned HTTP ${response.status}.`)
      payload = await response.json()
    } catch (error) {
      return {
        available: false,
        provider: 'vercel',
        reason: bounded(error instanceof Error ? error.message : String(error)) ?? 'Vercel deployment lookup failed.',
      }
    }
    const sha = String(record.productionCommitSha ?? '').toLowerCase()
    const deployment = (Array.isArray(payload?.deployments) ? payload.deployments : [])
      .find((candidate) => candidate?.target === 'production' && exactCommit(candidate) === sha)
    if (!deployment) return { available: true, provider: 'vercel', state: 'missing' }
    const result = {
      available: true,
      provider: 'vercel',
      state: deploymentState(deployment),
      deploymentId: bounded(deployment.uid ?? deployment.id, 256),
      deploymentUrl: bounded(deployment.url, 2_048)
        ? /^https?:\/\//i.test(deployment.url) ? deployment.url : `https://${deployment.url}`
        : null,
      deploymentDashboardUrl: bounded(deployment.inspectorUrl, 2_048),
      failureCode: bounded(deployment.errorCode, 256),
      failureMessage: bounded(deployment.errorMessage, 4_096),
    }
    if (result.state === 'failed' && result.deploymentId) {
      result.failureLog = await this.#failureLog(result.deploymentId, config.orgId, auth)
    }
    return result
  }

  async #credentials() {
    const credentials = []
    if (bounded(this.env.VERCEL_TOKEN, 8_192)) {
      credentials.push({ token: this.env.VERCEL_TOKEN.trim(), path: null, payload: null })
    }
    for (const path of authCandidates(this.platform, this.home, this.env)) {
      const payload = await readJson(path, this.readFile)
      if (bounded(payload?.token, 8_192)) credentials.push({ token: payload.token.trim(), path, payload })
    }
    return credentials
  }

  async #authorizedFetch(url, credentials) {
    let lastResponse = null
    for (const original of credentials) {
      let credential = original
      let refreshed = false
      if (this.#expired(credential.payload) && bounded(credential.payload?.refreshToken, 8_192)) {
        credential = await this.#refresh(credential) ?? credential
        refreshed = credential !== original
      }
      let response = await this.fetch(url, {
        headers: { Authorization: `Bearer ${credential.token}` },
      })
      if ([401, 403].includes(response.status) && !refreshed && bounded(credential.payload?.refreshToken, 8_192)) {
        const replacement = await this.#refresh(credential)
        if (replacement) {
          credential = replacement
          response = await this.fetch(url, {
            headers: { Authorization: `Bearer ${credential.token}` },
          })
        }
      }
      if (![401, 403].includes(response.status)) return { response, token: credential.token }
      lastResponse = response
    }
    return { response: lastResponse, token: null }
  }

  #expired(payload) {
    return typeof payload?.expiresAt === 'number'
      && payload.expiresAt < Math.floor(this.now() / 1_000) + AUTH_EXPIRY_SKEW_SECONDS
  }

  async #refresh(credential) {
    if (!credential.path || !bounded(credential.payload?.refreshToken, 8_192)) return null
    const active = this.authRefreshes.get(credential.path)
    if (active) return active
    const refresh = this.#performRefresh(credential)
    this.authRefreshes.set(credential.path, refresh)
    try {
      return await refresh
    } finally {
      if (this.authRefreshes.get(credential.path) === refresh) this.authRefreshes.delete(credential.path)
    }
  }

  async #performRefresh(credential) {
    try {
      const discovery = await this.fetch(`${this.issuer}/.well-known/openid-configuration`, {
        headers: { 'Content-Type': 'application/json' },
      })
      if (!discovery.ok) return null
      const metadata = await discovery.json()
      if (!bounded(metadata?.token_endpoint, 2_048)) return null
      const response = await this.fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: VERCEL_CLI_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: credential.payload.refreshToken,
        }),
      })
      if (!response.ok) return null
      const tokens = await response.json()
      if (!bounded(tokens?.access_token, 8_192) || typeof tokens?.expires_in !== 'number') return null
      const payload = {
        ...credential.payload,
        token: tokens.access_token.trim(),
        expiresAt: Math.floor(this.now() / 1_000) + tokens.expires_in,
        refreshToken: bounded(tokens.refresh_token, 8_192)
          ? tokens.refresh_token.trim()
          : credential.payload.refreshToken,
      }
      await this.writeFile(credential.path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      return { token: payload.token, path: credential.path, payload }
    } catch {
      return null
    }
  }

  async #failureLog(deploymentId, orgId, token) {
    const query = new URLSearchParams({ direction: 'backward', follow: '0', limit: '100' })
    if (orgId) query.set('teamId', orgId)
    try {
      const response = await this.fetch(`${this.apiBase}/v3/deployments/${encodeURIComponent(deploymentId)}/events?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) return null
      const events = await response.json()
      return (Array.isArray(events) ? events : [])
        .map((event) => bounded(event?.text, 2_048))
        .filter(Boolean)
        .reverse()
        .join('\n')
        .slice(-MAX_FAILURE_LOG) || null
    } catch {
      return null
    }
  }
}
