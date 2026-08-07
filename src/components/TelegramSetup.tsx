import { useEffect, useId, useState, type FormEvent } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  LogOut,
  Send,
  ServerOff,
  ShieldCheck,
} from 'lucide-react'
import type {
  TelegramBridgeStatus,
  TelegramHostClient,
  TelegramPairingStart,
} from '../telegram-client'
import './TelegramSetup.css'

export const TELEGRAM_BOTFATHER_NEW_BOT_URL = 'https://t.me/BotFather?start=newbot'

export type TelegramHostState =
  | {
      status: 'not-configured'
      message?: string
    }
  | {
      status: 'unavailable'
      message: string
    }
  | {
      status: 'available'
      hostLabel?: string
      /** Only set this when the host has confirmed encrypted secret storage. */
      encryptedCredentialStorage?: boolean
    }

/**
 * Data returned by a real Ensync Host after it has verified the bot and paired
 * the Telegram chat. A local button click is never treated as confirmation.
 */
export type TelegramPairingConfirmation = {
  connectionId: string
  confirmedAt: string
  hostLabel?: string
  telegramAccount?: string
}

export type TelegramSetupProps = {
  host: TelegramHostState
  botToken: string
  onBotTokenChange: (token: string) => void
  /** Supply only the loopback Ensync Host client, never a direct Bot API client. */
  client?: TelegramHostClient
  onOpenHostSetup?: () => void
  onPaired?: (confirmation: TelegramPairingConfirmation) => void
  className?: string
}

function confirmationFromStatus(
  status: Extract<TelegramBridgeStatus, { state: 'connected' }>,
  hostLabel?: string,
): TelegramPairingConfirmation {
  return {
    connectionId: status.connectionId,
    confirmedAt: status.confirmedAt,
    hostLabel,
    telegramAccount: status.telegramAccount.username
      ? `@${status.telegramAccount.username}`
      : status.telegramAccount.displayName,
  }
}

/**
 * Telegram setup UI with no simulated connection or test-message state.
 * Pairing remains unavailable until the caller supplies both an available host
 * state and a real loopback Ensync Host client.
 */
export function TelegramSetup({
  host,
  botToken,
  onBotTokenChange,
  client,
  onOpenHostSetup,
  onPaired,
  className = '',
}: TelegramSetupProps) {
  const tokenId = useId()
  const [isPairing, setIsPairing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<TelegramPairingConfirmation | null>(null)
  const [pairing, setPairing] = useState<TelegramPairingStart | null>(null)
  const [status, setStatus] = useState<TelegramBridgeStatus | null>(null)
  const [deliveryText, setDeliveryText] = useState('Ensync Telegram delivery is connected.')
  const [isSending, setIsSending] = useState(false)
  const [deliveryMessage, setDeliveryMessage] = useState<string | null>(null)

  const hostIsAvailable = host.status === 'available' && Boolean(client)
  const canPair = hostIsAvailable && botToken.trim().length > 0 && !isPairing
  const blockedHostMessage = host.status === 'unavailable'
    ? host.message
    : host.status === 'not-configured'
      ? host.message ?? 'Telegram pairing is unavailable until a real Ensync Host Telegram endpoint is connected.'
      : 'Telegram pairing is unavailable because no Ensync Host Telegram client is connected.'
  const confirmationHostLabel = confirmation?.hostLabel
    ?? (host.status === 'available' ? host.hostLabel : undefined)
    ?? 'Ensync Host'
  const hostLabel = host.status === 'available' ? host.hostLabel : undefined

  useEffect(() => {
    if (!client || host.status !== 'available') return
    let cancelled = false
    void client.getStatus().then((nextStatus) => {
      if (cancelled) return
      setStatus(nextStatus)
      if (nextStatus.state === 'connected') {
        setConfirmation(confirmationFromStatus(nextStatus, hostLabel))
      }
    }).catch((statusError: unknown) => {
      if (!cancelled) {
        setError(statusError instanceof Error ? statusError.message : 'Telegram status check failed.')
      }
    })
    return () => { cancelled = true }
  }, [client, host.status, hostLabel])

  useEffect(() => {
    if (!client || !pairing) return
    let cancelled = false
    const refresh = async () => {
      try {
        const nextStatus = await client.getStatus()
        if (cancelled) return
        setStatus(nextStatus)
        if (nextStatus.state === 'connected') {
          const nextConfirmation = confirmationFromStatus(nextStatus, hostLabel)
          setConfirmation(nextConfirmation)
          setPairing(null)
          onPaired?.(nextConfirmation)
        } else if (nextStatus.state !== 'pairing') {
          setPairing(null)
          setError('The Telegram pairing session expired or was cancelled.')
        }
      } catch (statusError) {
        if (!cancelled) {
          setError(statusError instanceof Error ? statusError.message : 'Telegram status check failed.')
        }
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1_500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [client, hostLabel, onPaired, pairing])

  const pair = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canPair || !client) return

    setIsPairing(true)
    setError(null)
    setConfirmation(null)
    setDeliveryMessage(null)

    try {
      const result = await client.startPairing(botToken.trim())
      setPairing(result)
      onBotTokenChange('')
    } catch (pairingError) {
      setError(pairingError instanceof Error ? pairingError.message : 'Telegram pairing failed.')
    } finally {
      setIsPairing(false)
    }
  }

  const disconnect = async () => {
    if (!client) return
    setError(null)
    try {
      const nextStatus = await client.disconnect()
      setStatus(nextStatus)
      setConfirmation(null)
      setPairing(null)
      setDeliveryMessage('Disconnected. The bot token was forgotten by this host.')
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Telegram disconnect failed.')
    }
  }

  const sendDelivery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!client || !deliveryText.trim() || isSending) return
    setIsSending(true)
    setError(null)
    setDeliveryMessage(null)
    try {
      const result = await client.sendMessage(deliveryText.trim())
      const delivered = result.deliveries.filter((item) => item.messageId !== null).length
      setDeliveryMessage(`Telegram confirmed ${delivered || result.deliveries.length} delivered message${result.deliveries.length === 1 ? '' : 's'}.`)
    } catch (deliveryError) {
      setError(deliveryError instanceof Error ? deliveryError.message : 'Telegram delivery failed.')
    } finally {
      setIsSending(false)
    }
  }

  const updateToken = (token: string) => {
    setError(null)
    setConfirmation(null)
    onBotTokenChange(token)
  }

  return (
    <section className={`relay-telegram-setup ${className}`.trim()} aria-labelledby={`${tokenId}-title`}>
      <header className="relay-telegram-setup__header">
        <span className="relay-telegram-setup__logo" aria-hidden="true"><Send size={19} /></span>
        <div>
          <h3 id={`${tokenId}-title`}>Connect Telegram</h3>
          <p>Use your own bot as a remote client for your configured Ensync Host.</p>
        </div>
      </header>

      <ol className="relay-telegram-setup__steps">
        <li>
          <span aria-hidden="true">1</span>
          <div>
            <strong>Create a bot with BotFather</strong>
            <p>Open Telegram, follow BotFather’s prompts, then copy the bot token.</p>
            <a
              href={TELEGRAM_BOTFATHER_NEW_BOT_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Create a Telegram bot <ExternalLink size={14} aria-hidden="true" />
            </a>
            <small>If BotFather opens without starting the flow, send <code>/newbot</code>.</small>
          </div>
        </li>
        <li>
          <span aria-hidden="true">2</span>
          <div>
            <strong>Return here with the token</strong>
            <p>The token must be sent to a real Ensync Host before a chat can be paired.</p>
          </div>
        </li>
      </ol>

      {host.status !== 'available' || !client ? (
        <div className="relay-telegram-setup__host relay-telegram-setup__host--blocked" role="status">
          <ServerOff size={18} aria-hidden="true" />
          <div>
            <strong>Ensync Host support is not configured</strong>
            <p>{blockedHostMessage}</p>
          </div>
          {onOpenHostSetup && (
            <button type="button" onClick={onOpenHostSetup}>Configure host</button>
          )}
        </div>
      ) : (
        <div className="relay-telegram-setup__host" role="status">
          <ShieldCheck size={18} aria-hidden="true" />
          <div>
            <strong>Ensync Host is available{host.hostLabel ? ` · ${host.hostLabel}` : ''}</strong>
            <p>
              {host.encryptedCredentialStorage
                ? 'This host reports encrypted credential storage.'
                : 'Bot tokens are kept in host memory only and are forgotten on disconnect or restart.'}
            </p>
          </div>
        </div>
      )}

      {pairing && (
        <div className="relay-telegram-setup__pairing" role="status">
          <strong>Pair @{pairing.bot.username} from a private Telegram chat</strong>
          <p>Send this exact command before {new Date(pairing.expiresAt).toLocaleTimeString()}:</p>
          <code>/pair {pairing.code}</code>
          <a href={`https://t.me/${pairing.bot.username}`} target="_blank" rel="noopener noreferrer">
            Open @{pairing.bot.username} <ExternalLink size={14} aria-hidden="true" />
          </a>
        </div>
      )}

      {error && (
        <div className="relay-telegram-setup__notice relay-telegram-setup__notice--error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {!confirmation && status?.state !== 'connected' && (
      <form className="relay-telegram-setup__form" onSubmit={pair}>
        <label htmlFor={tokenId}>Telegram bot token</label>
        <input
          id={tokenId}
          type="password"
          value={botToken}
          onChange={(event) => updateToken(event.target.value)}
          placeholder="Paste the token from BotFather"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={!hostIsAvailable || isPairing}
          aria-describedby={`${tokenId}-help`}
        />
        <small id={`${tokenId}-help`}>
          Ensync does not consider the bot paired until the host confirms it.
        </small>

        <button className="relay-telegram-setup__submit" type="submit" disabled={!canPair}>
          {isPairing && <LoaderCircle className="relay-telegram-setup__spinner" size={16} aria-hidden="true" />}
          {isPairing ? 'Waiting for host…' : 'Pair through Ensync Host'}
        </button>
      </form>
      )}

      {confirmation && (
        <div className="relay-telegram-setup__connected">
          <div className="relay-telegram-setup__notice relay-telegram-setup__notice--success" role="status">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>
              Pairing confirmed by {confirmationHostLabel}
              {confirmation.telegramAccount ? ` for ${confirmation.telegramAccount}` : ''}
              {' · '}{confirmation.connectionId}.
            </span>
          </div>
          <form className="relay-telegram-setup__delivery" onSubmit={sendDelivery}>
            <label htmlFor={`${tokenId}-delivery`}>Send a real delivery check</label>
            <input
              id={`${tokenId}-delivery`}
              value={deliveryText}
              onChange={(event) => setDeliveryText(event.target.value)}
              disabled={isSending}
            />
            <div className="relay-telegram-setup__actions">
              <button type="submit" disabled={isSending || !deliveryText.trim()}>
                <Send size={15} aria-hidden="true" />
                {isSending ? 'Sending…' : 'Send through Telegram'}
              </button>
              <button type="button" onClick={() => void disconnect()}>
                <LogOut size={15} aria-hidden="true" /> Disconnect
              </button>
            </div>
            {deliveryMessage && <small role="status">{deliveryMessage}</small>}
          </form>
        </div>
      )}
    </section>
  )
}
