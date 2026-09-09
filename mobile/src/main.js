import './styles.css'
import { BrokerClient } from './broker-client.js'

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'reconciliation_required'])
const DEFAULT_PROVIDERS = [
  { id: 'codex', name: 'Codex', available: true },
  { id: 'claude', name: 'Claude Code', available: true },
]
const ROLE_LABELS = { agent: 'Agent', you: 'You', system: 'System', error: 'Error' }
const app = document.querySelector('#app')
let client = null
let selectedHost = null
let currentJob = null
let pollTimer = null
let lastSequence = 0
let transcript = []

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character])
}

function serviceUrl() {
  // A shared connect link from desktop Settings (`?sync=<url>`) prefills the
  // field so the phone only needs the account credentials.
  const fromLink = new URLSearchParams(window.location.search).get('sync')?.trim()
  if (fromLink) return fromLink
  return localStorage.getItem('ensync-mobile-sync-url') || ''
}

function loginView(message = '') {
  const existingSyncUrl = serviceUrl()
  const connectHint = existingSyncUrl ? '' : `
      <div class="connect-hint">
        <strong>Where's my Sync URL?</strong>
        <p>It comes from Ensync on your computer. Open <strong>Settings → Account &amp; chat sync → Connect your phone</strong> and the URL below fills in by itself. If that button isn't there, the panel explains how to enable phone sync.</p>
      </div>`
  app.innerHTML = `
    <section class="screen auth-screen">
      <header><span class="mark">E</span><div><strong>Ensync</strong><small>Remote agent workspace</small></div></header>
      <div class="hero"><p>YOUR AGENTS, FROM ANYWHERE</p><h1>Continue work from your phone.</h1><span>Encrypted commands travel through Ensync Sync. Your paired Host runs the subscription CLI inside its protected worktree.</span></div>
      ${connectHint}
      <form id="auth-form" class="card">
        <label>Ensync Sync URL<input name="serviceUrl" type="url" value="${escapeHtml(existingSyncUrl)}" placeholder="https://sync.your-domain.com" required /></label>
        <label>Username or email<input name="username" autocomplete="username" minlength="3" maxlength="254" required /></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" minlength="12" maxlength="256" required /></label>
        ${message ? `<p class="error">${escapeHtml(message)}</p>` : ''}
        <div class="actions"><button name="mode" value="register" class="secondary">Create account</button><button name="mode" value="login">Sign in</button></div>
      </form>
    </section>`
  document.querySelector('#auth-form').addEventListener('submit', authenticate)
}

async function authenticate(event) {
  event.preventDefault()
  const submitter = event.submitter
  const form = new FormData(event.currentTarget)
  const button = submitter instanceof HTMLButtonElement ? submitter : null
  const mode = button?.value === 'register' ? 'register' : 'login'
  button?.setAttribute('disabled', '')
  try {
    const url = String(form.get('serviceUrl'))
    localStorage.setItem('ensync-mobile-sync-url', url)
    client = new BrokerClient(url)
    await client.authenticate(mode, String(form.get('username')), String(form.get('password')))
    await loadWorkspace()
  } catch (error) {
    loginView(error instanceof Error ? error.message : 'Sign in failed.')
  }
}

// The Host advertises its subscription CLIs in `capabilities.providers`. When
// that list is present but empty (or absent altogether), fall back to the
// hardcoded Codex + Claude Code pair so the client still submits.
function hostProviders() {
  const providers = selectedHost?.capabilities?.providers
  return Array.isArray(providers) && providers.length ? providers : DEFAULT_PROVIDERS
}

function providerOptionsHtml() {
  return hostProviders().map((provider) => {
    const unavailable = provider.available === false
    const label = unavailable ? `${provider.name} (unavailable)` : provider.name
    return `<option value="${escapeHtml(provider.id)}"${unavailable ? ' disabled' : ''}>${escapeHtml(label)}</option>`
  }).join('')
}

// Recent projects become a datalist of suggestions while the field stays free
// text. The option's `value` is the path (what submitting sends) and its
// `label` carries an optional project name as a visible hint.
function recentProjectsHtml() {
  const projects = selectedHost?.capabilities?.recentProjects
  if (!Array.isArray(projects) || !projects.length) return ''
  return projects.map((project) => {
    if (!project || typeof project.path !== 'string' || !project.path) return ''
    const hint = project.name ? `${project.name} — ${project.path}` : project.path
    return `<option value="${escapeHtml(project.path)}" label="${escapeHtml(hint)}"></option>`
  }).join('')
}

function hostCapabilitiesSummary() {
  const capabilities = selectedHost?.capabilities
  if (!capabilities || typeof capabilities !== 'object') return ''
  const providers = Array.isArray(capabilities.providers) ? capabilities.providers : []
  const projects = Array.isArray(capabilities.recentProjects) ? capabilities.recentProjects : []
  const parts = []
  if (providers.length) {
    const available = providers.filter((provider) => provider.available !== false).length
    parts.push(`${available}/${providers.length} agents`)
  }
  if (projects.length) parts.push(`${projects.length} recent projects`)
  return parts.join(' · ')
}

async function loadWorkspace(message = '') {
  let hosts = []
  try { hosts = await client.hosts() } catch (error) { message ||= error.message }
  selectedHost = hosts.find((host) => host.id === selectedHost?.id) ?? hosts[0] ?? selectedHost ?? null
  const capsSummary = hostCapabilitiesSummary()
  const datalist = recentProjectsHtml()
  app.innerHTML = `
    <section class="screen workspace-screen">
      <header><span class="mark">E</span><div><strong>Ensync</strong><small>${escapeHtml(client.username)}</small></div><i class="status">E2E</i></header>
      <div class="host-card card">
        <div><span class="device-icon">⌁</span><p><strong>${selectedHost ? escapeHtml(selectedHost.label) : 'Pair an Ensync Host'}</strong><small>${selectedHost ? `Last seen ${formatTime(selectedHost.lastSeenAt)}` : 'Generate a code in desktop Settings, then enter it here.'}</small>${capsSummary ? `<small class="host-caps">${escapeHtml(capsSummary)}</small>` : ''}</p></div>
        <form id="pair-form"><input name="code" inputmode="text" maxlength="8" placeholder="PAIR CODE" aria-label="Host pairing code" /><button>Pair</button></form>
      </div>
      <form id="run-form" class="composer card">
        <label>Project path on Host<input name="projectPath" list="project-recents" placeholder="/Users/you/project or C:\\code\\project" required ${selectedHost ? '' : 'disabled'} />${datalist ? `<datalist id="project-recents">${datalist}</datalist>` : ''}</label>
        <label>Agent<select name="provider" ${selectedHost ? '' : 'disabled'}>${providerOptionsHtml()}</select></label>
        <label class="prompt">Instruction<textarea name="prompt" rows="5" placeholder="What should the agent do?" required ${selectedHost ? '' : 'disabled'}></textarea></label>
        <button ${selectedHost ? '' : 'disabled'}>Run remotely</button>
      </form>
      ${message ? `<p class="notice">${escapeHtml(message)}</p>` : ''}
      <div id="job"></div>
    </section>`
  document.querySelector('#pair-form').addEventListener('submit', claimPairing)
  document.querySelector('#run-form').addEventListener('submit', submitJob)
}

async function claimPairing(event) {
  event.preventDefault()
  const code = String(new FormData(event.currentTarget).get('code')).trim()
  try {
    const pairing = await client.claimPairing(code)
    // The claim response already carries the freshly paired Host (with its
    // capabilities); show it immediately rather than waiting for hosts().
    if (pairing?.host) selectedHost = { ...selectedHost, ...pairing.host }
    await loadWorkspace('Host paired. Remote execution is ready.')
  } catch (error) {
    await loadWorkspace(error instanceof Error ? error.message : 'Pairing failed.')
  }
}

async function submitJob(event) {
  event.preventDefault()
  if (!selectedHost) return
  const form = new FormData(event.currentTarget)
  try {
    currentJob = await client.submit({
      hostId: selectedHost.id,
      provider: String(form.get('provider')),
      projectPath: String(form.get('projectPath')).trim(),
      prompt: String(form.get('prompt')).trim(),
    })
    // The user's instruction opens the conversation; later events append below
    // it. Only held in memory — never persisted.
    transcript = [{ type: 'you', message: String(form.get('prompt')).trim(), at: new Date().toISOString() }]
    lastSequence = 0
    renderJob()
    schedulePoll(0)
  } catch (error) {
    await loadWorkspace(error instanceof Error ? error.message : 'The remote job could not be submitted.')
  }
}

function schedulePoll(delay = 1_000) {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(() => void pollJob(), delay)
}

async function pollJob() {
  if (!currentJob) return
  try {
    const update = await client.job(currentJob.id, lastSequence)
    currentJob = { ...currentJob, ...update }
    if (update.events.length) {
      transcript.push(...update.events)
      lastSequence = Math.max(lastSequence, ...update.events.map((event) => event.sequence))
    }
    renderJob()
    if (!TERMINAL_STATES.has(currentJob.state)) schedulePoll()
  } catch (error) {
    renderJob(error instanceof Error ? error.message : 'Remote status is unavailable.')
    schedulePoll(2_000)
  }
}

function formatTime(value) {
  if (!value) return 'not connected yet'
  return new Date(value).toLocaleString()
}

function formatClock(value) {
  if (!value) return ''
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function eventRole(event) {
  switch (event.type) {
    case 'completed':
    case 'output':
      return 'agent'
    case 'error':
    case 'cancelled':
      return 'error'
    case 'you':
    case 'steer':
      return 'you'
    case 'notice':
    case 'started':
      return 'system'
    default:
      return 'system'
  }
}

function eventDetail(event) {
  if (event.type === 'output' && event.stream === 'stderr') return 'stderr'
  if (event.type === 'error' && event.code) return event.code
  return ''
}

function eventText(event) {
  switch (event.type) {
    case 'completed': return event.result?.response || 'Agent completed.'
    case 'output': return event.text || ''
    case 'error': return event.error || 'Remote execution failed.'
    case 'cancelled': return event.message || 'Remote execution stopped.'
    case 'notice': return event.message || ''
    case 'started': return 'Agent process started.'
    case 'you':
    case 'steer': return event.message || event.text || ''
    default: return event.message || event.text || event.type
  }
}

function transcriptHtml() {
  if (!transcript.length) return '<p class="waiting">Waiting for the paired Host to claim this encrypted job…</p>'
  return transcript.map((event) => {
    const role = eventRole(event)
    const detail = eventDetail(event)
    const text = eventText(event)
    return `
      <div class="message ${escapeHtml(role)} ${escapeHtml(event.type)}">
        <div class="message-meta"><span class="message-role">${ROLE_LABELS[role]}</span>${detail ? `<span class="message-detail">${escapeHtml(detail)}</span>` : ''}<span class="message-time">${formatClock(event.at)}</span></div>
        <div class="message-body${text ? '' : ' empty'}">${text ? escapeHtml(text) : ''}</div>
      </div>`
  }).join('')
}

function renderJob(error = '') {
  const target = document.querySelector('#job')
  if (!target || !currentJob) return
  target.innerHTML = `
    <article class="job-card card">
      <div class="job-heading"><span><strong>Remote run</strong><small>${escapeHtml(currentJob.id)}</small></span><i class="job-state ${escapeHtml(currentJob.state)}">${escapeHtml(currentJob.state)}</i></div>
      <div class="events">${transcriptHtml()}</div>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      ${TERMINAL_STATES.has(currentJob.state) ? '' : `
        <form id="steer-form" class="steer"><input name="prompt" placeholder="Guide the active agent turn" /><button class="secondary">Steer</button><button type="button" id="cancel-job" class="danger">Stop</button></form>`}
    </article>`
  const events = target.querySelector('.events')
  if (events) events.scrollTop = events.scrollHeight
  document.querySelector('#cancel-job')?.addEventListener('click', () => void sendCommand('cancel'))
  document.querySelector('#steer-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    const prompt = String(new FormData(event.currentTarget).get('prompt')).trim()
    if (prompt) void sendCommand('steer', { prompt })
  })
}

async function sendCommand(type, payload = {}) {
  try {
    await client.command(currentJob, type, payload)
    if (type === 'steer' && payload.prompt) {
      // Echo the user's live instruction into the conversation (in memory only).
      transcript.push({ type: 'you', message: payload.prompt, at: new Date().toISOString() })
    }
    renderJob()
    schedulePoll(100)
  } catch (error) {
    renderJob(error instanceof Error ? error.message : 'The remote command was not accepted.')
  }
}

loginView()
