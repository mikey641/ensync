import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { AccountSyncError, AccountSyncService } from './account-sync.mjs'
import {
  ChatAttachmentStore,
  MAX_STORED_ATTACHMENT_BYTES,
  probeAttachmentPaths,
} from './chat-attachments.mjs'
import { ChatImageError, ChatImageService } from './chat-images.mjs'
import { ChatRunError, ChatRunService } from './chat.mjs'
import { ChatJobError, ChatJobService } from './chat-jobs.mjs'
import { ChatJobJournal } from './chat-job-journal.mjs'
import { DaemonLeaseError } from './daemon-lifecycle.mjs'
import { GitWorkflowError, GitWorkflowService } from './git.mjs'
import { runLandCheck } from './land-check.mjs'
import { readLocalFileForDisplay } from './local-file.mjs'
import { getProviderDefinition, isProviderId, ProviderStatusService } from './providers.mjs'
import { ProjectIsolationService } from './project-isolation.mjs'
import { ProjectInspectionService } from './projects.mjs'
import {
  SupportRepairError,
  SupportRepairService,
  supportRepairErrorPayload,
} from './support-repair.mjs'
import { RemoteSshError, RemoteSshService } from './remote-ssh.mjs'
import { SupportService, SupportValidationError } from './support.mjs'
import { SyncBrokerHostWorker } from './sync-broker-host.mjs'
import { TelegramBridgeError, TelegramBridgeService } from './telegram.mjs'
import { TelegramChatRouter } from './telegram-router.mjs'
import { displayCommand, launchTerminalCommand } from './terminal.mjs'
import { getInstallCommand, hasInstallCommand } from './provider-install.mjs'
import { VirtualBoxError, VirtualBoxService } from './virtualbox.mjs'

const DEFAULT_PORT = 43_121
const LOOPBACK_HOST = '127.0.0.1'
const MAX_BODY_BYTES = 128 * 1024
const MAX_SYNC_BODY_BYTES = 9 * 1024 * 1024
const AUTOMATIC_UPDATE_DEDUPE_MS = 5 * 60 * 1_000

function isAllowedOrigin(origin) {
  if (!origin) return true
  try {
    const url = new URL(origin)
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

function bearerAuthorized(header, expected) {
  if (!expected) return true
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice(7), 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

function responseHeaders(origin) {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  }
  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers.Vary = 'Origin'
  }
  return headers
}

function sendJson(response, statusCode, payload, origin) {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(statusCode, responseHeaders(origin))
  response.end(JSON.stringify(payload))
}

function sendImage(response, image, origin) {
  if (response.destroyed || response.writableEnded) return
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Length': String(image.size),
    'Content-Type': image.contentType,
    'X-Content-Type-Options': 'nosniff',
  }
  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers.Vary = 'Origin'
  }
  response.writeHead(200, headers)
  const stream = createReadStream(image.path)
  const stop = () => stream.destroy()
  response.once('close', stop)
  stream.once('error', () => {
    response.removeListener('close', stop)
    if (!response.destroyed) response.destroy()
  })
  stream.once('end', () => response.removeListener('close', stop))
  stream.pipe(response)
}

function streamHeaders(origin) {
  return {
    ...responseHeaders(origin),
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }
}

function sendStreamEvent(response, event) {
  if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`)
}

function chatJobErrorPayload(error) {
  if (error instanceof ChatRunError || error instanceof RemoteSshError) {
    return {
      message: error.message,
      code: error.code,
      status: error.status,
      safeToRetry: error.safeToRetry,
    }
  }
  return {
    message: error instanceof Error ? error.message : 'Unexpected Ensync Host error.',
    code: 'unexpected_host_error',
    status: 500,
    safeToRetry: false,
  }
}

function requestCancellation(request, response) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const abortOnClose = () => {
    if (!response.writableEnded) abort()
  }
  request.once('aborted', abort)
  response.once('close', abortOnClose)
  return {
    signal: controller.signal,
    dispose() {
      request.removeListener('aborted', abort)
      response.removeListener('close', abortOnClose)
    },
  }
}

function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > maxBytes) {
        reject(new Error('Request body is too large.'))
        request.destroy()
      }
    })
    request.on('end', () => {
      if (!body) return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('Request body must be valid JSON.'))
      }
    })
    request.on('error', reject)
  })
}

function readBinaryBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    request.on('data', (chunk) => {
      received += chunk.length
      if (received > maxBytes) {
        reject(new ChatRunError(
          'invalid_attachment',
          `Attachment uploads must stay under ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
          413,
        ))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function refreshRequested(url) {
  return ['1', 'true'].includes(url.searchParams.get('refresh')?.toLowerCase())
}

export function createEnsyncHost(options = {}) {
  const accountSync = options.accountSyncService ?? new AccountSyncService({
    baseUrl: options.accountSyncServiceUrl ?? process.env.ENSYNC_SYNC_SERVICE_URL ?? null,
  })
  const statuses = options.statusService ?? new ProviderStatusService()
  const terminalLauncher = options.terminalLauncher ?? launchTerminalCommand
  const automaticUpdateLaunches = new Map()
  const providerUpdateLaunches = new Map()
  const projectIsolation = options.projectIsolationService ?? new ProjectIsolationService({
    rootPath: options.projectIsolationRoot,
  })
  const chatImages = options.chatImageService ?? new ChatImageService({
    workspaceRoot: options.projectIsolationRoot,
  })
  const chats = options.chatService ?? new ChatRunService({
    statusService: statuses,
    allowedRoots: options.allowedProjectRoots,
    projectIsolation,
  })
  const chatAttachments = options.chatAttachmentStore ?? new ChatAttachmentStore({
    rootPath: options.chatAttachmentsRoot,
  })
  const projects = options.projectService ?? new ProjectInspectionService({
    allowedRoots: options.allowedProjectRoots,
    defaultProjectPath: options.defaultProjectPath,
  })
  const supportRepairs = options.supportRepairService ?? new SupportRepairService({
    projectService: projects,
    chatService: chats,
  })
  const support = options.supportService ?? new SupportService({
    statusService: statuses,
    projectService: projects,
    githubIssuesUrl: options.githubIssuesUrl ?? process.env.ENSYNC_GITHUB_ISSUES_URL,
    appVersion: options.appVersion ?? process.env.npm_package_version ?? null,
    buildChannel: options.buildChannel ?? process.env.ENSYNC_BUILD_CHANNEL ?? null,
  })
  const git = options.gitService ?? new GitWorkflowService({
    allowedRoots: options.allowedProjectRoots,
    verifyLand: (details) => runLandCheck(details.repositoryPath),
  })
  const remoteSsh = options.remoteSshService ?? new RemoteSshService()
  const chatJobJournal = options.chatJobJournal ?? (options.chatJobJournalPath
    ? new ChatJobJournal({
        filePath: options.chatJobJournalPath,
        writer: options.instanceId ? { instanceId: options.instanceId, pid: process.pid } : null,
      })
    : null)
  const chatJobs = options.chatJobService ?? new ChatJobService({
    runLocal: (request, runOptions) => chats.run(request, runOptions),
    runRemote: (request, runOptions) => remoteSsh.runChat(request, runOptions),
    steerLocal: (jobId, input) => chats.steer(jobId, input),
    canSteerLocal: (jobId) => chats.canSteer(jobId),
    normalizeError: chatJobErrorPayload,
    journal: chatJobJournal,
  })
  const syncBrokerHost = options.syncBrokerHostService ?? new SyncBrokerHostWorker({
    accountSyncService: accountSync,
    chatJobService: chatJobs,
    pollIntervalMs: options.syncBrokerPollIntervalMs,
  })
  const daemonLeases = options.daemonLeaseService ?? null
  const authToken = typeof options.authToken === 'string' && options.authToken.length >= 32
    ? options.authToken
    : null
  const telegramRouter = options.telegramChatRunner ?? new TelegramChatRouter({
    chatService: chats,
    statusService: statuses,
    remoteSshService: remoteSsh,
  })
  const telegram = options.telegramService ?? new TelegramBridgeService({
    chatRunner: telegramRouter,
  })
  const allowVirtualBoxMutation = options.allowVirtualBoxMutation
    ?? process.env.ENSYNC_ALLOW_VIRTUALBOX_MUTATION !== '0'
  const virtualBox = options.virtualBoxService ?? new VirtualBoxService({
    allowMutation: allowVirtualBoxMutation,
  })
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin
    if (!isAllowedOrigin(origin)) {
      return sendJson(response, 403, { error: 'Origin is not allowed.' })
    }

    if (!bearerAuthorized(request.headers.authorization, authToken)) {
      return sendJson(response, 401, { error: 'Ensync Host authentication failed.', code: 'host_authentication_failed' })
    }

    if (request.method === 'OPTIONS') {
      const headers = responseHeaders(origin)
      headers['Access-Control-Allow-Headers'] = 'Content-Type'
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
      response.writeHead(204, headers)
      return response.end()
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(response, 200, {
          ok: true,
          service: 'ensync-host',
          apiVersion: 1,
          instanceId: options.instanceId ?? null,
          detachedJobs: Boolean(chatJobJournal),
          now: new Date().toISOString(),
        }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/daemon/claim' && daemonLeases) {
        const body = await readJsonBody(request)
        return sendJson(response, 200, { lease: daemonLeases.claim(body.ownerId) }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/daemon/heartbeat' && daemonLeases) {
        const body = await readJsonBody(request)
        return sendJson(response, 200, { lease: daemonLeases.heartbeat(body.ownerId) }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/daemon/release' && daemonLeases) {
        const body = await readJsonBody(request)
        return sendJson(response, 200, { lease: daemonLeases.release(body.ownerId) }, origin)
      }

      if (daemonLeases && !daemonLeases.has(request.headers['x-ensync-owner'])) {
        return sendJson(response, 403, {
          error: 'The native shell lease is missing or expired.',
          code: 'daemon_owner_expired',
        }, origin)
      }

      if (request.method === 'GET' && url.pathname === '/api/account-sync/status') {
        return sendJson(response, 200, accountSync.status(), origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/account-sync/register') {
        const body = await readJsonBody(request)
        const status = await accountSync.register({ username: body.username, password: body.password })
        return sendJson(response, 201, status, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/account-sync/login') {
        const body = await readJsonBody(request)
        const status = await accountSync.login({ username: body.username, password: body.password })
        return sendJson(response, 200, status, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/account-sync/logout') {
        return sendJson(response, 200, await accountSync.logout(), origin)
      }

      if (request.method === 'GET' && url.pathname === '/api/account-sync/workspace') {
        return sendJson(response, 200, await accountSync.pull(), origin)
      }

      if (request.method === 'PUT' && url.pathname === '/api/account-sync/workspace') {
        const body = await readJsonBody(request, MAX_SYNC_BODY_BYTES)
        return sendJson(response, 200, await accountSync.push(body.state, body.baseRevision), origin)
      }

      if (request.method === 'GET' && url.pathname === '/api/providers') {
        const providers = await statuses.list({ refresh: refreshRequested(url) })
        return sendJson(response, 200, { providers, checkedAt: new Date().toISOString() }, origin)
      }

      if (request.method === 'GET' && url.pathname === '/api/usage') {
        const providers = await statuses.list({ refresh: refreshRequested(url) })
        return sendJson(response, 200, {
          providers: providers.map(({ id, name, installed, connectionState, usage }) => ({
            id,
            name,
            installed,
            connectionState,
            ...usage,
          })),
          checkedAt: new Date().toISOString(),
        }, origin)
      }

      if (request.method === 'GET' && url.pathname === '/api/projects/current') {
        const project = await projects.current()
        return sendJson(response, 200, { project }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/projects/inspect') {
        const body = await readJsonBody(request)
        const project = await projects.inspect(body.path)
        return sendJson(response, 200, { project }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/local-file') {
        const body = await readJsonBody(request)
        const file = await readLocalFileForDisplay(body.path)
        return sendJson(response, 200, { file }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/git/clone') {
        const body = await readJsonBody(request)
        const result = await git.clone(body)
        return sendJson(response, 200, result, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/git/status') {
        const body = await readJsonBody(request)
        const status = await git.status(body.projectPath)
        return sendJson(response, 200, { git: status }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/git/verify-remote') {
        const body = await readJsonBody(request)
        const connection = await git.verifyRemote(body)
        return sendJson(response, 200, { connection }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/git/push') {
        const body = await readJsonBody(request)
        const result = await git.push(body)
        return sendJson(response, 200, result, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/git/unlanded') {
        const body = await readJsonBody(request)
        const unlanded = await git.unlanded(body.projectPath)
        return sendJson(response, 200, { unlanded }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/git/land') {
        const body = await readJsonBody(request)
        const result = await git.land(body)
        return sendJson(response, 200, result, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/chat/attachments/probe') {
        const body = await readJsonBody(request)
        return sendJson(response, 200, await probeAttachmentPaths(body.paths), origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/chat/attachments') {
        const bytes = await readBinaryBody(request, MAX_STORED_ATTACHMENT_BYTES)
        const attachment = await chatAttachments.store({ name: url.searchParams.get('name'), bytes })
        return sendJson(response, 201, { attachment }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/chat/run') {
        const cancellation = requestCancellation(request, response)
        try {
          const body = await readJsonBody(request)
          const result = await chats.run(body, { signal: cancellation.signal })
          return sendJson(response, 200, result, origin)
        } finally {
          cancellation.dispose()
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/chat/image') {
        const image = await chatImages.open({
          workspacePath: url.searchParams.get('workspacePath'),
          imagePath: url.searchParams.get('path'),
        })
        return sendImage(response, image, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/chat/jobs') {
        const body = await readJsonBody(request)
        const job = chatJobs.start(body)
        return sendJson(response, 202, { job }, origin)
      }

      const chatJobStreamMatch = url.pathname.match(/^\/api\/chat\/jobs\/([^/]+)\/stream$/)
      if (request.method === 'GET' && chatJobStreamMatch) {
        const jobId = decodeURIComponent(chatJobStreamMatch[1])
        chatJobs.get(jobId)
        response.writeHead(200, streamHeaders(origin))
        let dispose = () => false
        const disposeOnClose = () => { dispose() }
        response.once('close', disposeOnClose)
        dispose = chatJobs.subscribe(jobId, {
          afterSequence: Number(url.searchParams.get('after') ?? 0),
          onEvent: (event) => sendStreamEvent(response, event),
          onEnd: () => {
            response.removeListener('close', disposeOnClose)
            if (!response.destroyed && !response.writableEnded) response.end()
          },
        })
        return
      }

      const chatJobCancelMatch = url.pathname.match(/^\/api\/chat\/jobs\/([^/]+)\/cancel$/)
      if (request.method === 'POST' && chatJobCancelMatch) {
        const job = chatJobs.cancel(decodeURIComponent(chatJobCancelMatch[1]))
        return sendJson(response, 200, { job }, origin)
      }

      const chatJobSteerMatch = url.pathname.match(/^\/api\/chat\/jobs\/([^/]+)\/steer$/)
      if (request.method === 'POST' && chatJobSteerMatch) {
        const jobId = decodeURIComponent(chatJobSteerMatch[1])
        const body = await readJsonBody(request)
        const delivery = await chatJobs.steer(jobId, body)
        return sendJson(response, 200, { job: chatJobs.get(jobId), delivery }, origin)
      }

      const chatJobMatch = url.pathname.match(/^\/api\/chat\/jobs\/([^/]+)$/)
      if (request.method === 'GET' && chatJobMatch) {
        const job = chatJobs.get(decodeURIComponent(chatJobMatch[1]))
        return sendJson(response, 200, { job }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/chat/run/stream') {
        const cancellation = requestCancellation(request, response)
        try {
          const body = await readJsonBody(request)
          response.writeHead(200, streamHeaders(origin))
          try {
            const result = await chats.run(body, {
              signal: cancellation.signal,
              onEvent: (event) => sendStreamEvent(response, event),
            })
            sendStreamEvent(response, { type: 'completed', result, at: new Date().toISOString() })
          } catch (error) {
            const known = error instanceof ChatRunError
            const cancelled = known && error.code === 'run_cancelled'
            sendStreamEvent(response, cancelled ? {
              type: 'cancelled',
              message: error.message,
              code: error.code,
              status: error.status,
              safeToRetry: false,
              at: new Date().toISOString(),
            } : {
              type: 'error',
              error: known ? error.message : error instanceof Error ? error.message : 'Unexpected Ensync Host error.',
              code: known ? error.code : 'unexpected_host_error',
              status: known ? error.status : 500,
              safeToRetry: known && error.safeToRetry,
              at: new Date().toISOString(),
            })
          }
          return response.end()
        } finally {
          cancellation.dispose()
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/support/repair') {
        const body = await readJsonBody(request)
        const result = await supportRepairs.run(body)
        return sendJson(response, 200, result, origin)
      }

      if (request.method === 'GET' && url.pathname === '/api/support/status') {
        return sendJson(response, 200, support.status(), origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/support/preview') {
        const body = await readJsonBody(request)
        const result = await support.preview(body)
        return sendJson(response, 200, result, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/support/github-issue') {
        const body = await readJsonBody(request)
        const result = support.prepareGitHubIssue(body)
        return sendJson(response, 200, result, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/remote/ssh/probe') {
        const body = await readJsonBody(request)
        const probe = await remoteSsh.probe(body)
        return sendJson(response, 200, { probe }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/remote/ssh/chat') {
        const cancellation = requestCancellation(request, response)
        try {
          const body = await readJsonBody(request)
          const result = await remoteSsh.runChat(body, { signal: cancellation.signal })
          return sendJson(response, 200, result, origin)
        } finally {
          cancellation.dispose()
        }
      }

      if (request.method === 'GET' && url.pathname === '/api/telegram/status') {
        return sendJson(response, 200, telegram.status(), origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/telegram/pair') {
        const body = await readJsonBody(request)
        const pairing = await telegram.startPairing(body.botToken)
        return sendJson(response, 200, pairing, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/telegram/context') {
        const body = await readJsonBody(request)
        const context = telegram.setTaskContext(body)
        return sendJson(response, 200, context, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/telegram/disconnect') {
        const status = await telegram.disconnect()
        return sendJson(response, 200, status, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/telegram/send') {
        const body = await readJsonBody(request)
        const delivery = await telegram.sendMessage(body.text)
        return sendJson(response, 200, delivery, origin)
      }

      if (request.method === 'GET' && url.pathname === '/api/virtualbox/status') {
        const status = await virtualBox.status()
        return sendJson(response, 200, {
          ...status,
          mutationEnabled: allowVirtualBoxMutation,
        }, origin)
      }

      if (request.method === 'GET' && url.pathname === '/api/virtualbox/vms') {
        const machines = await virtualBox.list()
        return sendJson(response, 200, { machines }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/virtualbox/inspect') {
        const body = await readJsonBody(request)
        const machine = await virtualBox.inspect(body)
        return sendJson(response, 200, { machine }, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/virtualbox/preview') {
        const body = await readJsonBody(request)
        const plan = await virtualBox.preview(body)
        return sendJson(response, 200, plan, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/virtualbox/provision') {
        const body = await readJsonBody(request)
        const result = await virtualBox.provision(body)
        return sendJson(response, 200, result, origin)
      }

      if (request.method === 'POST' && url.pathname === '/api/virtualbox/start') {
        const body = await readJsonBody(request)
        const result = await virtualBox.start(body)
        return sendJson(response, 200, result, origin)
      }

      const statusMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/status$/)
      if (request.method === 'GET' && statusMatch) {
        const id = decodeURIComponent(statusMatch[1])
        if (!isProviderId(id)) {
          return sendJson(response, 404, { error: 'Unknown provider.' }, origin)
        }
        const provider = await statuses.get(id, { refresh: refreshRequested(url) })
        return sendJson(response, 200, { provider }, origin)
      }

      const connectMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/connect$/)
      if (request.method === 'POST' && connectMatch) {
        const id = decodeURIComponent(connectMatch[1])
        const definition = getProviderDefinition(id)
        if (!definition) {
          return sendJson(response, 404, { error: 'Unknown provider.' }, origin)
        }

        const body = await readJsonBody(request)
        const provider = await statuses.get(id, { refresh: true })
        if (!provider?.installed || !provider.executable) {
          return sendJson(response, 409, {
            error: `${definition.name} is not installed or is not available on PATH.`,
            provider,
          }, origin)
        }
        if (!Array.isArray(definition.loginArgs)) {
          return sendJson(response, 409, {
            error: provider.connectReason,
            provider,
          }, origin)
        }

        const command = {
          executable: provider.executable,
          args: definition.loginArgs,
          display: displayCommand(provider.executable, definition.loginArgs),
        }
        if (body.launch === false) {
          return sendJson(response, 200, {
            started: false,
            launchMode: 'manual',
            command,
            message: 'Run this command in a terminal, then refresh provider status.',
          }, origin)
        }

        const launch = await terminalLauncher(provider.executable, definition.loginArgs)
        if (launch.started) statuses.invalidate()
        return sendJson(response, 200, {
          ...launch,
          command,
          message: id === 'copilot'
            ? launch.started
              ? 'Copilot opened. Sign in only if prompted, then check again in Ensync.'
              : 'Automatic launch was unavailable. Run the shown command, sign in if needed, then check again.'
            : launch.started
              ? 'Login opened in a terminal. Complete it there, then Ensync can refresh the status.'
              : 'Automatic launch was unavailable. Run the shown command in a terminal.',
        }, origin)
      }

      const updateMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/update$/)
      if (request.method === 'POST' && updateMatch) {
        const id = decodeURIComponent(updateMatch[1])
        const definition = getProviderDefinition(id)
        if (!definition) {
          return sendJson(response, 404, { error: 'Unknown provider.' }, origin)
        }

        const body = await readJsonBody(request)
        if (body.launch !== true && body.launch !== false) {
          return sendJson(response, 400, {
            error: 'Provider update requests require an explicit launch boolean.',
            code: 'invalid_provider_update_request',
          }, origin)
        }
        const trigger = body.trigger ?? 'manual'
        if (!['manual', 'automatic'].includes(trigger) || (trigger === 'automatic' && body.launch !== true)) {
          return sendJson(response, 400, {
            error: 'Provider update trigger must be manual, or automatic with launch enabled.',
            code: 'invalid_provider_update_request',
          }, origin)
        }
        const provider = await statuses.get(id, { refresh: true })
        if (!provider?.installed || !provider.executable) {
          return sendJson(response, 409, {
            error: `${definition.name} is not installed or is not available on PATH.`,
            provider,
          }, origin)
        }
        if (!Array.isArray(definition.updateArgs)) {
          return sendJson(response, 409, {
            error: provider.updateReason,
            provider,
          }, origin)
        }

        const command = {
          executable: provider.executable,
          args: definition.updateArgs,
          display: displayCommand(provider.executable, definition.updateArgs),
        }
        if (body.launch === false) {
          return sendJson(response, 200, {
            started: false,
            launchMode: 'manual',
            command,
            previousVersion: provider.version,
            message: 'Run this official self-update command in a terminal, then refresh provider status.',
          }, origin)
        }
        if (chatJobs.hasRunningJobs() || chats.hasRunningRuns?.()) {
          return sendJson(response, 409, {
            error: 'Wait for active agent runs to finish before updating an installed CLI.',
            code: 'provider_update_busy',
            provider,
          }, origin)
        }

        const recentAutomaticLaunch = automaticUpdateLaunches.get(id)
        if (trigger === 'automatic'
          && Number.isFinite(recentAutomaticLaunch)
          && Date.now() - recentAutomaticLaunch < AUTOMATIC_UPDATE_DEDUPE_MS) {
          return sendJson(response, 200, {
            started: false,
            deduplicated: true,
            launchMode: 'terminal',
            command,
            previousVersion: provider.version,
            message: 'This automatic update was already opened by another Ensync window.',
          }, origin)
        }
        if (providerUpdateLaunches.has(id)) {
          return sendJson(response, 409, {
            error: `${definition.name} already has an update launch in progress.`,
            code: 'provider_update_in_progress',
            provider,
          }, origin)
        }

        const launchPromise = terminalLauncher(provider.executable, definition.updateArgs)
        providerUpdateLaunches.set(id, launchPromise)
        let launch
        try {
          launch = await launchPromise
        } finally {
          if (providerUpdateLaunches.get(id) === launchPromise) providerUpdateLaunches.delete(id)
        }
        if (launch.started && trigger === 'automatic') automaticUpdateLaunches.set(id, Date.now())
        if (launch.started) statuses.invalidate()
        return sendJson(response, 200, {
          ...launch,
          command,
          previousVersion: provider.version,
          message: launch.started
            ? 'Update opened in a terminal. Let it finish, then check again so Ensync can read the installed version.'
            : 'Automatic launch was unavailable. Run the shown official self-update command in a terminal.',
        }, origin)
      }

      const installMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/install$/)
      if (request.method === 'POST' && installMatch) {
        const id = decodeURIComponent(installMatch[1])
        const definition = getProviderDefinition(id)
        if (!definition) {
          return sendJson(response, 404, { error: 'Unknown provider.' }, origin)
        }
        if (!hasInstallCommand(id)) {
          return sendJson(response, 409, {
            error: `${definition.name} does not have a verified curl install command.`,
            code: 'provider_install_unavailable',
          }, origin)
        }
        const body = await readJsonBody(request)
        if (body.launch !== true && body.launch !== false) {
          return sendJson(response, 400, {
            error: 'Provider install requests require an explicit launch boolean.',
            code: 'invalid_provider_install_request',
          }, origin)
        }
        const installInfo = getInstallCommand(id)
        const command = {
          command: installInfo.command,
          source: installInfo.source,
        }
        if (body.launch === false) {
          return sendJson(response, 200, {
            started: false,
            launchMode: 'manual',
            command,
            message: 'Run this install command in a terminal, then refresh provider status.',
          }, origin)
        }
        if (chatJobs.hasRunningJobs() || chats.hasRunningRuns?.()) {
          return sendJson(response, 409, {
            error: 'Wait for active agent runs to finish before installing a CLI.',
            code: 'provider_install_busy',
          }, origin)
        }
        // Launch the curl install command in a terminal. The terminal launcher
        // runs the command through the OS shell (osascript on macOS, PowerShell
        // on Windows), so we pass the full curl pipeline as a single shell
        // command string rather than splitting it into executable + args.
        const platform = process.platform
        const shellExecutable = platform === 'win32' ? 'powershell.exe' : '/bin/sh'
        const shellArgs = platform === 'win32'
          ? ['-NoProfile', '-Command', installInfo.command]
          : ['-c', installInfo.command]
        const launch = await terminalLauncher(shellExecutable, shellArgs)
        if (launch.started) statuses.invalidate()
        return sendJson(response, 200, {
          ...launch,
          command,
          message: launch.started
            ? 'Install opened in a terminal. Let it finish, then refresh so Ensync can detect the CLI.'
            : 'Automatic launch was unavailable. Run the shown install command in a terminal.',
        }, origin)
      }

      return sendJson(response, 404, { error: 'Not found.' }, origin)
    } catch (error) {
      if (error instanceof ChatRunError) {
        return sendJson(response, error.status, {
          error: error.message,
          code: error.code,
          safeToRetry: error.safeToRetry,
        }, origin)
      }
      if (error instanceof AccountSyncError) {
        return sendJson(response, error.status, {
          error: error.message,
          code: error.code,
        }, origin)
      }
      if (error instanceof ChatJobError) {
        return sendJson(response, error.status, {
          error: error.message,
          code: error.code,
          safeToRetry: error.safeToRetry,
        }, origin)
      }
      if (error instanceof DaemonLeaseError) {
        return sendJson(response, error.status, {
          error: error.message,
          code: error.code,
        }, origin)
      }
      if (error instanceof ChatImageError) {
        return sendJson(response, error.status, {
          error: error.message,
          code: error.code,
        }, origin)
      }
      if (error instanceof SupportRepairError) {
        return sendJson(response, error.status, supportRepairErrorPayload(error), origin)
      }
      if (error instanceof SupportValidationError) {
        return sendJson(response, error.status, {
          error: error.message,
          code: error.code,
        }, origin)
      }
      if (error instanceof GitWorkflowError) {
        return sendJson(response, error.status, {
          error: error.message,
          code: error.code,
        }, origin)
      }
      if (error instanceof TelegramBridgeError) {
        return sendJson(response, error.status, {
          error: error.message,
          code: error.code,
        }, origin)
      }
      if (error instanceof RemoteSshError) {
        return sendJson(response, error.status, {
          error: error.message,
          code: error.code,
          safeToRetry: error.safeToRetry,
        }, origin)
      }
      if (error instanceof VirtualBoxError) {
        return sendJson(response, error.status, {
          error: error.message,
          code: error.code,
          partialState: error.partialState,
        }, origin)
      }
      const message = error instanceof Error ? error.message : 'Unexpected Ensync Host error.'
      return sendJson(response, 500, { error: message }, origin)
    }
  })
  server.once('close', () => {
    void telegram.stopPolling?.()
    void syncBrokerHost.stop?.()
  })
  server.ensyncServices = { accountSync, chatImages, chatJobs, daemonLeases, projectIsolation }
  return server
}

// Compatibility alias for clients and tests using the prototype export name.
export const createRelayHost = createEnsyncHost

export function startEnsyncHost(options = {}) {
  const host = options.host ?? LOOPBACK_HOST
  const port = options.port ?? Number(process.env.ENSYNC_HOST_PORT || process.env.RELAY_HOST_PORT || DEFAULT_PORT)
  const server = createEnsyncHost(options)
  server.listen(port, host, () => {
    const address = server.address()
    const resolvedPort = typeof address === 'object' && address ? address.port : port
    console.log(`Ensync Host listening on http://${host}:${resolvedPort}`)
    const isolation = server.ensyncServices?.projectIsolation
    isolation?.recoverStrandedWorktrees?.().then((summary) => {
      if (summary.recovered.length > 0) {
        console.log(`Ensync recovered uncommitted agent work in ${summary.recovered.length} worktree(s).`)
      }
    }).catch((error) => {
      console.error('Ensync stranded-work recovery failed:', error instanceof Error ? error.message : error)
    })
  })
  return server
}

// Legacy environment variables and exports remain supported during the rename.
export const startRelayHost = startEnsyncHost

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) startEnsyncHost()
