import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  CircleHelp,
  CloudCog,
  GitBranch,
  GitFork,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
  X,
} from 'lucide-react'
import {
  ensyncHost,
  type GitConnection,
  type GitPushMode,
  type GitStatus,
  type GitUnlandedBranch,
  type ProjectInspection,
} from '../lib/relayHost'
import './GitWorkflowModal.css'

const PRODUCTION_BRANCH_STORAGE = 'ensync-git-production-branches-v1'
const LEGACY_PRODUCTION_BRANCH_STORAGE = 'relay-git-production-branches-v1'

type Props = {
  mode: 'clone' | 'manage'
  project: ProjectInspection | null
  onImported: (project: ProjectInspection) => void
  onClose: () => void
}

function readProductionBranch(projectPath: string) {
  try {
    const stored = JSON.parse(
      localStorage.getItem(PRODUCTION_BRANCH_STORAGE)
        ?? localStorage.getItem(LEGACY_PRODUCTION_BRANCH_STORAGE)
        ?? '{}',
    ) as Record<string, string>
    return stored[projectPath] ?? ''
  } catch {
    return ''
  }
}

function storeProductionBranch(projectPath: string, branch: string) {
  try {
    const stored = JSON.parse(
      localStorage.getItem(PRODUCTION_BRANCH_STORAGE)
        ?? localStorage.getItem(LEGACY_PRODUCTION_BRANCH_STORAGE)
        ?? '{}',
    ) as Record<string, string>
    localStorage.setItem(PRODUCTION_BRANCH_STORAGE, JSON.stringify({ ...stored, [projectPath]: branch }))
  } catch {
    // A blocked localStorage write should not block a Git operation.
  }
}

function GitError({ message }: { message: string }) {
  return <div className="git-workflow-error" role="alert"><CircleHelp size={17} /><span>{message}</span></div>
}

export function GitWorkflowModal({ mode: initialMode, project, onImported, onClose }: Props) {
  const [mode, setMode] = useState(initialMode)
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [destinationPath, setDestinationPath] = useState('')
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [unlanded, setUnlanded] = useState<GitUnlandedBranch[]>([])
  const [remote, setRemote] = useState('')
  const [connection, setConnection] = useState<GitConnection | null>(null)
  const [pushMode, setPushMode] = useState<GitPushMode>('current_branch')
  const [productionBranch, setProductionBranch] = useState(() => project?.path ? readProductionBranch(project.path) : '')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState<'clone' | 'status' | 'connect' | 'push' | 'land' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeHeading, setNoticeHeading] = useState<string>('Completed')

  const exactConfirmation = productionBranch ? `PUSH TO ${productionBranch}` : ''
  const selectedRemote = status?.remotes.find((item) => item.name === remote)
  const currentBranchIsProduction = Boolean(status?.branch && status.productionBranch && status.branch === status.productionBranch)
  const canPushCurrent = Boolean(status?.branch && remote && !currentBranchIsProduction)
  const canPushProduction = Boolean(status?.branch && remote)
    && Boolean(productionBranch)
    && confirmation === exactConfirmation

  const refreshStatus = async () => {
    if (!project?.path) return
    setBusy('status')
    setError(null)
    try {
      const response = await ensyncHost.gitStatus(project.path)
      setStatus(response.git)
      const nextRemote = response.git.remotes.some((item) => item.name === remote)
        ? remote
        : response.git.preferredRemote ?? response.git.remotes[0]?.name ?? ''
      setRemote(nextRemote)
      setProductionBranch((current) => current || response.git.productionBranch || '')
      try {
        const unlandedResponse = await ensyncHost.gitUnlanded(project.path)
        setUnlanded(unlandedResponse.unlanded.branches)
      } catch (unlandedError) {
        setUnlanded([])
        setError(unlandedError instanceof Error ? unlandedError.message : 'Ensync Host could not inspect unlanded work.')
      }
    } catch (statusError) {
      setStatus(null)
      setError(statusError instanceof Error ? statusError.message : 'Ensync Host could not inspect Git status.')
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (mode === 'manage' && project?.path) void refreshStatus()
    // Refresh when the modal changes project or enters Git management.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, project?.path])

  const clone = async () => {
    if (!repositoryUrl.trim() || !destinationPath.trim()) return
    setBusy('clone')
    setError(null)
    setNotice(null)
    try {
      const response = await ensyncHost.cloneRepository(repositoryUrl.trim(), destinationPath.trim())
      onImported(response.project)
    } catch (cloneError) {
      setError(cloneError instanceof Error ? cloneError.message : 'Ensync Host could not clone that repository.')
    } finally {
      setBusy(null)
    }
  }

  const verifyRemote = async () => {
    if (!project?.path || !remote) return
    setBusy('connect')
    setError(null)
    setNotice(null)
    setConnection(null)
    try {
      const response = await ensyncHost.verifyGitRemote(project.path, remote)
      setConnection(response.connection)
      if (!productionBranch && response.connection.defaultBranch) {
        setProductionBranch(response.connection.defaultBranch)
      }
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : 'Git could not verify that remote.')
    } finally {
      setBusy(null)
    }
  }

  const push = async () => {
    if (!project?.path || !remote) return
    setBusy('push')
    setError(null)
    setNotice(null)
    try {
      const result = await ensyncHost.pushGit({
        projectPath: project.path,
        remote,
        mode: pushMode,
        ...(pushMode === 'production' ? {
          productionBranch,
          allowProduction: true,
          confirmation,
        } : {}),
      })
      setStatus(result.git)
      if (pushMode === 'production') storeProductionBranch(project.path, productionBranch)
      setConfirmation('')
      setNoticeHeading('Push completed')
      setNotice(`Pushed ${result.push.sourceBranch} to ${result.push.remote}/${result.push.targetBranch}.`)
    } catch (pushError) {
      setError(pushError instanceof Error ? pushError.message : 'Git could not push this branch.')
    } finally {
      setBusy(null)
    }
  }

  const landBranch = async (branch: string) => {
    if (!project) return
    setBusy('land')
    setError(null)
    setNotice(null)
    try {
      const result = await ensyncHost.landGitBranch({ projectPath: project.path, branch })
      setStatus(result.git)
      setNoticeHeading('Landed')
      setNotice(`Landed ${branch} into ${result.land.mergedInto}.`)
      try {
        const refreshed = await ensyncHost.gitUnlanded(project.path)
        setUnlanded(refreshed.unlanded.branches)
      } catch {
        // The land succeeded; a stale unlanded list self-corrects on the next refresh.
      }
    } catch (landError) {
      setError(landError instanceof Error ? landError.message : 'Landing failed.')
    } finally {
      setBusy(null)
    }
  }

  const statusFacts = useMemo(() => status ? [
    { label: 'Branch', value: status.branch ?? 'Detached HEAD' },
    { label: 'Working tree', value: status.dirty ? `${status.changedFiles} changed` : 'Clean' },
    { label: 'Ahead / behind', value: status.ahead === null ? 'No upstream' : `${status.ahead} ahead · ${status.behind} behind` },
    { label: 'Remote', value: remote || 'None configured' },
  ] : [], [remote, status])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal git-workflow-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__header compact">
          <div>
            <span className="eyebrow">GIT WORKFLOWS</span>
            <h2>{mode === 'clone' ? 'Import a Git repository' : 'Connect and push with Git'}</h2>
            <p>Ensync runs the Git installed on this computer and uses its existing credential helper or SSH agent. Ensync does not collect or store a Git service token.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close Git workflows"><X size={19} /></button>
        </div>

        <div className="modal-tabs git-workflow-tabs">
          <button className={mode === 'clone' ? 'active' : ''} onClick={() => { setMode('clone'); setError(null); setNotice(null) }}><GitFork size={15} /> Import repository</button>
          <button className={mode === 'manage' ? 'active' : ''} onClick={() => { setMode('manage'); setError(null); setNotice(null) }} disabled={!project?.path}><GitBranch size={15} /> Focused project</button>
        </div>

        <div className="git-workflow-body">
          {mode === 'clone' ? (
            <section className="git-clone-panel">
              <div className="git-section-heading"><GitFork size={20} /><div><strong>Clone into a new local folder</strong><p>The destination parent must already exist. Ensync refuses an existing folder, relative path, or path outside the host's allowed roots.</p></div></div>
              <div className="git-field-grid">
                <label>
                  <span>Repository URL</span>
                  <input value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repository.git" autoFocus />
                  <small>HTTP(S), SSH, Git protocol, or an absolute local repository path. Credentials embedded in URLs are rejected.</small>
                </label>
                <label>
                  <span>New local destination</span>
                  <input value={destinationPath} onChange={(event) => setDestinationPath(event.target.value)} placeholder="/absolute/path/to/new-project" />
                  <small>Use an absolute macOS or Windows path for a folder that does not exist yet.</small>
                </label>
              </div>
              <div className="git-safety-note"><ShieldCheck size={17} /><span><strong>No shell command is built from these fields.</strong><small>Ensync invokes Git with a fixed executable and separate argument values, then focuses the canonical folder returned by the host.</small></span></div>
              {error && <GitError message={error} />}
            </section>
          ) : (
            <section className="git-manage-panel">
              <div className="git-repository-heading">
                <div><span>FOCUSED PROJECT</span><strong>{project?.name ?? 'No project selected'}</strong><small>{status?.repositoryPath ?? project?.path}</small></div>
                <button className="button button--ghost" onClick={() => void refreshStatus()} disabled={busy !== null || !project?.path}><RefreshCw className={busy === 'status' ? 'spin' : ''} size={15} /> Refresh</button>
              </div>

              {status && (
                <>
                  <div className="git-status-grid">
                    {statusFacts.map((fact) => <div key={fact.label}><small>{fact.label}</small><strong>{fact.value}</strong></div>)}
                  </div>

                  <div className="git-unlanded-panel">
                    <h3 className="git-section-heading">Unlanded agent work</h3>
                    {unlanded.length === 0 ? (
                      <p className="git-unlanded-empty">Every conversation branch is landed.</p>
                    ) : (
                      unlanded.map((entry) => (
                        <div key={entry.branch} className="git-unlanded-row">
                          <div className="git-unlanded-meta">
                            <strong>{entry.branch}</strong>
                            <small>
                              {entry.aheadCount} commit{entry.aheadCount === 1 ? '' : 's'} ahead
                              {' · '}{entry.changedFiles} file{entry.changedFiles === 1 ? '' : 's'}
                              {entry.lastCommittedAt ? ` · ${new Date(entry.lastCommittedAt).toLocaleDateString()}` : ''}
                              {entry.lastSubject ? ` · ${entry.lastSubject}` : ''}
                            </small>
                          </div>
                          <button
                            type="button"
                            className="button button--ghost"
                            disabled={busy !== null}
                            onClick={() => void landBranch(entry.branch)}
                          >
                            {busy === 'land' ? 'Landing…' : 'Land'}
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="git-connection-panel">
                    <div className="git-section-heading"><CloudCog size={20} /><div><strong>Git remote connection</strong><p>Verification contacts the selected remote with non-interactive Git, using only credentials already configured on this computer.</p></div></div>
                    <div className="git-inline-controls">
                      <label><span>Remote</span><select value={remote} onChange={(event) => { setRemote(event.target.value); setConnection(null) }}>{status.remotes.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
                      <button className="button button--ghost" onClick={() => void verifyRemote()} disabled={!remote || busy !== null}>{busy === 'connect' ? <LoaderCircle className="spin" size={15} /> : <CloudCog size={15} />} Verify remote</button>
                    </div>
                    {selectedRemote && <div className="git-remote-urls"><small>Fetch: {selectedRemote.fetchUrls.join(', ') || 'not configured'}</small><small>Push: {selectedRemote.pushUrls.join(', ') || 'not configured'}</small></div>}
                    {connection && <div className="git-success"><Check size={16} /><span><strong>{connection.remote} reached</strong><small>{connection.message}{connection.defaultBranch ? ` Default branch: ${connection.defaultBranch}.` : ''}</small></span></div>}
                  </div>

                  <div className="git-push-panel">
                    <div className="git-section-heading"><UploadCloud size={20} /><div><strong>Push destination</strong><p>The safe default pushes the current branch under its own name. Direct production push targets the branch you confirm below.</p></div></div>
                    <div className="git-push-modes">
                      <button className={pushMode === 'current_branch' ? 'selected' : ''} onClick={() => { setPushMode('current_branch'); setConfirmation('') }}><GitBranch size={17} /><span><strong>Current branch</strong><small>{currentBranchIsProduction ? `Create or switch to a feature branch; ${status.branch} is production` : status.branch ? `${remote}/${status.branch}` : 'Check out a branch first'}</small></span>{pushMode === 'current_branch' && <Check size={15} />}</button>
                      <button className={pushMode === 'production' ? 'selected production' : 'production'} onClick={() => setPushMode('production')}><AlertTriangle size={17} /><span><strong>Direct to production</strong><small>{productionBranch || status.productionBranch || 'Choose the production branch'}</small></span>{pushMode === 'production' && <Check size={15} />}</button>
                    </div>

                    {pushMode === 'production' && (
                      <div className="git-production-confirmation">
                        <div><AlertTriangle size={18} /><p><strong>This pushes the current commit directly to a production branch.</strong><small>It does not deploy by itself, but it may trigger deployment if the remote is configured that way. Non-fast-forward pushes are not forced.</small></p></div>
                        <label><span>Production branch</span><input value={productionBranch} onChange={(event) => { setProductionBranch(event.target.value); setConfirmation('') }} placeholder="main" /></label>
                        <label><span>Type <code>{exactConfirmation || 'PUSH TO branch'}</code> to enable the push</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
                      </div>
                    )}
                  </div>
                </>
              )}

              {busy === 'status' && !status && <div className="git-loading"><LoaderCircle className="spin" size={18} /> Reading real repository state…</div>}
              {notice && <div className="git-success"><Check size={16} /><span><strong>{noticeHeading}</strong><small>{notice}</small></span></div>}
              {error && <GitError message={error} />}
            </section>
          )}
        </div>

        <div className="modal__footer">
          <span className="git-footer-note"><ShieldCheck size={14} /> Real Git state only</span>
          <button className="button button--ghost" onClick={onClose}>Close</button>
          {mode === 'clone' ? (
            <button className="button button--primary" onClick={() => void clone()} disabled={!repositoryUrl.trim() || !destinationPath.trim() || busy !== null}>{busy === 'clone' ? <><LoaderCircle className="spin" size={15} /> Cloning…</> : 'Clone & focus'}</button>
          ) : (
            <button className={`button ${pushMode === 'production' ? 'git-production-button' : 'button--primary'}`} onClick={() => void push()} disabled={busy !== null || (pushMode === 'production' ? !canPushProduction : !canPushCurrent)}>{busy === 'push' ? <><LoaderCircle className="spin" size={15} /> Pushing…</> : pushMode === 'production' ? 'Push to production' : 'Push current branch'}</button>
          )}
        </div>
      </div>
    </div>
  )
}
