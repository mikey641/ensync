import { useEffect, useState } from 'react'
import { CheckCircle2, CloudDownload, ExternalLink, RotateCw, ShieldCheck, XCircle } from 'lucide-react'
import {
  applyNativeUpdate,
  browserUpdateSnapshot,
  canApplyUpdate,
  canCancelUpdateDownload,
  canChangeUpdateSettings,
  canCheckForUpdates,
  canDownloadUpdate,
  cancelNativeUpdateDownload,
  checkForNativeUpdates,
  DisablementReason,
  downloadNativeUpdate,
  getNativeUpdateState,
  isUpdateBusy,
  setNativeUpdateChannel,
  setNativeUpdateMode,
  StateType,
  subscribeToNativeUpdateState,
  updateMessage,
  updateProgress,
  updateStatusLabel,
  UPDATE_MODES,
  type NativeUpdateSnapshot,
  type UpdateChannel,
  type UpdateMode,
} from '../lib/nativeUpdates.mjs'

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return null
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

/** The status pill has three looks; the update state machine has twelve members. */
function statusTone(snapshot: NativeUpdateSnapshot) {
  const state = snapshot.state
  if (state.type === StateType.Idle && state.error) return 'error'
  if (state.type === StateType.Idle && state.notAvailable) return 'positive'
  return state.type === StateType.AvailableForDownload
    || state.type === StateType.Downloaded
    || state.type === StateType.Ready
    ? 'positive'
    : 'neutral'
}

export function NativeUpdatePreferences({ className = '' }: { className?: string }) {
  const [snapshot, setSnapshot] = useState<NativeUpdateSnapshot>(browserUpdateSnapshot)

  useEffect(() => {
    let mounted = true
    const unsubscribe = subscribeToNativeUpdateState((next) => {
      if (mounted) setSnapshot(next)
    })
    void getNativeUpdateState().then((next) => {
      if (mounted) setSnapshot(next)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const run = async (operation: () => Promise<NativeUpdateSnapshot>) => setSnapshot(await operation())
  const progress = updateProgress(snapshot)
  const transferred = progress ? formatBytes(progress.transferred) : null
  const total = progress?.total === null || progress?.total === undefined ? null : formatBytes(progress.total)
  const busy = isUpdateBusy(snapshot)
  const tone = statusTone(snapshot)
  const settingsLocked = !canChangeUpdateSettings(snapshot)
  const storeManaged = snapshot.state.type === StateType.Disabled && snapshot.state.reason === DisablementReason.StoreManaged

  return (
    <section className={`setting-section native-update-setting ${className}`.trim()}>
      <div className="setting-title">
        <div>
          <h3>Ensync updates</h3>
          <p>
            Installed version <strong>{snapshot.installedVersion ?? 'Browser or unverified build'}</strong>
            {snapshot.installedBuildId && <> · build <strong>{snapshot.installedBuildId}</strong></>}
          </p>
        </div>
        <span className={`native-update-status native-update-status--${tone}`}>
          {busy ? <RotateCw className="spin" size={13} /> : tone === 'error' ? <XCircle size={13} /> : <CheckCircle2 size={13} />}
          {updateStatusLabel(snapshot)}
        </span>
      </div>

      <div className="native-update-card">
        <label className="native-update-channel">
          <span>Update mode</span>
          <select
            value={snapshot.mode}
            disabled={settingsLocked}
            onChange={(event) => void run(() => setNativeUpdateMode(event.target.value as UpdateMode))}
          >
            {UPDATE_MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>{mode.label}</option>
            ))}
          </select>
          <small>{UPDATE_MODES.find((mode) => mode.value === snapshot.mode)?.description}</small>
        </label>

        <label className="native-update-channel">
          <span>Update channel</span>
          <select
            value={snapshot.channel}
            disabled={settingsLocked}
            onChange={(event) => void run(() => setNativeUpdateChannel(event.target.value as UpdateChannel))}
          >
            <option value="stable">Stable</option>
            <option value="beta">Beta — early fixes</option>
          </select>
          <small>Beta is opt-in and may contain unfinished fixes. Changing channels clears any downloaded installer.</small>
        </label>

        <div className="native-update-copy">
          <CloudDownload size={18} />
          <div>
            <strong>{snapshot.availableVersion ? `Release ${snapshot.availableVersion}` : 'Signed desktop releases'}</strong>
            <p aria-live="polite">{updateMessage(snapshot)}</p>
            {snapshot.checkedAt && <small>Checked {new Date(snapshot.checkedAt).toLocaleString()}</small>}
          </div>
        </div>

        {progress && (
          <div
            className="native-update-progress"
            role="progressbar"
            aria-label={`Downloading Ensync ${snapshot.availableVersion ?? 'update'}`}
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
          <button
            type="button"
            className="button button--ghost"
            disabled={!canCheckForUpdates(snapshot)}
            onClick={() => void run(checkForNativeUpdates)}
          >
            <RotateCw size={14} /> Check for updates
          </button>
          {canDownloadUpdate(snapshot) && (
            <button type="button" className="button button--primary" onClick={() => void run(downloadNativeUpdate)}>
              <CloudDownload size={14} /> Download update
            </button>
          )}
          {canCancelUpdateDownload(snapshot) && (
            <button type="button" className="button button--ghost" onClick={() => void run(cancelNativeUpdateDownload)}>
              Cancel download
            </button>
          )}
          {canApplyUpdate(snapshot) && (
            <button type="button" className="button button--primary" onClick={() => void run(applyNativeUpdate)}>
              <ExternalLink size={14} /> {snapshot.installActionLabel ?? 'Open installer'}
            </button>
          )}
          {snapshot.releaseNotesUrl && (
            <a className="button button--ghost" href={snapshot.releaseNotesUrl} target="_blank" rel="noreferrer">
              Release notes <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>

      <p className="native-update-trust">
        <ShieldCheck size={14} /> {storeManaged
          ? 'Microsoft Store verifies, installs, and updates this Windows package.'
          : 'Checks and downloads happen automatically in the background. Only opening the verified installer is manual; Ensync never silently installs, quits, or restarts.'}
      </p>
    </section>
  )
}
