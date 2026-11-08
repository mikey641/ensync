import './styles.css'
import { BrokerClient } from './broker-client.js'
import { linkFragment, parseLinkPayload } from './link.js'
import { cameraAvailable, linkFromText, scanQr } from './qr-scanner.js'
import { isQuickTunnel, PhoneSync, TERMINAL_STATES } from './phone-sync.js'
import { renderMarkdown, renderPlain } from './render-markdown.js'
import {
  createChat,
  createUserMessage,
  documentProject,
  listProjects,
  projectChats,
  replyAfter,
  turnRequest,
} from './workspace.js'

const LINK_KEY = 'ensync-phone-link-v1'
const DRAFTS_KEY = 'ensync-phone-drafts-v1'
const DEFAULT_PROVIDERS = [
  { id: 'codex', name: 'Codex', available: true },
  { id: 'claude', name: 'Claude Code', available: true },
]

const app = document.querySelector('#app')
let client = null
let sync = null
let route = { view: 'projects' }
let lastMainSignature = ''
let drafts = loadJson(DRAFTS_KEY) ?? {}

// ---- small helpers ---------------------------------------------------------

function loadJson(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null } catch { return null }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
}
function removeKey(key) {
  try { localStorage.removeItem(key) } catch { /* storage unavailable */ }
}

function h(tag, attributes = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'class') node.className = value
    else if (value === true) node.setAttribute(key, '')
    else node.setAttribute(key, value)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const ICONS = {
  back: '<path d="M15 5l-7 7 7 7" />',
  send: '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" />',
  chevron: '<path d="M9 5l7 7-7 7" />',
  computer: '<rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />',
  folder: '<path d="M3 7.5A2.5 2.5 0 015.5 5H10l2 2.5h6.5A2.5 2.5 0 0121 10v7.5a2.5 2.5 0 01-2.5 2.5h-13A2.5 2.5 0 013 17.5z" />',
  qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z" />',
  more: '<circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />',
}
function icon(name) {
  const span = document.createElement('span')
  span.className = `icon icon-${name}`
  span.setAttribute('aria-hidden', 'true')
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
  return span
}

function relativeTime(ms) {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  const date = new Date(ms)
  if (diff < 86_400_000 && new Date().getDate() === date.getDate()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (diff < 7 * 86_400_000) return date.toLocaleDateString([], { weekday: 'short' })
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function hostLabel() {
  return sync?.host?.label ?? client?.host?.label ?? 'your computer'
}

function hostProviders() {
  const providers = sync?.host?.capabilities?.providers
  return Array.isArray(providers) && providers.length ? providers : DEFAULT_PROVIDERS
}

function providerName(id) {
  return hostProviders().find((provider) => provider.id === id)?.name ?? DEFAULT_PROVIDERS.find((provider) => provider.id === id)?.name ?? id
}

function recentProjects() {
  return sync?.host?.capabilities?.recentProjects ?? []
}

function allProjects() {
  return listProjects(sync.view(), recentProjects())
}

function findProject(projectId) {
  return allProjects().find((project) => project.id === projectId) ?? null
}

// ---- viewport: keyboard + safe areas ----------------------------------------

function syncViewport() {
  const viewport = window.visualViewport
  const root = document.documentElement
  if (!viewport) return
  root.style.setProperty('--vv-height', `${Math.round(viewport.height)}px`)
  root.style.setProperty('--vv-top', `${Math.round(viewport.offsetTop)}px`)
  root.classList.toggle('keyboard-open', window.innerHeight - viewport.height > 120)
}
window.visualViewport?.addEventListener('resize', syncViewport)
window.visualViewport?.addEventListener('scroll', syncViewport)
syncViewport()

// ---- routing (History API) -----------------------------------------------------

function routeUrl(next) {
  const params = new URLSearchParams()
  if (next.view === 'project') params.set('p', next.projectId)
  if (next.view === 'chat') params.set('c', next.chatId)
  if (next.view === 'new') params.set('n', next.projectId)
  const query = params.toString()
  return `${location.pathname}${query ? `?${query}` : ''}`
}

function routeFromUrl() {
  const params = new URLSearchParams(location.search)
  if (params.get('c')) return { view: 'chat', chatId: params.get('c') }
  if (params.get('n')) return { view: 'new', projectId: params.get('n') }
  if (params.get('p')) return { view: 'project', projectId: params.get('p') }
  return { view: 'projects' }
}

function navigate(next, { replace = false } = {}) {
  const depth = (history.state?.depth ?? 0) + (replace ? 0 : 1)
  const state = { ...next, depth }
  if (replace) history.replaceState(state, '', routeUrl(next))
  else history.pushState(state, '', routeUrl(next))
  route = next
  renderShell()
}

function parentRoute() {
  if (route.view === 'chat') {
    const chat = sync?.chat(route.chatId)
    return chat ? { view: 'project', projectId: chat.projectId } : { view: 'projects' }
  }
  if (route.view === 'new') return { view: 'project', projectId: route.projectId }
  return { view: 'projects' }
}

function goBack() {
  if ((history.state?.depth ?? 0) > 0) history.back()
  else navigate(parentRoute(), { replace: true })
}

window.addEventListener('popstate', (event) => {
  route = event.state?.view ? { ...event.state } : routeFromUrl()
  delete route.depth
  renderShell()
})

// ---- link screens ----------------------------------------------------------------

function renderLinkScreen({ title, body, action = null, busy = false, tone = '' } = {}) {
  app.replaceChildren(h('section', { class: `link-screen ${tone}` },
    h('div', { class: 'link-mark' }, busy ? h('span', { class: 'spinner large' }) : icon('qr')),
    h('h1', {}, title ?? 'Scan the QR in Ensync on your computer'),
    h('p', {}, body ?? 'Open Ensync on your computer, go to Settings → Connect your phone, and point your phone’s camera at the code. That’s the whole setup.'),
    action,
  ))
}

function linkActions() {
  const pasteInput = h('input', { type: 'url', placeholder: 'Or paste the link from your computer', 'aria-label': 'Paste link', autocomplete: 'off' })
  const submitPaste = (event) => {
    event.preventDefault()
    void useScannedText(pasteInput.value)
  }
  return h('div', { class: 'link-actions' },
    cameraAvailable()
      ? h('button', { class: 'primary scan-button', onClick: () => void openScanner() }, 'Scan QR code')
      : null,
    h('form', { class: 'paste-link', onSubmit: submitPaste }, pasteInput, h('button', { class: 'secondary' }, 'Connect')),
  )
}

function renderUnlinked(options = {}) {
  renderLinkScreen({
    body: 'On your computer open Ensync → Settings → Connect your phone, then tap Scan and point this phone at the code.',
    ...options,
    action: linkActions(),
  })
}

async function useScannedText(text) {
  const found = linkFromText(text)
  if (found.kind === 'link') return claimFromFragment(found.raw)
  if (found.kind === 'empty') return renderUnlinked()
  renderUnlinked({
    title: found.kind === 'legacy' ? 'Update Ensync on your computer' : 'That isn’t an Ensync phone code',
    body: found.kind === 'legacy'
      ? 'That QR comes from an older Ensync. Update the desktop app, then scan the new code in Settings → Connect your phone.'
      : 'Scan the code in Ensync → Settings → Connect your phone.',
    tone: 'error',
  })
}

async function openScanner() {
  const controller = new AbortController()
  const video = h('video', { class: 'scanner-video', playsinline: '', muted: '' })
  const close = () => controller.abort()
  app.replaceChildren(h('section', { class: 'scanner' },
    video,
    h('div', { class: 'scanner-frame' }),
    h('p', { class: 'scanner-hint' }, 'Point at the QR in Ensync on your computer'),
    h('button', { class: 'secondary scanner-cancel', onClick: close }, 'Cancel'),
  ))
  try {
    const text = await scanQr(video, { signal: controller.signal })
    navigator.vibrate?.(30)
    await useScannedText(text)
  } catch (error) {
    if (error?.name === 'AbortError') return renderUnlinked()
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
    renderUnlinked({
      title: denied ? 'Camera access is off' : 'The camera didn’t start',
      body: denied
        ? 'Allow camera access for this site in your browser settings and try again, or paste the link instead.'
        : `${error?.message ?? ''} You can paste the link instead.`,
      tone: 'error',
    })
  }
}

async function claimFromFragment(raw) {
  let link
  try {
    link = parseLinkPayload(raw)
  } catch (error) {
    renderLinkScreen({ title: 'That QR code didn’t work', body: error.message, tone: 'error', action: linkActions() })
    return
  }
  renderLinkScreen({ title: `Connecting to ${link.hostLabel}…`, body: 'Linking this phone to your computer. This only takes a moment.', busy: true })
  try {
    const claimed = await BrokerClient.claimLink(link)
    sync?.stop()
    removeKey('ensync-phone-outbox-v1')
    useClient(claimed)
    navigate({ view: 'projects' }, { replace: true })
  } catch (error) {
    if (error?.code === 'network_unreachable') {
      renderLinkScreen({
        title: `Can’t reach ${link.hostLabel}`,
        body: 'Make sure Ensync is open on your computer and it is online, then try again.',
        tone: 'error',
        action: h('button', { class: 'primary', onClick: () => void claimFromFragment(raw) }, 'Try again'),
      })
      return
    }
    renderLinkScreen({
      title: 'This QR code expired',
      body: `${error?.message ? `${error.message} ` : ''}Show a fresh QR code in Ensync on your computer and scan it again.`,
      tone: 'error',
      action: linkActions(),
    })
  }
}

function persistClient(current) {
  saveJson(LINK_KEY, current.toJSON())
}

function useClient(next) {
  client = next
  client.onChange = persistClient
  persistClient(client)
  sync = new PhoneSync(client, {
    onChange: () => renderShell(),
    isVisible: () => document.visibilityState === 'visible',
  })
  sync.start()
}

function forgetPhone() {
  sync?.stop()
  const current = client
  client = null
  sync = null
  for (const key of [LINK_KEY, 'ensync-phone-workspace-v1', 'ensync-phone-outbox-v1', DRAFTS_KEY]) removeKey(key)
  drafts = {}
  if (current) void current.request('/v1/broker/devices/revoke', { method: 'POST' }).catch(() => {})
  history.replaceState({ view: 'projects', depth: 0 }, '', location.pathname)
  route = { view: 'projects' }
  renderUnlinked()
}

// ---- shell -----------------------------------------------------------------------------

let shell = null

function buildShell() {
  const header = h('header', { class: 'bar' })
  const banner = h('div', { class: 'banner', hidden: true, role: 'status' })
  const scroller = h('main', { class: 'scroller' })
  const composer = buildComposer()
  const root = h('div', { class: 'shell' }, header, banner, scroller, composer.element)
  app.replaceChildren(root)
  shell = { root, header, banner, scroller, composer }
}

function renderShell() {
  if (!client || !sync) return renderUnlinked()
  if (sync.status.state === 'revoked') {
    renderLinkScreen({
      title: 'This phone was disconnected',
      body: 'It was removed from Ensync on your computer. Scan the QR in Ensync on your computer to connect again.',
      tone: 'error',
      action: h('button', { class: 'secondary', onClick: forgetPhone }, 'Start over'),
    })
    shell = null
    return
  }
  if (!shell || !shell.root.isConnected) buildShell()
  renderBanner()
  renderHeader()
  renderMain()
  updateComposer()
}

function renderBanner() {
  const { banner } = shell
  const status = sync.status
  let content = null
  let tone = ''
  if (status.state === 'offline' && status.failures >= 2) {
    tone = 'warn'
    content = isQuickTunnel(client.baseUrl)
      ? [h('strong', {}, 'Your computer’s address changed: scan the QR again'),
          h('span', {}, `Ensync on ${hostLabel()} restarted or went offline. Scan the QR in Ensync → Settings → Connect your phone. If your computer is only asleep, this clears by itself.`)]
      : [h('strong', {}, `Can’t reach ${hostLabel()}`), h('span', {}, 'Showing your last synced conversations. Retrying…')]
  } else if (status.state === 'error' && status.error) {
    tone = 'error'
    content = [h('strong', {}, 'Sync problem'), h('span', {}, status.error.message)]
  } else if (status.error && status.state === 'live' && status.error.code !== 'network_unreachable') {
    tone = 'error'
    content = [h('span', {}, status.error.message)]
  }
  banner.hidden = !content
  banner.className = `banner ${tone}`
  banner.replaceChildren(...(content ?? []))
}

function statusDot() {
  const state = sync.status.state
  const label = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Offline'
  return h('span', { class: `dot ${state}`, title: label, 'aria-label': label })
}

function renderHeader() {
  const { header } = shell
  const children = []
  if (route.view === 'projects') {
    children.push(
      h('div', { class: 'bar-title' }, h('strong', {}, 'Projects'), h('small', {}, statusDot(), ` ${hostLabel()}`)),
      h('button', { class: 'icon-button', 'aria-label': 'Phone settings', onClick: openSettings }, icon('more')),
    )
  } else {
    let title = ''
    let subtitle = ''
    if (route.view === 'project') {
      const project = findProject(route.projectId)
      title = project?.name ?? 'Project'
      subtitle = project?.path ?? ''
    } else if (route.view === 'new') {
      title = 'New chat'
      subtitle = findProject(route.projectId)?.name ?? ''
    } else {
      const chat = sync.chat(route.chatId)
      title = chat?.title ?? 'Conversation'
      subtitle = chat ? findProject(chat.projectId)?.name ?? '' : ''
    }
    children.push(
      h('button', { class: 'icon-button back', 'aria-label': 'Back', onClick: goBack }, icon('back')),
      h('div', { class: 'bar-title' }, h('strong', { dir: 'auto' }, title), h('small', { dir: 'auto' }, statusDot(), ' ', subtitle)),
    )
    if (route.view === 'project') {
      children.push(h('button', { class: 'icon-button accent', 'aria-label': 'New chat', onClick: () => navigate({ view: 'new', projectId: route.projectId }) }, icon('plus')))
    }
  }
  header.replaceChildren(...children)
}

function mainSignature() {
  const view = sync.view()
  const jobs = sync.jobs.map((job) => `${job.jobId}:${job.state}:${job.events.length}:${job.error ?? ''}:${job.stopping ? 1 : 0}`).join(',')
  return JSON.stringify([route, sync.revision, sync.loaded, sync.ops.length, jobs, view.chats.length, recentProjects().length, sync.host?.label, sync.status.state, sync.status.failures >= 2])
}

function renderMain() {
  const signature = mainSignature()
  if (signature === lastMainSignature) return
  const sameRoute = lastMainSignature && JSON.parse(lastMainSignature)[0] && JSON.stringify(JSON.parse(lastMainSignature)[0]) === JSON.stringify(route)
  lastMainSignature = signature
  const { scroller } = shell
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120
  const previousTop = scroller.scrollTop
  let content
  if (route.view === 'project') content = projectView()
  else if (route.view === 'chat') content = chatView()
  else if (route.view === 'new') content = newChatView()
  else content = projectsView()
  scroller.replaceChildren(content)
  scroller.dataset.view = route.view
  if (route.view === 'chat' || route.view === 'new') {
    if (!sameRoute || nearBottom) scroller.scrollTop = scroller.scrollHeight
    else scroller.scrollTop = previousTop
  } else {
    scroller.scrollTop = sameRoute ? previousTop : 0
  }
}

// ---- views ---------------------------------------------------------------------------

function loadingView(text) {
  return h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', {}, text))
}

function projectsView() {
  if (!sync.loaded && !sync.view().projects.length) {
    if (sync.status.state === 'offline' && sync.status.failures >= 2) {
      return h('div', { class: 'empty' }, icon('computer'), h('p', {}, `Your projects appear here as soon as ${hostLabel()} is reachable.`))
    }
    return loadingView(`Loading your projects from ${hostLabel()}…`)
  }
  const projects = allProjects()
  if (!projects.length) {
    return h('div', { class: 'empty' }, icon('folder'), h('p', {}, 'No projects yet. Open a project in Ensync on your computer and it appears here.'))
  }
  return h('ul', { class: 'list' }, projects.map((project) => h('li', {},
    h('button', { class: 'row', onClick: () => navigate({ view: 'project', projectId: project.id }) },
      h('span', { class: 'row-icon', style: project.color ? `--project-color:${project.color}` : null }, (project.name || '?').trim().charAt(0).toUpperCase()),
      h('span', { class: 'row-text' },
        h('strong', { dir: 'auto' }, project.name),
        h('small', { dir: 'ltr', class: 'path' }, project.path || 'No folder on this computer')),
      h('span', { class: 'row-meta' },
        h('small', {}, project.chatCount ? `${project.chatCount} chat${project.chatCount === 1 ? '' : 's'}` : ''),
        h('small', {}, relativeTime(project.activity))),
      icon('chevron')))))
}

function lastMessagePreview(chat) {
  const last = [...(chat.messages ?? [])].reverse().find((message) => message.content?.trim())
  if (!last) return 'No messages yet'
  const text = last.content
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/^\s*(?:[-+*]|\d+[.)]|#{1,6}|>)\s+/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `${last.role === 'user' ? 'You: ' : ''}${text}`
}

function chatRunning(chatId) {
  return sync.jobsForChat(chatId).some((job) => !TERMINAL_STATES.has(job.state) && job.state !== 'failed')
}

function projectView() {
  const project = findProject(route.projectId)
  if (!project) {
    return sync.loaded ? h('div', { class: 'empty' }, h('p', {}, 'This project is no longer on your computer.')) : loadingView('Loading…')
  }
  const chats = projectChats(sync.view(), project.id)
  const newButton = h('button', { class: 'new-chat', onClick: () => navigate({ view: 'new', projectId: project.id }) }, icon('plus'), 'New chat')
  if (!chats.length) return h('div', {}, newButton, h('div', { class: 'empty small' }, h('p', {}, 'No conversations in this project yet.')))
  return h('div', {}, newButton, h('ul', { class: 'list' }, chats.map((chat) => {
    const activity = Math.max(...(chat.messages ?? []).map((message) => message.createdAt ? Date.parse(message.createdAt) : 0), 0)
    return h('li', {}, h('button', { class: 'row chat-row', onClick: () => navigate({ view: 'chat', chatId: chat.id }) },
      h('span', { class: 'row-text' },
        h('strong', {}, renderPlain(chat.title || 'Conversation')),
        h('small', { class: 'preview' }, renderPlain(lastMessagePreview(chat)))),
      h('span', { class: 'row-meta' },
        chatRunning(chat.id) ? h('span', { class: 'running-pill' }, h('span', { class: 'spinner tiny' }), 'Running') : h('small', {}, providerName(chat.provider)),
        h('small', {}, activity ? relativeTime(activity) : (chat.messages?.at(-1)?.time ?? '')))))
  })))
}

function newChatView() {
  const project = findProject(route.projectId)
  return h('div', { class: 'empty new-chat-hint' },
    h('p', { class: 'eyebrow' }, project?.name ?? ''),
    h('h2', {}, 'What should the agent do?'),
    h('p', {}, `It runs on ${hostLabel()} in ${project?.path ? project.path : 'this project'}, and the conversation appears on your desktop too.`))
}

function messageView(message, pending) {
  const isUser = message.role === 'user'
  const body = isUser ? h('div', { class: 'bubble-text', dir: 'auto' }, renderPlain(message.content)) : renderMarkdown(message.content)
  const meta = [message.time, !isUser && message.provider ? providerName(message.provider) : null, pending ? 'Sending…' : null].filter(Boolean).join(' · ')
  return h('article', { class: `message ${isUser ? 'user' : 'agent'}${pending ? ' pending' : ''}` },
    h('div', { class: 'bubble' }, body),
    meta ? h('small', { class: 'message-meta' }, meta) : null)
}

function outputText(job) {
  return job.events.filter((event) => event.type === 'output' && event.text).map((event) => event.text).join('')
}

function jobView(job, chat) {
  const reply = replyAfter(chat, job.messageId)
  if (reply && job.state === 'completed') return null
  const stateLabel = {
    sending: 'Sending to your computer…',
    queued: `Waiting for ${hostLabel()}…`,
    claimed: `${hostLabel()} picked this up…`,
    running: 'Working…',
  }[job.state]
  if (job.state === 'failed' || job.error) {
    const error = job.error ?? [...job.events].reverse().find((event) => event.type === 'error')?.error ?? 'The agent run failed.'
    return h('div', { class: 'job-card error' },
      h('strong', {}, 'This turn didn’t finish'),
      h('p', { dir: 'auto' }, error),
      h('div', { class: 'job-actions' },
        h('button', { class: 'secondary', onClick: () => sync.retry(job.jobId) }, 'Retry'),
        h('button', { class: 'ghost', onClick: () => sync.dismiss(job.jobId) }, 'Dismiss')))
  }
  if (job.state === 'cancelled' || job.state === 'reconciliation_required') {
    return h('div', { class: 'job-card muted' },
      h('strong', {}, job.state === 'cancelled' ? 'Stopped' : 'Check this turn on your computer'),
      job.state === 'reconciliation_required' ? h('p', {}, 'Ensync couldn’t confirm how this run ended. Open the conversation on your computer to review it.') : null,
      h('div', { class: 'job-actions' }, h('button', { class: 'ghost', onClick: () => sync.dismiss(job.jobId) }, 'Dismiss')))
  }
  if (job.state === 'completed') {
    const completed = [...job.events].reverse().find((event) => event.type === 'completed')
    const response = completed?.result?.response
    return h('article', { class: 'message agent provisional' },
      h('div', { class: 'bubble' }, response ? renderMarkdown(response) : h('p', {}, 'Done.')),
      h('small', { class: 'message-meta' }, h('span', { class: 'spinner tiny' }), ' Saving to your computer…'))
  }
  const output = outputText(job).trimEnd()
  const tail = output.split('\n').slice(-8).join('\n')
  const steers = job.events.filter((event) => event.type === 'steer' || event.type === 'notice')
  return h('div', { class: 'job-card live' },
    h('div', { class: 'job-head' },
      h('span', { class: 'spinner' }),
      h('strong', {}, job.stopping ? 'Stopping…' : stateLabel ?? job.state),
      h('small', {}, providerName(job.request?.provider)),
      job.submitted ? h('button', { class: 'stop', 'aria-label': 'Stop the agent', disabled: job.stopping, onClick: () => void runCommand(job.jobId, 'cancel') }, icon('stop'), 'Stop') : null),
    tail ? h('pre', { class: 'job-output', dir: 'auto' }, tail) : null,
    steers.length ? h('ul', { class: 'job-notes' }, steers.slice(-3).map((event) => h('li', { dir: 'auto' }, event.type === 'steer' ? `↳ ${event.message ?? event.text ?? ''}` : event.message ?? ''))) : null)
}

function chatView() {
  const chat = sync.chat(route.chatId)
  if (!chat) {
    return sync.loaded ? h('div', { class: 'empty' }, h('p', {}, 'This conversation is no longer available.')) : loadingView('Loading…')
  }
  const pending = sync.pendingMessageIds()
  const jobs = sync.jobsForChat(chat.id)
  const jobByMessage = new Map(jobs.map((job) => [job.messageId, job]))
  const items = []
  if (!chat.messages.length) items.push(h('div', { class: 'empty small' }, h('p', {}, 'No messages yet.')))
  chat.messages.forEach((message, index) => {
    items.push(messageView(message, pending.has(message.id)))
    const job = jobByMessage.get(message.id)
    // Show the live run right after its prompt, until the reply lands below it.
    if (job && !chat.messages.slice(index + 1).some((next) => next.role === 'agent')) {
      const card = jobView(job, chat)
      if (card) items.push(card)
    }
  })
  return h('div', { class: 'thread' }, items)
}

// ---- composer --------------------------------------------------------------------------

function buildComposer() {
  const textarea = h('textarea', { rows: 1, dir: 'auto', placeholder: 'Message', enterkeyhint: 'send', 'aria-label': 'Message' })
  const select = h('select', { 'aria-label': 'Agent' })
  const button = h('button', { class: 'send', type: 'submit', 'aria-label': 'Send' }, icon('send'))
  const form = h('form', { class: 'composer' },
    h('div', { class: 'composer-row' }, textarea, button),
    h('div', { class: 'composer-tools' }, h('label', { class: 'agent-picker' }, select)))
  const resize = () => {
    textarea.style.height = 'auto'
    const max = Math.round(window.innerHeight * 0.35)
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`
    textarea.classList.toggle('scrolls', textarea.scrollHeight > max)
  }
  textarea.addEventListener('input', () => {
    resize()
    const key = draftKey()
    if (key) {
      if (textarea.value) drafts[key] = textarea.value
      else delete drafts[key]
      saveJson(DRAFTS_KEY, drafts)
    }
    button.disabled = !textarea.value.trim()
  })
  textarea.addEventListener('focus', () => {
    setTimeout(() => { shell.scroller.scrollTop = shell.scroller.scrollHeight }, 250)
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void submitComposer()
  })
  return { element: form, textarea, select, button, resize, key: null }
}

function draftKey() {
  if (route.view === 'chat') return `chat:${route.chatId}`
  if (route.view === 'new') return `new:${route.projectId}`
  return null
}

function activeJob(chatId) {
  return sync.jobsForChat(chatId).find((job) => job.submitted && !TERMINAL_STATES.has(job.state)) ?? null
}

function updateComposer() {
  const composer = shell.composer
  const visible = route.view === 'chat' || route.view === 'new'
  composer.element.hidden = !visible
  shell.root.classList.toggle('with-composer', visible)
  if (!visible) return
  const key = draftKey()
  if (composer.key !== key) {
    composer.key = key
    composer.textarea.value = drafts[key] ?? ''
    composer.resize()
    composer.provider = null
  }
  const chat = route.view === 'chat' ? sync.chat(route.chatId) : null
  const running = chat ? activeJob(chat.id) : null
  const providers = hostProviders()
  const fallback = providers.find((provider) => provider.available !== false)?.id ?? 'codex'
  const preferred = composer.provider ?? chat?.provider ?? fallback
  const options = providers.map((provider) => h('option', { value: provider.id, disabled: provider.available === false }, provider.available === false ? `${provider.name} (unavailable)` : provider.name))
  if (!providers.some((provider) => provider.id === preferred)) options.unshift(h('option', { value: preferred }, providerName(preferred)))
  const signature = options.map((option) => option.outerHTML).join('')
  if (composer.optionsSignature !== signature) {
    composer.select.replaceChildren(...options)
    composer.optionsSignature = signature
  }
  composer.select.value = preferred
  composer.select.onchange = () => { composer.provider = composer.select.value }
  composer.select.disabled = Boolean(running)
  composer.textarea.placeholder = running ? 'Steer the running agent…' : route.view === 'new' ? 'Describe the task' : 'Message'
  composer.button.setAttribute('aria-label', running ? 'Steer' : 'Send')
  composer.element.classList.toggle('steering', Boolean(running))
  composer.button.disabled = !composer.textarea.value.trim()
}

async function runCommand(jobId, type, payload) {
  try {
    await sync.command(jobId, type, payload)
  } catch (error) {
    sync.status = { ...sync.status, error }
    renderShell()
  }
}

async function submitComposer() {
  const composer = shell.composer
  const prompt = composer.textarea.value.trim()
  if (!prompt) return
  const provider = composer.select.value || 'codex'
  const chatId = route.view === 'chat' ? route.chatId : null
  const running = chatId ? activeJob(chatId) : null
  const clear = () => {
    delete drafts[composer.key]
    saveJson(DRAFTS_KEY, drafts)
    composer.textarea.value = ''
    composer.resize()
    composer.button.disabled = true
  }
  if (running) {
    clear()
    await runCommand(running.jobId, 'steer', { prompt })
    return
  }
  let chat = chatId ? sync.chat(chatId) : null
  const projectId = chat?.projectId ?? route.projectId
  const project = findProject(projectId)
  if (!project?.path) {
    sync.status = { ...sync.status, error: new Error('This project has no folder on your computer, so the agent can’t run here.') }
    renderShell()
    return
  }
  const newProject = project.origin === 'host' ? documentProject(project) : null
  if (!chat) chat = createChat({ projectId: project.id, provider, prompt })
  const message = createUserMessage(prompt, provider)
  const request = turnRequest({ chat, project, provider, prompt, messageId: message.id })
  clear()
  sync.send({ chat, project, newProject, message, request })
  if (route.view === 'new') navigate({ view: 'chat', chatId: chat.id }, { replace: true })
}

// ---- settings sheet ---------------------------------------------------------------------

function openSettings() {
  const dialog = h('dialog', { class: 'sheet' },
    h('form', { method: 'dialog' },
      h('h2', {}, 'This phone'),
      h('dl', {},
        h('dt', {}, 'Computer'), h('dd', {}, hostLabel()),
        h('dt', {}, 'Account'), h('dd', {}, client.username),
        h('dt', {}, 'Sync address'), h('dd', { dir: 'ltr', class: 'path' }, client.baseUrl),
        h('dt', {}, 'Status'), h('dd', {}, sync.status.state === 'live' ? 'Connected, live' : sync.status.state)),
      h('p', { class: 'hint' }, 'To link again or move to a new address, scan the QR in Ensync → Settings → Connect your phone.'),
      h('div', { class: 'sheet-actions' },
        h('button', { class: 'danger', type: 'button', onClick: () => { dialog.close(); forgetPhone() } }, 'Disconnect this phone'),
        h('button', { class: 'secondary', value: 'close' }, 'Close'))))
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
}

// ---- boot ---------------------------------------------------------------------------------

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync?.poke()
})
window.addEventListener('online', () => sync?.poke())
window.addEventListener('hashchange', () => {
  const raw = linkFragment(location.hash)
  if (raw) {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`)
    void claimFromFragment(raw)
  }
})

async function boot() {
  const raw = linkFragment(location.hash)
  if (raw) {
    // The fragment carries a one-time token and the account key: strip it at once.
    history.replaceState({ view: 'projects', depth: 0 }, '', location.pathname)
    await claimFromFragment(raw)
    return
  }
  const saved = loadJson(LINK_KEY)
  if (!saved) return renderUnlinked()
  try {
    useClient(await BrokerClient.restore(saved))
  } catch {
    removeKey(LINK_KEY)
    return renderUnlinked()
  }
  route = routeFromUrl()
  history.replaceState({ ...route, depth: 0 }, '', routeUrl(route))
  renderShell()
}

void boot()
