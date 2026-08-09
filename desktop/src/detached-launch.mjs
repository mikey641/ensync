import { spawn } from 'node:child_process'

/**
 * Start the development Electron shell outside the npm/terminal process group.
 * Packaged Ensync is already launched by the operating system; this protects
 * only source-tree launches from a temporary PTY or agent session ending.
 */
export async function launchDetachedElectron(options) {
  const {
    electronPath,
    appPath,
    cwd,
    environment = process.env,
    spawnImpl = spawn,
  } = options ?? {}
  if (typeof electronPath !== 'string' || !electronPath
    || typeof appPath !== 'string' || !appPath
    || typeof cwd !== 'string' || !cwd) {
    throw new TypeError('Electron, app, and working-directory paths are required.')
  }

  const child = spawnImpl(electronPath, [appPath], {
    cwd,
    detached: true,
    env: environment,
    shell: false,
    stdio: 'ignore',
    windowsHide: false,
  })

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      child.off('spawn', onSpawn)
      reject(error)
    }
    const onSpawn = () => {
      child.off('error', onError)
      resolve()
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
  child.unref()
  return { pid: child.pid ?? null }
}
