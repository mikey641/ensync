import './styles.css'
import { BrokerClient } from './broker-client.js'

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'reconciliation_required'])
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
  return localStorage.getItem('ensync-mobile-sync-url') || 'https://sync.example.com'
}

function loginView(message = '') {
  app.innerHTML = `
    <section class="screen auth-screen">
      <header><span class="mark">E</span><div><strong>Ensync</strong><small>Remote agent workspace</small></div></header>
      <div class="hero"><p>YOUR AGENTS, FROM ANYWHERE</p><h1>Continue work from your phone.</h1><span>Encrypted commands travel through Ensync Sync. Your paired Host runs the subscription CLI inside its protected worktree.</span></div>
      <form id="auth-form" class="card">
        <label>Ensync Sync URL<input name="serviceUrl" type="url" value="${escapeHtml(serviceUrl())}" required /></label>
        <label>Username<input name="username" autocomplete="username" minlength="3" maxlength="32" required /></label>
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

async function loadWorkspace(message = '') {
  let hosts = []
  try { hosts = await client.hosts() } catch (error) { message ||= error.message }
  selectedHost = hosts.find((host) => host.id === selectedHost?.id) ?? hosts[0] ?? null
  app.innerHTML = `
    <section class="screen workspace-screen">
      <header><span class="mark">E</span><div><strong>Ensync</strong><small>${escapeHtml(client.username)}</small></div><i class="status">E2E</i></header>
      <div class="host-card card">
        <div><span class="device-icon">⌁</span><p><strong>${selectedHost ? escapeHtml(selectedHost.label) : 'Pair an Ensync Host'}</strong><small>${selectedHost ? `Last seen ${formatTime(selectedHost.lastSeenAt)}` : 'Generate a code in desktop Settings, then enter it here.'}</small></p></div>
        <form id="pair-form"><input name="code" inputmode="text" maxlength="8" placeholder="PAIR CODE" aria-label="Host pairing code" /><button>Pair</button></form>
      </div>
      <form id="run-form" class="composer card">
        <label>Project path on Host<input name="projectPath" placeholder="/Users/you/project or C:\\code\\project" required ${selectedHost ? '' : 'disabled'} /></label>
        <label>Agent<select name="provider" ${selectedHost ? '' : 'disabled'}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
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
    await client.claimPairing(code)
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
    transcript = []
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

function eventText(event) {
  if (event.type === 'completed') return event.result?.response || 'Agent completed.'
  if (event.type === 'error') return event.error || 'Remote execution failed.'
  if (event.type === 'cancelled') return event.message || 'Remote execution stopped.'
  return event.message || event.text || (event.type === 'started' ? 'Agent process started.' : event.type)
}

function renderJob(error = '') {
  const target = document.querySelector('#job')
  if (!target || !currentJob) return
  target.innerHTML = `
    <article class="job-card card">
      <div class="job-heading"><span><strong>Remote run</strong><small>${escapeHtml(currentJob.id)}</small></span><i class="job-state ${escapeHtml(currentJob.state)}">${escapeHtml(currentJob.state)}</i></div>
      <div class="events">${transcript.map((event) => `<div class="event ${escapeHtml(event.type)}"><small>${escapeHtml(event.type)}</small><p>${escapeHtml(eventText(event))}</p></div>`).join('') || '<p class="waiting">Waiting for the paired Host to claim this encrypted job…</p>'}</div>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      ${TERMINAL_STATES.has(currentJob.state) ? '' : `
        <form id="steer-form" class="steer"><input name="prompt" placeholder="Correct the active Codex turn" /><button class="secondary">Steer</button><button type="button" id="cancel-job" class="danger">Stop</button></form>`}
    </article>`
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
    renderJob()
    schedulePoll(100)
  } catch (error) {
    renderJob(error instanceof Error ? error.message : 'The remote command was not accepted.')
  }
}

loginView()
