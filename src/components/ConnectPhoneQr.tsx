import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/**
 * Renders a desktop-generated link (phone link, authenticator URI) as a
 * scannable QR code.
 */
export function ConnectPhoneQr({ url, size = 128, alt = 'Scan with your phone' }: { url: string; size?: number; alt?: string }) {
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
      width={size}
      height={size}
      alt={alt}
    />
  )
}
