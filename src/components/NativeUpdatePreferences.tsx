import { useEffect, useState } from 'react'
import { CheckCircle2, CloudDownload, ExternalLink, RotateCw, ShieldCheck, XCircle } from 'lucide-react'
import {
  browserUpdateState,
  cancelNativeUpdateDownload,
  checkForNativeUpdates,
  downloadNativeUpdate,
  getNativeUpdateState,
  openNativeUpdateInstaller,
  setNativeUpdateChannel,
  subscribeToNativeUpdateState,
  type NativeUpdateState,
} from '../lib/nativeUpdates.mjs'

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return null
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function phaseLabel(state: NativeUpdateState) {
  switch (state.phase) {
    case 'checking': return 'Checking'
    case 'up_to_date': return 'Up to date'
    case 'available': return 'Update available'
    case 'downloading': return 'Downloading'
    case 'downloaded': return 'Ready to open'
    case 'installer_opened': return 'Installer opened'
    case 'error': return 'Update error'
    case 'unavailable': return 'Updates unavailable'
    case 'initializing': return 'Verifying build'
    default: return 'Not checked'
  }
}

export function NativeUpdatePreferences({ className = '' }: { className?: string }) {
  const [state, setState] = useState<NativeUpdateState>(browserUpdateState)

  useEffect(() => {
    let mounted = true
    const unsubscribe = subscribeToNativeUpdateState((next) => {
      if (mounted) setState(next)
    })
    void getNativeUpdateState().then((next) => {
      if (mounted) setState(next)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const run = async (operation: () => Promise<NativeUpdateState>) => setState(await operation())
  const progress = state.progress
  const transferred = progress ? formatBytes(progress.transferred) : null
  const total = progress?.total === null || progress?.total === undefined ? null : formatBytes(progress.total)
  const active = ['checking', 'downloading'].includes(state.phase)

  return (
    <section className={`setting-section native-update-setting ${className}`.trim()}>
      <div className="setting-title">
        <div>
          <h3>Ensync updates</h3>
          <p>
            Installed version <strong>{state.installedVersion ?? 'Browser or unverified build'}</strong>
            {state.installedBuildId && <> · build <strong>{state.installedBuildId}</strong></>}
          </p>
        </div>
        <span className={`native-update-status native-update-status--${state.phase}`}>
          {active ? <RotateCw className="spin" size={13} /> : state.phase === 'error' ? <XCircle size={13} /> : <CheckCircle2 size={13} />}
          {phaseLabel(state)}
        </span>
      </div>

      <div className="native-update-card">
        <label className="native-update-channel">
          <span>Update channel</span>
          <select
            value={state.channel}
            disabled={!state.canChangeChannel}
            onChange={(event) => void run(() => setNativeUpdateChannel(event.target.value as 'stable' | 'beta'))}
          >
            <option value="stable">Stable</option>
            <option value="beta">Beta — early fixes</option>
          </select>
          <small>Beta is opt-in and may contain unfinished fixes. Changing channels clears any downloaded installer.</small>
        </label>

        <div className="native-update-copy">
          <CloudDownload size={18} />
          <div>
            <strong>{state.availableVersion ? `Release ${state.availableVersion}` : 'Signed desktop releases'}</strong>
            <p aria-live="polite">{state.message}</p>
            {state.checkedAt && <small>Checked {new Date(state.checkedAt).toLocaleString()}</small>}
          </div>
        </div>

        {progress && (
          <div
            className="native-update-progress"
            role="progressbar"
            aria-label={`Downloading Ensync ${state.availableVersion ?? 'update'}`}
            aria-valuemin={0}
            aria-valuemax={progress.percent !== null ? 100 : undefined}
            aria-valuenow={progress.percent !== null ? Math.round(progress.percent) : undefined}
            aria-valuetext={progress.percent !== null ? `${Math.round(progress.percent)} percent` : `${transferred ?? 'Unknown size'} downloaded`}
          >
            <div className="native-update-progress__track">
              {progress.percent !== null && <i style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />}
            </div>
            <small>
              {transferred ?? 'Downloaded size unavailable'}
              {total ? ` of ${total}` : ' downloaded · total not reported'}
              {progress.percent !== null ? ` · ${Math.round(progress.percent)}%` : ''}
            </small>
          </div>
        )}

        <div className="native-update-actions">
          <button type="button" className="button button--ghost" disabled={!state.canCheck} onClick={() => void run(checkForNativeUpdates)}>
            <RotateCw size={14} /> Check for updates
          </button>
          {state.canDownload && (
            <button type="button" className="button button--primary" onClick={() => void run(downloadNativeUpdate)}>
              <CloudDownload size={14} /> Download update
            </button>
          )}
          {state.canCancel && (
            <button type="button" className="button button--ghost" onClick={() => void run(cancelNativeUpdateDownload)}>
              Cancel download
            </button>
          )}
          {state.canInstall && (
            <button type="button" className="button button--primary" onClick={() => void run(openNativeUpdateInstaller)}>
              <ExternalLink size={14} /> {state.installActionLabel ?? 'Open installer'}
            </button>
          )}
          {state.releaseNotesUrl && (
            <a className="button button--ghost" href={state.releaseNotesUrl} target="_blank" rel="noreferrer">
              Release notes <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>

      <p className="native-update-trust">
        <ShieldCheck size={14} /> Checks are manual. Download and installer opening are separate actions; Ensync never silently installs, quits, or restarts.
      </p>
    </section>
  )
}
