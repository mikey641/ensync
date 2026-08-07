import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const children = [
  spawn(process.execPath, [join(projectRoot, 'host', 'server.mjs')], {
    cwd: projectRoot,
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
