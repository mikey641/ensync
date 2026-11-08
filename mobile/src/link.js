// The desktop QR encodes `https://ensync.vercel.app/mobile/#link=<base64url(JSON)>`.
// The fragment never reaches a server; the app reads it once and strips it.

import { base64UrlToBytes } from './crypto.js'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/

export function normalizedServiceUrl(value) {
  const url = new URL(String(value).trim())
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The Sync URL cannot contain credentials, a query, or a fragment.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase()))) {
    throw new Error('Ensync Sync must use HTTPS unless it is running on this device.')
  }
  return url.href.replace(/\/$/, '')
}

/** Returns the raw `link` fragment value, or null when the URL carries none. */
export function linkFragment(hash) {
  const text = String(hash ?? '').replace(/^#/, '')
  if (!text) return null
  const params = new URLSearchParams(text)
  return params.get('link')
}

/** Decodes and validates a link payload; throws a user-facing error when malformed. */
export function parseLinkPayload(value) {
  let payload
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(String(value).trim())))
  } catch {
    throw new Error('This QR link is damaged. Show a fresh QR code on your computer and scan it again.')
  }
  const invalid = () => new Error('This QR link is not an Ensync phone link. Scan the QR in Ensync on your computer.')
  if (!payload || typeof payload !== 'object' || payload.v !== 1) throw invalid()
  const { token, username, key, hostId } = payload
  if (typeof token !== 'string' || token.length < 16 || token.length > 512) throw invalid()
  if (typeof username !== 'string' || !username || username.includes('\n')) throw invalid()
  if (typeof hostId !== 'string' || !HOST_ID_PATTERN.test(hostId)) throw invalid()
  let keyBytes
  try { keyBytes = base64UrlToBytes(key) } catch { throw invalid() }
  if (keyBytes.length !== 32) throw invalid()
  let sync
  try { sync = normalizedServiceUrl(payload.sync) } catch (error) { throw new Error(error.message) }
  return {
    v: 1,
    sync,
    token,
    username,
    key,
    hostId,
    hostLabel: typeof payload.hostLabel === 'string' && payload.hostLabel.trim() ? payload.hostLabel.trim().slice(0, 120) : 'your computer',
  }
}
