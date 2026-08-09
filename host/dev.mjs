import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const bundledSyncPort = process.env.ENSYNC_SYNC_PORT ?? '43122'
const bundledSyncUrl = `http://127.0.0.1:${bundledSyncPort}`
const syncServiceUrl = process.env.ENSYNC_SYNC_SERVICE_URL ?? bundledSyncUrl
const hostEnvironment = { ...process.env, ENSYNC_SYNC_SERVICE_URL: syncServiceUrl }
const children = [
  ...(process.env.ENSYNC_SYNC_SERVICE_URL ? [] : [
    spawn(process.execPath, [join(projectRoot, 'sync-service', 'server.mjs')], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    }),
  ]),
  // Keep the backend in sync with the Vite renderer during development. Without
  // Node's watcher, Host parser and recovery fixes do not take effect until the
  // entire dev stack is restarted, leaving the renderer connected to stale code.
  spawn(process.execPath, ['--watch', join(projectRoot, 'host', 'server.mjs')], {
    cwd: projectRoot,
    env: hostEnvironment,
    stdio: 'inherit',
  }),
  spawn(process.execPath, [join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')], {
    cwd: projectRoot,
    stdio: 'inherit',
  }),
]

let stopping = false
function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
  process.exitCode = exitCode
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (!stopping && (code !== 0 || signal)) stop(code ?? 1)
  })
  child.on('error', (error) => {
    console.error(error.message)
    stop(1)
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
