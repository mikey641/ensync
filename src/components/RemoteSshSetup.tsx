import { useId, useState, type FormEvent } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  Network,
  Server,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react'
import type {
  RemoteSshConnectionInput,
  RemoteSshProbe,
} from '../lib/remoteSsh'
import './RemoteSshSetup.css'

export type RemoteSshSetupProps = {
  probeConnection: (connection: RemoteSshConnectionInput) => Promise<RemoteSshProbe>
  onVerified?: (connection: RemoteSshConnectionInput, probe: RemoteSshProbe) => void
  initialProjectPath?: string
  className?: string
}
function providerIsRunnable(provider: RemoteSshProbe['providers'][number]) {
  if (!['codex', 'claude'].includes(provider.id) || !provider.directlyRunnable) return false
  const method = provider.authentication?.method?.toLowerCase() ?? ''
  return provider.authentication?.state === 'authenticated'
    && (provider.id === 'codex'
      ? method.includes('chatgpt')
      : ['claude.ai', 'oauth', 'subscription'].some((signal) => method.includes(signal)))
}

/**
 * Ephemeral SSH setup form. The component intentionally has no persistence;
 * it accepts no password, token, passphrase, or private-key contents.
 */
export function RemoteSshSetup({
  probeConnection,
  onVerified,
  initialProjectPath = '',
  className = '',
}: RemoteSshSetupProps) {
  const fieldId = useId()
  const [hostname, setHostname] = useState('')
  const [username, setUsername] = useState('')
  const [port, setPort] = useState('22')
  const [identityFile, setIdentityFile] = useState('')
  const [projectPath, setProjectPath] = useState(initialProjectPath)
  const [probe, setProbe] = useState<RemoteSshProbe | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setChecking(true)
    setError(null)
    setProbe(null)
    const connection: RemoteSshConnectionInput = {
      hostname: hostname.trim(),
      username: username.trim(),
      port: Number(port),
      identityFile: identityFile.trim() || null,
      projectPath: projectPath.trim(),
    }
    try {
      const result = await probeConnection(connection)
      setProbe(result)
      onVerified?.(connection, result)
    } catch (probeError) {
      setError(probeError instanceof Error ? probeError.message : 'SSH probe failed.')
    } finally {
      setChecking(false)
    }
  }

  const runnableProviders = probe?.providers.filter(providerIsRunnable) ?? []

  return (
    <section className={`ensync-remote-ssh ${className}`.trim()} aria-labelledby={`${fieldId}-title`}>
      <header className="ensync-remote-ssh__header">
        <span aria-hidden="true"><Server size={20} /></span>
        <div>
          <h3 id={`${fieldId}-title`}>Connect an SSH worker</h3>
          <p>Run Ensync through the coding subscriptions already signed in on another computer.</p>
        </div>
      </header>

      <div className="ensync-remote-ssh__security" role="note">
        <ShieldCheck size={17} aria-hidden="true" />
        <p>
          Uses strict OpenSSH <code>known_hosts</code> verification and key authentication.
          Add the host key with OpenSSH first; Ensync never disables host-key checking.
        </p>
      </div>

      <form onSubmit={submit} className="ensync-remote-ssh__form">
        <div className="ensync-remote-ssh__grid">
          <label>
            <span>Hostname or IP</span>
            <span className="ensync-remote-ssh__input">
              <Network size={16} aria-hidden="true" />
              <input
                id={`${fieldId}-host`}
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                placeholder="worker.example.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                disabled={checking}
              />
            </span>
          </label>
          <label>
            <span>SSH user</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="developer"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              disabled={checking}
            />
          </label>
          <label className="ensync-remote-ssh__port">
            <span>Port</span>
            <input
              type="number"
              min="1"
              max="65535"
              step="1"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              required
              disabled={checking}
            />
          </label>
        </div>

        <label>
          <span>Identity file <small>optional</small></span>
          <span className="ensync-remote-ssh__input">
            <KeyRound size={16} aria-hidden="true" />
            <input
              value={identityFile}
              onChange={(event) => setIdentityFile(event.target.value)}
              placeholder="/Users/you/.ssh/id_ed25519"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={checking}
            />
          </span>
          <small>Leave blank to use ssh-agent or OpenSSH’s default identity files. Key contents are never accepted.</small>
        </label>

        <label>
          <span>Remote project folder</span>
          <span className="ensync-remote-ssh__input">
            <TerminalSquare size={16} aria-hidden="true" />
            <input
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              placeholder="/home/developer/projects/my-app"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              disabled={checking}
            />
          </span>
        </label>

        {error && (
          <div className="ensync-remote-ssh__notice ensync-remote-ssh__notice--error" role="alert">
            <AlertCircle size={17} aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <button type="submit" disabled={checking}>
          {checking && <LoaderCircle className="ensync-remote-ssh__spinner" size={17} aria-hidden="true" />}
          {checking ? 'Verifying SSH worker…' : 'Verify SSH worker'}
        </button>
      </form>

      {probe && (
        <div className="ensync-remote-ssh__result" role="status">
          <div className="ensync-remote-ssh__result-title">
            <CheckCircle2 size={18} aria-hidden="true" />
            <strong>SSH host key and key authentication verified</strong>
          </div>
          {probe.node.available && probe.remote ? (
            <dl>
              <div><dt>Remote</dt><dd>{probe.remote.platform} {probe.remote.release} · {probe.remote.arch}</dd></div>
              <div><dt>Node.js</dt><dd>{probe.node.version}</dd></div>
              <div><dt>Project</dt><dd>{probe.project.canonicalPath}</dd></div>
              <div><dt>Git</dt><dd>{probe.git.version ?? (probe.git.installed ? 'installed, version unavailable' : 'not found')}</dd></div>
              <div>
                <dt>Ready agents</dt>
                <dd>{runnableProviders.length ? runnableProviders.map((provider) => provider.id).join(', ') : 'none'}</dd>
              </div>
            </dl>
          ) : (
            <div className="ensync-remote-ssh__notice ensync-remote-ssh__notice--warning">
              <AlertCircle size={17} aria-hidden="true" />
              <span>{probe.node.reason ?? 'Node.js is required before Ensync can inspect or run this worker.'}</span>
            </div>
          )}
          <p className="ensync-remote-ssh__ephemeral">
            This connection is in memory only. Ensync did not save SSH credentials or key material.
          </p>
        </div>
      )}
    </section>
  )
}
