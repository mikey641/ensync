import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const HOST_DAEMON_STATE_FILENAME = 'ensync-host-daemon-v1.json'
const DEVTOOLS_ACTIVE_PORT_FILENAME = 'DevToolsActivePort'
const DEFAULT_TIMEOUT_MS = 60_000

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

export function parseDevToolsActivePort(value) {
  if (typeof value !== 'string') return null
  const [portLine] = value.trim().split(/\r?\n/)
  const port = Number(portLine)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
}

export function selectEnsyncPageTarget(targets) {
  if (!Array.isArray(targets)) return null
  return targets.find((target) => {
    if (target?.type !== 'page' || typeof target.url !== 'string') return false
    try {
      const url = new URL(target.url)
      return url.protocol === 'ensync:' && url.hostname === 'app'
    } catch {
      return false
    }
  }) ?? null
}

export function validateHostDescriptor(value) {
  if (value?.version !== 1
    || value.apiVersion !== 1
    || !Number.isInteger(value.pid)
    || value.pid < 1
    || !Number.isInteger(value.port)
    || value.port < 1
    || value.port > 65_535
    || typeof value.token !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.token)
    || typeof value.instanceId !== 'string'
    || !value.instanceId) return null
  return value
}

export function validateHostHealth(value, descriptor) {
  return value?.ok === true
    && value.service === 'ensync-host'
    && value.apiVersion === 1
    && value.instanceId === descriptor?.instanceId
}

export async function findNamedFile(root, fileName, maxDepth = 4) {
  if (maxDepth < 0) return null
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name === fileName) return join(root, entry.name)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findNamedFile(join(root, entry.name), fileName, maxDepth - 1)
    if (found) return found
  }
  return null
}

async function waitForEvidence(label, operation, processState, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (processState.spawnError) throw processState.spawnError
    if (processState.exit) {
      const detail = processState.exit.signal ?? processState.exit.code ?? 'unknown'
      throw new Error(`Packaged Ensync exited before ${label} was verified (${detail}).`)
    }
    try {
      const value = await operation()
      if (value) return value
    } catch {
      // Startup files and loopback endpoints may exist before their contents are
      // complete. The bounded deadline remains authoritative.
    }
    await delay(250)
  }
  throw new Error(`Timed out waiting for packaged Ensync ${label}.`)
}

function terminateWindowsProcessTree(pid) {
  if (!Number.isInteger(pid) || pid < 1) return
  spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
    windowsHide: true,
    stdio: 'ignore',
  })
}

export async function runWindowsPackagedSmoke(options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    throw new Error('The packaged Windows smoke check must run on Windows.')
  }

  const desktopRoot = options.desktopRoot
    ?? resolve(fileURLToPath(new URL('..', import.meta.url)))
  const executablePath = options.executablePath
    ?? join(desktopRoot, 'release', 'win-unpacked', 'Ensync.exe')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const spawnImpl = options.spawnImpl ?? spawn
  await access(executablePath)

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ensync-windows-package-smoke-'))
  const appDataRoot = join(temporaryRoot, 'AppData', 'Roaming')
  const localAppDataRoot = join(temporaryRoot, 'AppData', 'Local')
  const chromiumDataRoot = join(temporaryRoot, 'Chromium')
  const processState = { exit: null, spawnError: null }
  let descriptor = null
  let child = null
  let exitPromise = Promise.resolve()

  try {
    child = spawnImpl(executablePath, [
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${chromiumDataRoot}`,
    ], {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        APPDATA: appDataRoot,
        LOCALAPPDATA: localAppDataRoot,
        USERPROFILE: temporaryRoot,
      },
      shell: false,
      stdio: 'ignore',
      windowsHide: false,
    })
    exitPromise = new Promise((resolveExit) => {
      child.once('error', (error) => {
        processState.spawnError = error
        resolveExit()
      })
      child.once('exit', (code, signal) => {
        processState.exit = { code, signal }
        resolveExit()
      })
    })

    const renderer = await waitForEvidence('renderer', async () => {
      const activePortPath = join(chromiumDataRoot, DEVTOOLS_ACTIVE_PORT_FILENAME)
      const port = parseDevToolsActivePort(await readFile(activePortPath, 'utf8'))
      if (!port) return null
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) return null
      const target = selectEnsyncPageTarget(await response.json())
      return target ? { port, target } : null
    }, processState, timeoutMs)

    const host = await waitForEvidence('Host health', async () => {
      const descriptorPath = await findNamedFile(
        temporaryRoot,
        HOST_DAEMON_STATE_FILENAME,
      )
      if (!descriptorPath) return null
      descriptor = validateHostDescriptor(JSON.parse(await readFile(descriptorPath, 'utf8')))
      if (!descriptor) return null
      const response = await fetch(`http://127.0.0.1:${descriptor.port}/api/health`, {
        headers: { Authorization: `Bearer ${descriptor.token}` },
        signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) return null
      const health = await response.json()
      return validateHostHealth(health, descriptor) ? health : null
    }, processState, timeoutMs)

    console.log(
      `Packaged Windows smoke check passed: ${renderer.target.url} loaded and ${host.service} API v${host.apiVersion} responded.`,
    )
    return {
      rendererUrl: renderer.target.url,
      hostService: host.service,
      hostApiVersion: host.apiVersion,
    }
  } finally {
    terminateWindowsProcessTree(child?.pid)
    terminateWindowsProcessTree(descriptor?.pid)
    await Promise.race([exitPromise, delay(5_000)])
    await rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    })
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  runWindowsPackagedSmoke().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
