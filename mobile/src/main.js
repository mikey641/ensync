import './styles.css'
import { BrokerClient } from './broker-client.js'
import { linkFragment, parseLinkPayload } from './link.js'
import { cameraAvailable, decodeQrImage, linkFromText, scanQr } from './qr-scanner.js'
import { isQuickTunnel, PhoneSync, TERMINAL_STATES } from './phone-sync.js'
import { renderMarkdown, renderPlain } from './render-markdown.js'
import {
  canSteer,
  chatIsRunning,
  chatLiveTurn,
  documentProgress,
  jobProgress,
  jobQueued,
  queuedMessageIds,
  runningTarget,
  workingLabel,
} from './live-turn.js'
import { DELIVERY_STEPS, DELIVERY_TARGETS, deliveryDetail, deliveryLabel, deliveryPosition, deliveryTone, latestDelivery } from './delivery.js'
import {
  createChat,
  createUserMessage,
  documentProject,
  listProjects,
  projectChats,
  replyAfter,
  resolveConversationWorkspaceKey,
  turnRequest,
} from './workspace.js'

const LINK_KEY = 'ensync-phone-link-v1'
const DRAFTS_KEY = 'ensync-phone-drafts-v1'
const DELIVERY_TARGET_KEY = 'ensync-phone-delivery-target-v1'
const DELIVERY_REFRESH_MS = 15_000
const DEFAULT_PROVIDERS = [
  { id: 'claude', name: 'Claude Code', available: true },
]

const app = document.querySelector('#app')
let client = null
let sync = null
let route = { view: 'projects' }
let lastMainSignature = ''
let drafts = loadJson(DRAFTS_KEY) ?? {}
let deliveryTarget = loadJson(DELIVERY_TARGET_KEY) === 'protected_branch' ? 'protected_branch' : 'production'
// Delivery status per chat, read from the Host on demand: { at, delivery, error }.
const deliveryByChat = new Map()
let controlBusy = null

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
  queue: '<path d="M4 6h16M4 12h10M4 18h7" /><path d="M17 15l3 3-3 3" />',
  steer: '<path d="M5 12h11M12 6l6 6-6 6" />',
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
  const photoInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', 'aria-hidden': 'true', tabindex: '-1' })
  photoInput.addEventListener('change', () => {
    const [file] = photoInput.files ?? []
    if (file) void usePhoto(file)
  })
  return h('div', { class: 'link-actions' },
    cameraAvailable()
      ? h('button', { class: 'primary scan-button', onClick: () => void openScanner() }, 'Scan QR code')
      : null,
    h('button', { class: 'secondary photo-button', onClick: () => photoInput.click() }, 'Take a photo of the QR'),
    photoInput,
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

async function usePhoto(file) {
  renderLinkScreen({ title: 'Reading the code…', body: 'One moment.', busy: true })
  try {
    const text = await decodeQrImage(file)
    if (text) return useScannedText(text)
  } catch { /* handled below */ }
  renderUnlinked({
    title: 'No QR code found in that photo',
    body: 'Take the photo straight on, with the whole code inside the frame, or paste the link instead.',
    tone: 'error',
  })
}

async function cameraDiagnosis(error) {
  let site = 'unknown'
  try { site = (await navigator.permissions.query({ name: 'camera' })).state } catch { /* not supported */ }
  let policy = 'unknown'
  try { policy = document.permissionsPolicy?.allowsFeature?.('camera') ?? document.featurePolicy?.allowsFeature?.('camera') ?? 'unknown' } catch { /* not supported */ }
  return { site, policy: String(policy), error: error?.name ?? 'Error' }
}

const CAMERA_APP_TIP = 'Easiest fix: close this page, open your phone’s own Camera app and point it at the QR on your computer. Tap the link it shows; this page opens already linked, no permission needed.'

async function cameraBlockedHelp(error) {
  const info = await cameraDiagnosis(error)
  const ua = navigator.userAgent
  let fix
  if (info.policy === 'false') fix = 'This page is not allowed to use the camera (old cached copy). Close all Ensync tabs, reopen ensync.vercel.app/mobile and try again.'
  else if (info.site === 'denied') {
    fix = /iPhone|iPad/i.test(ua)
      ? 'Safari has the camera blocked for this site: tap “aA” in the address bar → Website Settings → Camera → Allow.'
      : 'Chrome has the camera blocked for this site: tap the icon left of the address (⚙ or 🔒) → Permissions → Camera → Allow (or “Reset permissions”).'
  } else if (/Android/i.test(ua)) {
    fix = 'Android has the camera turned off for Chrome itself, so Chrome can’t ask. Open phone Settings → Apps → Chrome → Permissions → Camera → “Allow only while using the app”, then reload.'
  } else fix = 'Allow camera access for this browser in your phone settings, then reload.'
  return `${CAMERA_APP_TIP}\n\nOr: ${fix}\n\n(${info.error} · site ${info.site} · policy ${info.policy})`
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
        ? await cameraBlockedHelp(error)
        : `${error?.message ?? ''} ${CAMERA_APP_TIP}`,
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
  // A mirrored live turn ages out without a new revision, so which chats are
  // live right now is part of what the screen shows.
  const now = Date.now()
  const live = view.chats.filter((chat) => chatLiveTurn(chat, now)).map((chat) => chat.id).join(',')
  const delivery = route.view === 'chat' ? JSON.stringify(deliveryByChat.get(route.chatId) ?? null) : ''
  return JSON.stringify([route, sync.revision, sync.loaded, sync.ops.length, jobs, view.chats.length, recentProjects().length, sync.host?.label, sync.status.state, sync.status.failures >= 2, live, delivery, controlBusy])
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

function chatRunning(chat) {
  return chatIsRunning(chat, sync.jobsForChat(chat.id))
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
        chatRunning(chat) ? h('span', { class: 'running-pill' }, h('span', { class: 'spinner tiny' }), 'Running') : h('small', {}, providerName(chat.provider)),
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

function providerMark(id) {
  return h('span', { class: 'provider-mark', 'aria-hidden': 'true' }, (providerName(id) || '?').trim().charAt(0).toUpperCase())
}

/** One provider progress note, styled like the desktop's "<Provider> note" card. */
function noteCard(note, fallbackProvider) {
  const provider = note.provider ?? fallbackProvider
  return h('div', { class: 'live-note' },
    providerMark(provider),
    h('div', {},
      h('strong', {}, `${providerName(provider)} note`),
      renderMarkdown(note.text),
      note.redacted ? h('small', {}, 'Possible secret redacted by Ensync Host.') : null))
}

function notesView(notes, provider, { live = false } = {}) {
  if (!notes?.length) return null
  return h('div', { class: `live-notes${live ? '' : ' kept'}`, ...(live ? { role: 'log', 'aria-live': 'polite' } : {}), 'aria-label': 'Provider notes' },
    notes.map((note) => noteCard(note, provider)))
}

/** The desktop's three-dot "Working (1m 22s)" line; the ticker keeps it current. */
function workingLine(startedAt, provider) {
  return h('div', { class: 'working-line', role: 'status' },
    h('span', { 'aria-hidden': 'true' }), h('span', { 'aria-hidden': 'true' }), h('span', { 'aria-hidden': 'true' }),
    h('em', { 'data-started-at': startedAt ?? '' }, startedAt ? workingLabel(startedAt) : 'Working…'),
    h('span', { class: 'sr-only' }, `${providerName(provider)} is working in this chat.`))
}

function messageView(message, pending, { queued = false } = {}) {
  const isUser = message.role === 'user'
  const body = isUser ? h('div', { class: 'bubble-text', dir: 'auto' }, renderPlain(message.content)) : renderMarkdown(message.content)
  const status = pending
    ? 'Sending…'
    : queued
      ? 'Queued'
      : isUser && message.steeredInto
        ? 'Sent to the running turn'
        : isUser && message.deliveryStatus === 'failed'
          ? 'Run failed'
          : isUser && message.deliveryStatus === 'cancelled'
            ? 'Stopped'
            : null
  const meta = [message.time, !isUser && message.provider ? providerName(message.provider) : null, status].filter(Boolean).join(' · ')
  return h('article', { class: `message ${isUser ? 'user' : 'agent'}${pending ? ' pending' : ''}` },
    // A finished reply keeps the turn's last notes above it, as on the desktop.
    !isUser && Array.isArray(message.notes) ? notesView(message.notes, message.provider) : null,
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
  if (jobQueued(job, chat)) {
    const target = runningTarget(chat, sync.jobsForChat(chat.id).filter((other) => other.jobId !== job.jobId))
    return h('div', { class: 'job-card queued' },
      h('div', { class: 'job-head' },
        icon('queue'),
        h('strong', {}, 'Queued'),
        h('small', {}, `runs after the current turn on ${hostLabel()}`),
        h('button', { class: 'stop', 'aria-label': 'Remove from queue', disabled: job.stopping, onClick: () => void runCommand(job.jobId, 'cancel') }, icon('stop'), 'Remove')),
      canSteer(target)
        ? h('div', { class: 'job-actions' },
          h('button', {
            class: 'secondary',
            disabled: controlBusy === `push:${job.jobId}`,
            title: 'Deliver this message to the running Codex turn now',
            onClick: () => void runControl(`push:${job.jobId}`, { control: 'push_queued', targetJobId: job.jobId, conversationId: chat.id }),
          }, controlBusy === `push:${job.jobId}` ? 'Pushing…' : 'Push now'))
        : null)
  }
  const progress = jobProgress(job, chat)
  // Like the desktop transcript: provider notes, not terminal output. A
  // provider that reports no notes still shows its latest output lines.
  const tail = progress.notes.length ? '' : outputText(job).trimEnd().split('\n').slice(-8).join('\n')
  const steers = job.events.filter((event) => event.type === 'steer' || event.type === 'notice')
  const label = job.stopping
    ? 'Stopping…'
    : job.state === 'running' && progress.startedAt
      ? h('span', { 'data-started-at': progress.startedAt }, workingLabel(progress.startedAt))
      : stateLabel ?? job.state
  return h('div', { class: 'job-card live' },
    h('div', { class: 'job-head' },
      h('span', { class: 'spinner' }),
      h('strong', {}, label),
      h('small', {}, providerName(progress.provider)),
      job.submitted ? h('button', { class: 'stop', 'aria-label': 'Stop the agent', disabled: job.stopping, onClick: () => void runCommand(job.jobId, 'cancel') }, icon('stop'), 'Stop') : null),
    notesView(progress.notes, progress.provider, { live: true }),
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
  const queued = queuedMessageIds(chat)
  const items = []
  if (!chat.messages.length) items.push(h('div', { class: 'empty small' }, h('p', {}, 'No messages yet.')))
  // A turn running elsewhere (a desktop chat, or a phone turn this phone no
  // longer tracks) shows its live notes and working line right after its
  // prompt, like the desktop, ahead of anything queued behind it.
  const live = documentProgress(chat, jobs)
  const liveTurn = live ? chatLiveTurn(chat) : null
  const liveIndex = liveTurn
    ? chat.messages.findIndex((message) => message.turnId === liveTurn.turnId || message.id === liveTurn.messageId || message.id === liveTurn.turnId)
    : -1
  const liveBlock = live ? liveTurnView(chat, live) : null
  chat.messages.forEach((message, index) => {
    items.push(messageView(message, pending.has(message.id), { queued: queued.has(message.id) }))
    if (index === liveIndex) items.push(liveBlock)
    const job = jobByMessage.get(message.id)
    // Show the live run right after its prompt, until the reply lands below it.
    if (job && !chat.messages.slice(index + 1).some((next) => next.role === 'agent')) {
      const card = jobView(job, chat)
      if (card) items.push(card)
    }
  })
  if (live && liveIndex < 0) items.push(liveBlock)
  const delivery = deliveryView(chat)
  if (delivery) items.push(delivery)
  return h('div', { class: 'thread' }, items)
}

function liveTurnView(chat, live) {
  const stopKey = `stop:${chat.id}`
  return h('div', { class: 'live-turn' },
    notesView(live.notes, live.provider, { live: true }),
    h('div', { class: 'live-turn-row' },
      workingLine(live.startedAt, live.provider),
      h('button', {
        class: 'stop',
        'aria-label': 'Stop the agent',
        disabled: controlBusy === stopKey,
        onClick: () => void stopChat(chat),
      }, icon('stop'), controlBusy === stopKey ? 'Stopping…' : 'Stop')))
}

function controlScope(chat) {
  const project = findProject(chat.projectId)
  return {
    conversationId: chat.id,
    ...(project?.path ? { projectPath: project.path } : {}),
    workspaceKey: resolveConversationWorkspaceKey(chat),
  }
}

/** Stops the turn running in this chat, whichever device started it. */
async function stopChat(chat) {
  const target = runningTarget(chat, sync.jobsForChat(chat.id))
  if (target?.kind === 'job') return runCommand(target.jobId, 'cancel')
  return runControl(`stop:${chat.id}`, {
    control: 'cancel',
    ...controlScope(chat),
    ...(target?.targetJobId ? { targetJobId: target.targetJobId } : {}),
  })
}

async function runControl(key, request) {
  if (controlBusy) return null
  controlBusy = key
  renderShell()
  try {
    const result = await sync.control(request)
    if (request.control === 'cancel' && result?.stopped === false) {
      sync.status = { ...sync.status, error: new Error('Nothing is running in this conversation any more.') }
    }
    return result
  } catch (error) {
    sync.status = { ...sync.status, error }
    return null
  } finally {
    controlBusy = null
    renderShell()
  }
}

// ---- delivery -------------------------------------------------------------------------

function chatHasDeliveries(chat) {
  return (chat.messages ?? []).some((message) => message.role === 'agent')
}

async function refreshDelivery(chat) {
  const scope = controlScope(chat)
  if (!scope.projectPath || !sync?.client?.host?.id) return
  const previous = deliveryByChat.get(chat.id)
  deliveryByChat.set(chat.id, { ...(previous ?? {}), at: Date.now(), loading: true })
  try {
    const result = await sync.control({ control: 'delivery_status', ...scope })
    deliveryByChat.set(chat.id, { at: Date.now(), delivery: result?.delivery ?? null, error: null })
  } catch (error) {
    deliveryByChat.set(chat.id, { at: Date.now(), delivery: previous?.delivery ?? null, error: error?.message ?? 'Delivery status is unavailable.' })
  }
  if (route.view === 'chat' && route.chatId === chat.id) renderMain()
}

function maybeRefreshDelivery() {
  if (route.view !== 'chat' || !sync) return
  const chat = sync.chat(route.chatId)
  if (!chat || !chatHasDeliveries(chat)) return
  const state = deliveryByChat.get(chat.id)
  if (state?.loading || (state && Date.now() - state.at < DELIVERY_REFRESH_MS)) return
  void refreshDelivery(chat)
}

/** The desktop delivery panel's progress, for this conversation's newest delivery. */
function deliveryView(chat) {
  if (!chatHasDeliveries(chat)) return null
  const state = deliveryByChat.get(chat.id)
  const record = latestDelivery(state?.delivery)
  if (!record) return null
  const position = deliveryPosition(record)
  const steps = record.deliveryTarget === 'protected_branch' ? DELIVERY_STEPS.slice(0, 1) : DELIVERY_STEPS
  return h('section', { class: `delivery-card ${deliveryTone(record)}`, 'aria-label': 'Delivery' },
    h('div', { class: 'delivery-head' },
      h('strong', {}, deliveryLabel(record)),
      h('small', {}, record.deliveryTarget === 'protected_branch' ? 'Protected branch only' : record.state === 'production' ? 'Verified production' : 'Production delivery')),
    record.description ? h('p', { dir: 'auto', class: 'delivery-description' }, record.description) : null,
    h('ol', { class: 'delivery-steps' }, steps.map((step, index) => h('li', { class: index < position ? 'done' : index === position ? 'current' : '' }, step))),
    h('p', { class: 'delivery-detail', dir: 'auto' }, deliveryDetail(record)),
    record.deploymentUrl && record.state === 'production' ? h('a', { href: record.deploymentUrl, target: '_blank', rel: 'noopener' }, 'Open deployment') : null)
}

// Keeps every visible "Working (…)" label current between document updates,
// and re-renders occasionally so a live turn whose writer went quiet ages out.
let tickCount = 0
setInterval(() => {
  if (!sync || document.visibilityState !== 'visible') return
  const labels = shell?.scroller?.querySelectorAll('[data-started-at]') ?? []
  for (const node of labels) {
    if (node.dataset.startedAt) node.textContent = workingLabel(node.dataset.startedAt)
  }
  tickCount += 1
  if (tickCount % 15 === 0 && shell) renderMain()
  if (shell) maybeRefreshDelivery()
}, 1_000)

// ---- composer --------------------------------------------------------------------------

function buildComposer() {
  const textarea = h('textarea', { rows: 1, dir: 'auto', placeholder: 'Message', enterkeyhint: 'send', 'aria-label': 'Message' })
  const select = h('select', { 'aria-label': 'Agent' })
  const delivery = h('select', { 'aria-label': 'Delivery' },
    DELIVERY_TARGETS.map((target) => h('option', { value: target.id, title: target.detail }, target.label)))
  delivery.value = deliveryTarget
  delivery.addEventListener('change', () => {
    deliveryTarget = delivery.value === 'protected_branch' ? 'protected_branch' : 'production'
    saveJson(DELIVERY_TARGET_KEY, deliveryTarget)
  })
  const button = h('button', { class: 'send', type: 'submit', 'aria-label': 'Send' }, icon('send'))
  // While a turn runs, Send queues (as on the desktop); Steer delivers the
  // text into the running Codex turn instead.
  const steer = h('button', { class: 'steer', type: 'button', hidden: true, 'aria-label': 'Steer the running agent' }, icon('steer'), 'Steer')
  steer.addEventListener('click', () => void steerComposer())
  const form = h('form', { class: 'composer' },
    h('div', { class: 'composer-row' }, textarea, button),
    h('div', { class: 'composer-tools' },
      h('label', { class: 'agent-picker' }, select),
      h('label', { class: 'agent-picker delivery-picker' }, delivery),
      steer))
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
    steer.disabled = !textarea.value.trim()
  })
  textarea.addEventListener('focus', () => {
    setTimeout(() => { shell.scroller.scrollTop = shell.scroller.scrollHeight }, 250)
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void submitComposer()
  })
  return { element: form, textarea, select, delivery, button, steer, resize, key: null }
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
  const running = chat ? (activeJob(chat.id) ?? (chatLiveTurn(chat) ? { live: true } : null)) : null
  const target = chat ? runningTarget(chat, sync.jobsForChat(chat.id)) : null
  const providers = hostProviders()
  const fallback = providers.find((provider) => provider.available !== false)?.id ?? 'claude'
  // Ensync runs Claude Code: a chat that once used another provider continues
  // with what this computer offers instead of naming a CLI it no longer runs.
  const candidate = composer.provider ?? chat?.provider ?? fallback
  const preferred = providers.some((provider) => provider.id === candidate) ? candidate : fallback
  const options = providers.map((provider) => h('option', { value: provider.id, disabled: provider.available === false }, provider.available === false ? `${provider.name} (unavailable)` : provider.name))
  const signature = options.map((option) => option.outerHTML).join('')
  if (composer.optionsSignature !== signature) {
    composer.select.replaceChildren(...options)
    composer.optionsSignature = signature
  }
  composer.select.value = preferred
  composer.select.onchange = () => { composer.provider = composer.select.value }
  // One provider (Claude Code) needs no picker.
  composer.select.hidden = providers.length <= 1
  composer.delivery.value = deliveryTarget
  composer.textarea.placeholder = running ? 'Queue a message for after this turn…' : route.view === 'new' ? 'Describe the task' : 'Message'
  composer.button.setAttribute('aria-label', running ? 'Queue' : 'Send')
  composer.element.classList.toggle('busy', Boolean(running))
  composer.steer.hidden = !canSteer(target)
  composer.steer.disabled = !composer.textarea.value.trim() || Boolean(controlBusy)
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

function clearComposer(composer) {
  delete drafts[composer.key]
  saveJson(DRAFTS_KEY, drafts)
  composer.textarea.value = ''
  composer.resize()
  composer.button.disabled = true
}

/** Delivers the composer text into the running turn (Codex live steering). */
async function steerComposer() {
  const composer = shell.composer
  const prompt = composer.textarea.value.trim()
  const chat = route.view === 'chat' ? sync.chat(route.chatId) : null
  if (!prompt || !chat) return
  const target = runningTarget(chat, sync.jobsForChat(chat.id))
  if (!target) return
  clearComposer(composer)
  if (target.kind === 'job') {
    await runCommand(target.jobId, 'steer', { prompt })
    return
  }
  await runControl(`steer:${chat.id}`, {
    control: 'steer',
    prompt,
    ...controlScope(chat),
    ...(target.targetJobId ? { targetJobId: target.targetJobId } : {}),
  })
}

async function submitComposer() {
  const composer = shell.composer
  const prompt = composer.textarea.value.trim()
  if (!prompt) return
  const provider = composer.select.value || 'claude'
  const chatId = route.view === 'chat' ? route.chatId : null
  const clear = () => clearComposer(composer)
  // Sending while a turn runs queues the message: Ensync Host starts it once
  // the running turn ends, exactly like a desktop prompt sent mid-turn.
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
  const request = turnRequest({ chat, project, provider, prompt, messageId: message.id, deliveryTarget })
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
  // Ask Chrome/Safari never to evict the stored link under storage pressure,
  // so the phone stays linked until it is disconnected on purpose.
  try { void navigator.storage?.persist?.() } catch { /* not supported */ }
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
