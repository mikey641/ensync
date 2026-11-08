// End-to-end encryption shared with Ensync Host.
//
// Workspace documents mirror `encryptWorkspace`/`decryptWorkspace` in
// host/account-sync.mjs (AES-256-GCM, AAD `ensync-account-workspace-v1\n<username>`),
// and broker envelopes mirror `encryptBrokerPayload`/`decryptBrokerPayload`.
// The 32-byte account key arrives in the desktop QR link, so the phone never
// needs the account password.

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function bytesToBase64Url(bytes) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function base64UrlToBytes(value) {
  const text = String(value)
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Invalid base64url value.')
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export async function importAccountKey(base64UrlKey) {
  const bytes = base64UrlToBytes(base64UrlKey)
  if (bytes.length !== 32) throw new Error('The account key must be 32 bytes.')
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function requestHash(value) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(JSON.stringify(value)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function seal(payload, key, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: aad, tagLength: 128,
  }, key, textEncoder.encode(JSON.stringify(payload))))
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(sealed.subarray(0, -16)),
    tag: bytesToBase64Url(sealed.subarray(-16)),
  }
}

async function open(document, key, aad) {
  if (!document || document.version !== 1 || document.algorithm !== 'aes-256-gcm') {
    throw new Error('invalid encrypted document')
  }
  const iv = base64UrlToBytes(document.iv)
  const ciphertext = base64UrlToBytes(document.ciphertext)
  const tag = base64UrlToBytes(document.tag)
  if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid encrypted document sizes')
  const sealed = new Uint8Array(ciphertext.length + tag.length)
  sealed.set(ciphertext)
  sealed.set(tag, ciphertext.length)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, sealed)
  return JSON.parse(textDecoder.decode(plaintext))
}

function workspaceAad(username) {
  return textEncoder.encode(`ensync-account-workspace-v1\n${username}`)
}

export function encryptWorkspace(state, key, username) {
  return seal(state, key, workspaceAad(username))
}

export async function decryptWorkspace(document, key, username) {
  let state
  try {
    state = await open(document, key, workspaceAad(username))
  } catch {
    const error = new Error('This phone could not decrypt your synchronized conversations. Scan the QR on your computer again.')
    error.code = 'sync_decryption_failed'
    throw error
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    const error = new Error('The synchronized conversation document is invalid.')
    error.code = 'sync_document_invalid'
    throw error
  }
  return state
}

export function brokerAad({ username, hostId, clientId, jobId, kind, messageId }) {
  const values = [username, hostId, clientId, jobId, kind, String(messageId)]
  if (values.some((value) => !value || value.includes('\n'))) throw new Error('The broker encryption context is invalid.')
  return textEncoder.encode(['ensync-broker-v1', ...values].join('\n'))
}

export function encryptBroker(payload, key, context) {
  return seal(payload, key, brokerAad(context))
}

export async function decryptBroker(document, key, context) {
  try {
    return await open(document, key, brokerAad(context))
  } catch {
    throw new Error('A remote execution message failed end-to-end authentication.')
  }
}
