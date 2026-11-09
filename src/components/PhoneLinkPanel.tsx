import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCw, Smartphone, Unlink } from 'lucide-react'

import { ConnectPhoneQr } from './ConnectPhoneQr'
import { accountSyncHost, type LinkedPhone, type PhoneLink } from '../lib/accountSyncHost'
import {
  cloudflareTunnelAvailable,
  readCloudflareTunnelStatus,
  startCloudflareQuickTunnel,
} from '../lib/cloudflareTunnelHost.mjs'

const REFRESH_BEFORE_EXPIRY_MS = 60_000
const MIN_REFRESH_DELAY_MS = 30_000
const PHONES_POLL_MS = 10_000

/**
 * Publishes this computer's Sync service if needed and returns its public
 * HTTPS address. Outside the desktop shell there is no tunnel bridge, so the
 * Host falls back to its own configured HTTPS service URL (or fails closed).
 */
async function ensurePublicSyncUrl(): Promise<string | null> {
  if (!cloudflareTunnelAvailable()) return null
  const status = await readCloudflareTunnelStatus()
  if (status.quick.running && status.quick.url) return status.quick.url
  if (status.running && status.url) return status.url
  const started = await startCloudflareQuickTunnel()
  if (!started.ok) throw new Error(started.error ?? 'Could not publish phone access. Is this computer online?')
  return started.status?.quick.url ?? started.quick?.url ?? null
}

/**
 * "Connect your phone": one QR that does the whole setup. It regenerates
 * itself before the one-time link expires and lists phones already linked.
 */
export function PhoneLinkPanel({ configured, onLinked }: { configured: boolean; onLinked: () => void }) {
  const [link, setLink] = useState<PhoneLink | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [phones, setPhones] = useState<LinkedPhone[]>([])
  const [revoking, setRevoking] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const onLinkedRef = useRef(onLinked)
  useEffect(() => {
    onLinkedRef.current = onLinked
  }, [onLinked])

  const loadPhones = useCallback(async () => {
    try {
      setPhones((await accountSyncHost.phones()).phones)
    } catch {
      // The list is informative; the QR stays usable without it.
    }
  }, [])

  useEffect(() => {
    if (!configured) return
    let cancelled = false
    let timer: number | null = null
    const create = async () => {
      setLoading(true)
      setError(null)
      try {
        const syncUrl = await ensurePublicSyncUrl()
        const next = await accountSyncHost.phoneLink({ syncUrl })
        if (cancelled) return
        setLink(next)
        onLinkedRef.current()
        void loadPhones()
        const delay = Math.max(MIN_REFRESH_DELAY_MS, Date.parse(next.expiresAt) - Date.now() - REFRESH_BEFORE_EXPIRY_MS)
        timer = window.setTimeout(() => { void create() }, delay)
      } catch (failure) {
        if (cancelled) return
        setLink(null)
        setError(failure instanceof Error ? failure.message : 'Could not prepare the phone link.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void create()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [configured, generation, loadPhones])

  useEffect(() => {
    if (!configured || !link) return
    const timer = window.setInterval(() => { void loadPhones() }, PHONES_POLL_MS)
    return () => window.clearInterval(timer)
  }, [configured, link, loadPhones])

  const disconnect = async (pairingId: string) => {
    setRevoking(pairingId)
    try {
      setPhones((await accountSyncHost.revokePhone(pairingId)).phones)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not disconnect that phone.')
    } finally {
      setRevoking(null)
    }
  }

  if (!configured) return null

  return (
    <div className="account-sync-connect-phone account-sync-connect-phone--link">
      <div className="account-sync-connect-phone__copy">
        <Smartphone size={15} />
        <span>
          <strong>Connect your phone</strong>
          <small>Scan this code with your phone’s camera. That is the whole setup: your projects and conversations appear on the phone, and messages you send there run on this computer.</small>
        </span>
      </div>
      {link ? (
        <>
          <ConnectPhoneQr url={link.url} size={192} alt="Scan to link your phone with Ensync" />
          <small className="account-sync-connect-phone__expiry">
            The code refreshes by itself and works once.{link.persistent ? '' : ' Phone access will stop when Ensync restarts because this computer has no secure credential storage.'}
          </small>
        </>
      ) : loading ? (
        <p className="account-sync-connect-phone__status"><RotateCw className="spin" size={14} /> Preparing your phone link…</p>
      ) : null}
      {error && (
        <div className="account-sync-connect-phone__error" role="alert">
          <p className="account-sync-form__error">{error}</p>
          <button type="button" className="button button--ghost" onClick={() => setGeneration((value) => value + 1)} disabled={loading}><RotateCw size={14} /> Try again</button>
        </div>
      )}
      {phones.length > 0 && (
        <ul className="account-sync-phones" aria-label="Linked phones">
          {phones.map((phone) => (
            <li key={phone.pairingId}>
              <Smartphone size={14} />
              <span>
                <strong>{phone.label}</strong>
                <small>Linked {phone.pairedAt ? new Date(phone.pairedAt).toLocaleString() : ''}{phone.lastSeenAt ? ` · last seen ${new Date(phone.lastSeenAt).toLocaleString()}` : ''}</small>
              </span>
              <button type="button" className="button button--ghost" onClick={() => void disconnect(phone.pairingId)} disabled={revoking !== null}>
                <Unlink size={14} /> {revoking === phone.pairingId ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
