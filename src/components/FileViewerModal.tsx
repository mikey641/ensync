import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, FileText, X } from 'lucide-react'
import { ensyncHost, EnsyncHostError, type LocalFileDisplay } from '../lib/ensyncHost'
import './FileViewerModal.css'

function readableSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FileViewerModal({ path, onClose }: { path: string; onClose: () => void }) {
  const [file, setFile] = useState<LocalFileDisplay | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let active = true
    setFile(null)
    setLoadError(null)

    void ensyncHost.readLocalFile(path)
      .then((payload) => {
        if (active) setFile(payload.file)
      })
      .catch((error: unknown) => {
        if (!active) return
        setLoadError(error instanceof EnsyncHostError
          ? error.message
          : 'Ensync Host is not reachable, so the file could not be displayed.')
      })

    return () => {
      active = false
    }
  }, [path])

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  const name = file?.name || path.split(/[/\\]/).at(-1) || path
  const openNatively = window.ensyncDesktop?.openLocalFile

  const copy = async () => {
    if (file?.status !== 'ok') return
    try {
      await navigator.clipboard.writeText(file.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal file-viewer-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__header compact">
          <div>
            <span className="eyebrow">FILE ON DISK</span>
            <h2 dir="auto">{name}</h2>
            <p className="file-viewer__path" dir="ltr" title={path}>{path}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close file"><X size={19} /></button>
        </div>

        <div className="file-viewer__body">
          {!file && !loadError && <p className="file-viewer__note">Reading the file…</p>}
          {loadError && <p className="file-viewer__note file-viewer__note--error">{loadError}</p>}
          {file && file.status !== 'ok' && <p className="file-viewer__note file-viewer__note--error">{file.message}</p>}
          {file?.status === 'ok' && (
            <>
              <div className="file-viewer__meta">
                <span><FileText size={13} /> {file.language ?? 'text'}</span>
                <span>{readableSize(file.bytes)}</span>
                {file.truncated && <span className="file-viewer__truncated">Showing the first part of this file</span>}
              </div>
              <pre dir="ltr"><code>{file.text}</code></pre>
            </>
          )}
        </div>

        <div className="modal__footer">
          <button className="button button--ghost" onClick={onClose}>Close</button>
          {file?.status === 'ok' && (
            <button className="button button--ghost" onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy contents'}
            </button>
          )}
          {typeof openNatively === 'function' && (
            <button className="button button--ghost" onClick={() => { void openNatively(path) }}>
              <ExternalLink size={15} /> Open outside Ensync
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
