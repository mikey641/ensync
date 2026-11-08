// In-app QR scanner: opens the back camera and resolves with the first QR text it reads.
// Uses the native BarcodeDetector where it exists (Android Chrome) and jsQR elsewhere
// (iPhone Safari has no BarcodeDetector).
import jsQR from 'jsqr'

export function cameraAvailable() {
  return Boolean(navigator.mediaDevices?.getUserMedia)
}

export async function scanQr(video, { signal } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  })
  const stop = () => stream.getTracks().forEach((track) => track.stop())
  signal?.addEventListener('abort', stop, { once: true })
  video.srcObject = stream
  video.setAttribute('playsinline', '')
  video.muted = true
  await video.play()

  let detector = null
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats?.()
      if (!formats || formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] })
    } catch { detector = null }
  }
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })

  try {
    while (!signal?.aborted) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
      if (video.readyState < 2 || !video.videoWidth) continue
      if (detector) {
        try {
          const [code] = await detector.detect(video)
          if (code?.rawValue) return code.rawValue
          continue
        } catch { detector = null }
      }
      const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight))
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
      if (code?.data) return code.data
    }
    throw new DOMException('Scan cancelled', 'AbortError')
  } finally {
    stop()
    video.srcObject = null
  }
}

/** Extracts the `link` payload from scanned or pasted text (a full URL or the bare payload). */
export function linkFromText(text) {
  const value = String(text ?? '').trim()
  if (!value) return { kind: 'empty' }
  try {
    const url = new URL(value)
    const raw = new URLSearchParams(url.hash.replace(/^#/, '')).get('link')
    if (raw) return { kind: 'link', raw }
    // Desktop builds before phone sync encoded only `?sync=<url>`.
    if (url.searchParams.get('sync')) return { kind: 'legacy' }
    return { kind: 'other' }
  } catch {
    return /^[A-Za-z0-9_-]{40,}$/.test(value) ? { kind: 'link', raw: value } : { kind: 'other' }
  }
}
