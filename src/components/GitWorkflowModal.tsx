import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Archive,
  Check,
  CircleHelp,
  CloudCog,
  GitBranch,
  GitCommit,
  GitFork,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  UploadCloud,
  X,
} from 'lucide-react'
import {
  ensyncHost,
  EnsyncHostError,
  type GitConnection,
  type GitPushMode,
  type GitStatus,
  type ProjectInspection,
} from '../lib/ensyncHost'
import './GitWorkflowModal.css'

const PRODUCTION_BRANCH_STORAGE = 'ensync-git-production-branches-v1'
const LEGACY_PRODUCTION_BRANCH_STORAGE = 'ensync-git-production-branches-v1'

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
  const [remote, setRemote] = useState('')
  const [connection, setConnection] = useState<GitConnection | null>(null)
  const [pushMode, setPushMode] = useState<GitPushMode>('current_branch')
  const [productionBranch, setProductionBranch] = useState(() => project?.path ? readProductionBranch(project.path) : '')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState<'clone' | 'status' | 'connect' | 'push' | 'init' | 'commit' | 'stash' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeHeading, setNoticeHeading] = useState<string>('Completed')
  const [commitMessage, setCommitMessage] = useState('')

  const reportFailure = (thrown: unknown, fallback: string) => {
    setError(thrown instanceof Error ? thrown.message : fallback)
    setErrorCode(thrown instanceof EnsyncHostError ? thrown.code : null)
  }

  const clearFeedback = () => {
    setError(null)
    setErrorCode(null)
    setNotice(null)
  }

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
    setErrorCode(null)
    try {
      const response = await ensyncHost.gitStatus(project.path)
      setStatus(response.git)
      const nextRemote = response.git.remotes.some((item) => item.name === remote)
        ? remote
        : response.git.preferredRemote ?? response.git.remotes[0]?.name ?? ''
      setRemote(nextRemote)
      setProductionBranch((current) => current || response.git.productionBranch || '')
    } catch (statusError) {
      setStatus(null)
      reportFailure(statusError, 'Ensync Host could not inspect Git status.')
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
    clearFeedback()
    try {
      const response = await ensyncHost.cloneRepository(repositoryUrl.trim(), destinationPath.trim())
      onImported(response.project)
    } catch (cloneError) {
      reportFailure(cloneError, 'Ensync Host could not clone that repository.')
    } finally {
      setBusy(null)
    }
  }

  /**
   * A project outside Git cannot host an isolated agent run, so the panel that
   * reports that offers the repair directly instead of describing it.
   */
  const initializeRepository = async () => {
    if (!project?.path) return
    setBusy('init')
    clearFeedback()
    try {
      const result = await ensyncHost.initializeGitRepository(project.path)
      setNoticeHeading(result.initialized ? 'Repository created' : 'Repository ready')
      setNotice(result.initialized
        ? `Ensync created a Git repository in this project${result.baselineCommitted ? ' and committed its current files as the first commit' : ''}.`
        : 'This project is already inside a Git repository.')
    } catch (initError) {
      reportFailure(initError, 'Ensync Host could not create a repository for this project.')
      setBusy(null)
      return
    }
    setBusy(null)
    await refreshStatus()
  }

  const verifyRemote = async () => {
    if (!project?.path || !remote) return
    setBusy('connect')
    clearFeedback()
    setConnection(null)
    try {
      const response = await ensyncHost.verifyGitRemote(project.path, remote)
      setConnection(response.connection)
      if (!productionBranch && response.connection.defaultBranch) {
        setProductionBranch(response.connection.defaultBranch)
      }
    } catch (connectionError) {
      reportFailure(connectionError, 'Git could not verify that remote.')
    } finally {
      setBusy(null)
    }
  }

  const push = async () => {
    if (!project?.path || !remote) return
    setBusy('push')
    clearFeedback()
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
      reportFailure(pushError, 'Git could not push this branch.')
    } finally {
      setBusy(null)
    }
  }

  const commitAll = async () => {
    if (!project?.path || !commitMessage.trim()) return
    setBusy('commit')
    clearFeedback()
    try {
      const response = await ensyncHost.commitAllChanges(project.path, commitMessage.trim())
      setStatus(response.git)
      setCommitMessage('')
      setNoticeHeading('Changes committed')
      setNotice(`Committed ${status?.changedFiles ?? 'all'} changes on ${response.git.branch ?? 'HEAD'}. You can start an Ensync chat now.`)
    } catch (commitError) {
      reportFailure(commitError, 'Git could not commit the changes.')
    } finally {
      setBusy(null)
    }
  }

  const stashAll = async () => {
    if (!project?.path) return
    setBusy('stash')
    clearFeedback()
    try {
      const response = await ensyncHost.stashAllChanges(project.path)
      setStatus(response.git)
      setNoticeHeading('Changes stashed')
      setNotice(`Stashed ${status?.changedFiles ?? 'all'} changes. Restore them later with \`git stash pop\` in a terminal. You can start an Ensync chat now.`)
    } catch (stashError) {
      reportFailure(stashError, 'Git could not stash the changes.')
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
          <button className={mode === 'clone' ? 'active' : ''} onClick={() => { setMode('clone'); clearFeedback() }}><GitFork size={15} /> Import repository</button>
          <button className={mode === 'manage' ? 'active' : ''} onClick={() => { setMode('manage'); clearFeedback() }} disabled={!project?.path}><GitBranch size={15} /> Focused project</button>
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

                  {status.dirty && status.files.length > 0 && (
                    <div className="git-dirty-panel">
                      <div className="git-section-heading"><AlertTriangle size={20} /><div><strong>{status.changedFiles} uncommitted changes</strong><p>Commit or stash these changes to start an Ensync chat. Ensync never auto-stashes or hides your work.</p></div></div>
                      <div className="git-dirty-files">
                        {status.files.map((file) => (
                          <div key={file.path} className="git-dirty-file">
                            <span className="git-dirty-status" data-status={file.status.trim() || '?'}>{file.status.trim() || '?'}</span>
                            <span className="git-dirty-path">{file.path}</span>
                          </div>
                        ))}
                      </div>
                      <div className="git-dirty-actions">
                        <label>
                          <span>Commit message</span>
                          <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="feat: add new feature" onKeyDown={(event) => { if (event.key === 'Enter' && commitMessage.trim()) void commitAll() }} />
                        </label>
                        <div className="git-dirty-buttons">
                          <button className="button button--primary" onClick={() => void commitAll()} disabled={busy !== null || !commitMessage.trim()}>
                            {busy === 'commit' ? <><LoaderCircle className="spin" size={15} /> Committing…</> : <><GitCommit size={15} /> Commit all</>}
                          </button>
                          <button className="button button--ghost" onClick={() => void stashAll()} disabled={busy !== null}>
                            {busy === 'stash' ? <><LoaderCircle className="spin" size={15} /> Stashing…</> : <><Archive size={15} /> Stash all</>}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

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
              {errorCode === 'not_a_git_repository' && (
                <div className="git-initialize-panel">
                  <div className="git-section-heading">
                    <GitBranch size={20} />
                    <div>
                      <strong>This project is not inside a Git repository</strong>
                      <p>Ensync runs every agent in its own Git worktree, so this folder needs a repository first. Ensync creates it here and records the files already in the folder as the first commit. Nothing is pushed anywhere.</p>
                    </div>
                  </div>
                  <button className="button button--primary" onClick={() => void initializeRepository()} disabled={busy !== null || !project?.path}>
                    {busy === 'init' ? <><LoaderCircle className="spin" size={15} /> Creating repository…</> : <><GitBranch size={15} /> Create Git repository</>}
                  </button>
                </div>
              )}
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
