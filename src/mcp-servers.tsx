import { useCallback, useEffect, useId, useState } from 'react'
import { Check, Pencil, Plus, RotateCw, Server, Trash2, X } from 'lucide-react'
import {
  MCP_SECRET_MASK,
  mcpServersHost,
  type McpProviderSync,
  type McpRegistrySnapshot,
  type McpServer,
  type McpServerInput,
  type McpTransport,
} from './lib/mcpServersHost'
import './mcp-servers.css'

type EditorMode = 'form' | 'json'

type EditorState = {
  serverId: string | null
  mode: EditorMode
  name: string
  transport: McpTransport
  command: string
  args: string
  env: string
  url: string
  headers: string
  json: string
}

const TRANSPORT_LABELS: Record<McpTransport, string> = {
  stdio: 'Local command (stdio)',
  http: 'Remote (streamable HTTP)',
  sse: 'Remote (SSE)',
}

function emptyEditor(mode: EditorMode = 'form'): EditorState {
  return { serverId: null, mode, name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '', json: '' }
}

function editorFor(server: McpServer): EditorState {
  return {
    serverId: server.id,
    mode: 'form',
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: server.args.join('\n'),
    env: Object.keys(server.env).map((key) => `${key}=${MCP_SECRET_MASK}`).join('\n'),
    url: server.url ?? '',
    headers: Object.keys(server.headers).map((key) => `${key}: ${MCP_SECRET_MASK}`).join('\n'),
    json: '',
  }
}

function parseLines(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
}

function parsePairs(text: string, separators: string[], label: string) {
  const result: Record<string, string> = {}
  for (const line of parseLines(text)) {
    let index = -1
    for (const separator of separators) {
      const at = line.indexOf(separator)
      if (at > 0 && (index === -1 || at < index)) index = at
    }
    if (index <= 0) throw new Error(`${label} line "${line}" must look like ${separators[0] === '=' ? 'KEY=value' : 'Name: value'}.`)
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (!key) throw new Error(`${label} line "${line}" is missing a name.`)
    result[key] = value
  }
  return result
}

function inputFromEditor(editor: EditorState): McpServerInput {
  const base: McpServerInput = { name: editor.name.trim(), transport: editor.transport }
  if (editor.transport === 'stdio') {
    return { ...base, command: editor.command.trim(), args: parseLines(editor.args), env: parsePairs(editor.env, ['='], 'Environment') }
  }
  return { ...base, url: editor.url.trim(), headers: parsePairs(editor.headers, [':', '='], 'Header') }
}

function serverSummary(server: McpServer) {
  if (server.transport === 'stdio') {
    return [server.command, ...server.args].filter(Boolean).join(' ')
  }
  return server.url ?? ''
}

function serverDetail(server: McpServer) {
  const parts: string[] = []
  const envCount = Object.keys(server.env).length
  const headerCount = Object.keys(server.headers).length
  if (envCount > 0) parts.push(`${envCount} environment ${envCount === 1 ? 'variable' : 'variables'}`)
  if (headerCount > 0) parts.push(`${headerCount} ${headerCount === 1 ? 'header' : 'headers'}`)
  if (!server.enabled) parts.push('disabled · removed from every provider')
  return parts.join(' · ')
}

function stateLabel(provider: McpProviderSync) {
  switch (provider.state) {
    case 'synced':
      return provider.conflicts.length > 0 ? 'partly synced' : 'synced'
    case 'skipped':
      return 'not installed'
    case 'deferred':
      return 'waiting'
    case 'error':
      return 'error'
    case 'unsupported':
      return 'read-only'
    case 'unavailable':
      return 'no mcp'
    default:
      return 'not synced'
  }
}

function stateClass(provider: McpProviderSync) {
  if (provider.state === 'synced') return provider.conflicts.length > 0 ? 'mcp-state--conflict' : 'mcp-state--synced'
  if (provider.state === 'error') return 'mcp-state--error'
  if (provider.state === 'deferred') return 'mcp-state--deferred'
  return ''
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Ensync Host request failed.'
}

export function McpServerSettings({ className = 'setting-section' }: { className?: string }) {
  const formId = useId()
  const [snapshot, setSnapshot] = useState<McpRegistrySnapshot | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [showAllProviders, setShowAllProviders] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await mcpServersHost.list()
      setSnapshot(next)
      setPhase('ready')
      setUnavailableReason(null)
    } catch (loadError) {
      setPhase('unavailable')
      setUnavailableReason(errorMessage(loadError))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = useCallback(async (action: () => Promise<McpRegistrySnapshot>, successNotice: string | null) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = await action()
      setSnapshot(next)
      setPhase('ready')
      if (successNotice) setNotice(successNotice)
      return true
    } catch (actionError) {
      setError(errorMessage(actionError))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const submitEditor = useCallback(async () => {
    if (!editor) return
    if (editor.mode === 'json') {
      const ok = await run(
        () => mcpServersHost.importJson(editor.json),
        'Imported and synced to every supported provider.',
      )
      if (ok) setEditor(null)
      return
    }
    let input: McpServerInput
    try {
      input = inputFromEditor(editor)
    } catch (parseError) {
      setError(errorMessage(parseError))
      return
    }
    const ok = await run(
      () => (editor.serverId ? mcpServersHost.update(editor.serverId, input) : mcpServersHost.add(input)),
      editor.serverId ? `Saved ${input.name} and synced it to every supported provider.` : `Added ${input.name} and synced it to every supported provider.`,
    )
    if (ok) setEditor(null)
  }, [editor, run])

  const servers = snapshot?.servers ?? []
  const providers = snapshot?.providers ?? []
  const visibleProviders = showAllProviders ? providers : providers.filter((provider) => provider.capability === 'supported')
  const hiddenCount = providers.length - visibleProviders.length
  const lastSync = snapshot?.lastSyncAt ? new Date(snapshot.lastSyncAt).toLocaleString() : 'never'

  return (
    <section className={`${className} mcp-setting`}>
      <div className="setting-title">
        <div>
          <h3>MCP servers</h3>
          <p>Add a Model Context Protocol server once. Ensync writes it into the native configuration of every installed provider with a verified MCP format, and keeps them in step when you edit or remove it.</p>
        </div>
        <div>
          <button type="button" className="button button--ghost" onClick={() => void run(() => mcpServersHost.sync(), 'Synced every supported provider.')} disabled={busy || phase !== 'ready'}>
            <RotateCw className={busy ? 'spin' : ''} size={14} /> Sync now
          </button>
          <button type="button" className="button button--primary" onClick={() => { setEditor(emptyEditor()); setError(null); setNotice(null) }} disabled={busy || phase !== 'ready' || editor !== null}>
            <Plus size={14} /> Add server
          </button>
        </div>
      </div>

      {phase === 'loading' && (
        <div className="account-sync-unavailable"><RotateCw className="spin" size={17} /><span><strong>Loading MCP servers</strong><small>Asking the local Ensync Host for its registry.</small></span></div>
      )}
      {phase === 'unavailable' && (
        <div className="account-sync-unavailable"><Server size={18} /><span><strong>Ensync Host is not reachable</strong><small>{unavailableReason ?? 'MCP servers are managed by the local Host.'}</small></span></div>
      )}

      {snapshot && !snapshot.readable && (
        <div className="connection-error" role="alert">The registry file could not be read{snapshot.unreadableReason ? ` (${snapshot.unreadableReason})` : ''}. Fix or remove <code>{snapshot.registryPath}</code> before making changes.</div>
      )}

      {editor && (
        <form className="mcp-form" onSubmit={(event) => { event.preventDefault(); void submitEditor() }}>
          {!editor.serverId && (
            <div className="mcp-form__modes" role="tablist" aria-label="How to add the server">
              <button type="button" role="tab" aria-pressed={editor.mode === 'form'} onClick={() => setEditor({ ...editor, mode: 'form' })}>Fill in details</button>
              <button type="button" role="tab" aria-pressed={editor.mode === 'json'} onClick={() => setEditor({ ...editor, mode: 'json' })}>Paste JSON</button>
            </div>
          )}

          {editor.mode === 'json' ? (
            <>
              <label className="mcp-form__wide">
                <span>MCP server JSON</span>
                <textarea
                  value={editor.json}
                  onChange={(event) => setEditor({ ...editor, json: event.target.value })}
                  rows={7}
                  placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }\n  }\n}'}
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
              <p className="mcp-form__hint">Paste the snippet from a server’s README. The <code>mcpServers</code> wrapper, Claude-style <code>type</code>, and Copilot-style <code>local</code> entries are all understood; every server in it is added.</p>
            </>
          ) : (
            <>
              <label>
                <span>Name</span>
                <input id={`${formId}-name`} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} placeholder="github" maxLength={64} autoComplete="off" disabled={busy} />
              </label>
              <label>
                <span>Transport</span>
                <select value={editor.transport} onChange={(event) => setEditor({ ...editor, transport: event.target.value as McpTransport })} disabled={busy}>
                  {(Object.keys(TRANSPORT_LABELS) as McpTransport[]).map((transport) => (
                    <option key={transport} value={transport}>{TRANSPORT_LABELS[transport]}</option>
                  ))}
                </select>
              </label>
              {editor.transport === 'stdio' ? (
                <>
                  <label className="mcp-form__wide">
                    <span>Command</span>
                    <input value={editor.command} onChange={(event) => setEditor({ ...editor, command: event.target.value })} placeholder="npx" autoComplete="off" spellCheck={false} disabled={busy} />
                  </label>
                  <label>
                    <span>Arguments (one per line)</span>
                    <textarea value={editor.args} onChange={(event) => setEditor({ ...editor, args: event.target.value })} placeholder={'-y\n@modelcontextprotocol/server-github'} spellCheck={false} disabled={busy} />
                  </label>
                  <label>
                    <span>Environment (KEY=value per line)</span>
                    <textarea value={editor.env} onChange={(event) => setEditor({ ...editor, env: event.target.value })} placeholder="GITHUB_TOKEN=ghp_…" spellCheck={false} disabled={busy} />
                  </label>
                </>
              ) : (
                <>
                  <label className="mcp-form__wide">
                    <span>URL</span>
                    <input value={editor.url} onChange={(event) => setEditor({ ...editor, url: event.target.value })} placeholder="https://mcp.example.com/mcp" type="url" autoComplete="off" spellCheck={false} disabled={busy} />
                  </label>
                  <label className="mcp-form__wide">
                    <span>Headers (Name: value per line)</span>
                    <textarea value={editor.headers} onChange={(event) => setEditor({ ...editor, headers: event.target.value })} placeholder="Authorization: Bearer …" spellCheck={false} disabled={busy} />
                  </label>
                </>
              )}
              <p className="mcp-form__hint">Values are stored by Ensync Host on this computer and written into each provider’s own file. Ensync shows them masked afterwards; leave a masked value in place to keep it.</p>
            </>
          )}

          <div className="mcp-form__actions">
            <button type="button" className="button button--ghost" onClick={() => { setEditor(null); setError(null) }} disabled={busy}><X size={14} /> Cancel</button>
            <button type="submit" className="button button--primary" disabled={busy}>
              {busy ? 'Saving…' : editor.mode === 'json' ? 'Import & sync' : editor.serverId ? 'Save & sync' : 'Add & sync'}
            </button>
          </div>
        </form>
      )}

      {phase === 'ready' && servers.length === 0 && !editor && (
        <div className="mcp-empty">No MCP servers yet. Add one here and it becomes available in Claude Code, Codex, and every other installed provider with a verified MCP format.</div>
      )}

      {servers.length > 0 && (
        <div className="mcp-list">
          {servers.map((server) => (
            <div className={`mcp-row ${server.enabled ? '' : 'mcp-row--disabled'}`} key={server.id}>
              <div className="mcp-row__summary">
                <strong>{server.name} <span className="mcp-transport">{server.transport}</span></strong>
                <code title={serverSummary(server)}>{serverSummary(server)}</code>
                {serverDetail(server) && <small>{serverDetail(server)}</small>}
              </div>
              <div className="mcp-row__actions">
                <button
                  className={`toggle ${server.enabled ? 'toggle--on' : ''}`}
                  onClick={() => void run(() => mcpServersHost.setEnabled(server.id, !server.enabled), server.enabled ? `Disabled ${server.name} and removed it from every provider.` : `Enabled ${server.name} and synced it to every supported provider.`)}
                  role="switch"
                  aria-checked={server.enabled}
                  aria-label={`${server.name} enabled`}
                  disabled={busy}
                  type="button"
                >
                  <span />
                </button>
                <button type="button" className="icon-button" aria-label={`Edit ${server.name}`} title="Edit" onClick={() => { setEditor(editorFor(server)); setConfirmRemoveId(null); setError(null); setNotice(null) }} disabled={busy}><Pencil size={13} /></button>
                {confirmRemoveId === server.id ? (
                  <>
                    <button type="button" className="button button--ghost" onClick={() => { setConfirmRemoveId(null); void run(() => mcpServersHost.remove(server.id), `Removed ${server.name} from Ensync and every provider it was synced to.`) }} disabled={busy}><Check size={13} /> Remove</button>
                    <button type="button" className="icon-button" aria-label="Keep server" title="Keep" onClick={() => setConfirmRemoveId(null)} disabled={busy}><X size={13} /></button>
                  </>
                ) : (
                  <button type="button" className="icon-button" aria-label={`Remove ${server.name}`} title="Remove" onClick={() => setConfirmRemoveId(server.id)} disabled={busy}><Trash2 size={13} /></button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <div className="connection-error" role="alert">{error}</div>}
      {notice && !error && <div className="mcp-message" role="status">{notice}</div>}

      {phase === 'ready' && (
        <div className="mcp-sync">
          <div className="mcp-sync__title">
            <h4>Provider sync</h4>
            <small>Last sync {lastSync}{snapshot?.syncPending ? ' · waiting for active agent runs to finish' : ''}</small>
          </div>
          <div className="mcp-sync__list">
            {visibleProviders.map((provider) => (
              <div className="mcp-provider" key={provider.id}>
                <strong>{provider.name}</strong>
                <span className={`mcp-state ${stateClass(provider)}`}>{stateLabel(provider)}</span>
                <div className="mcp-provider__detail">
                  <span>{provider.reason}</span>
                  {provider.configPath && <code>{provider.configPath}</code>}
                </div>
              </div>
            ))}
          </div>
          {hiddenCount > 0 && (
            <button type="button" className="button button--ghost" style={{ marginTop: 8 }} onClick={() => setShowAllProviders(true)}>
              Show {hiddenCount} more {hiddenCount === 1 ? 'provider' : 'providers'} without MCP sync
            </button>
          )}
          {showAllProviders && hiddenCount === 0 && providers.some((provider) => provider.capability !== 'supported') && (
            <button type="button" className="button button--ghost" style={{ marginTop: 8 }} onClick={() => setShowAllProviders(false)}>
              Show only providers with MCP sync
            </button>
          )}
        </div>
      )}
    </section>
  )
}
