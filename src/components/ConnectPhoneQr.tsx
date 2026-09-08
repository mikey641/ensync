import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/**
 * Renders the desktop-generated connect link as a scannable QR code. The link
 * points at the phone PWA with `?sync=<Sync URL>` so scanning it fills the
 * Sync URL field on the phone, leaving only the account username and password.
 */
export function ConnectPhoneQr({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 384,
      color: { dark: '#101310', light: '#ffffff' },
    })
      .then((value) => {
        if (!cancelled) setDataUrl(value)
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [url])

  if (!dataUrl) return null
  return (
    <img
      className="account-sync-qr"
      src={dataUrl}
      width={128}
      height={128}
      alt="Scan to open Ensync on your phone with the Sync URL already filled in"
    />
  )
}
