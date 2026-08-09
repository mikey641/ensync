import { spawn } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWindowsSigning } from './release-prerequisites.mjs'
import { writeBuildInfo } from './write-build-info.mjs'

const platformIndex = process.argv.indexOf('--platform')
const platform = platformIndex >= 0 ? process.argv[platformIndex + 1] : null
if (!['macos', 'windows'].includes(platform)) {
  throw new Error('Use --platform macos or --platform windows.')
}
if (platform === 'macos' && process.platform !== 'darwin') {
  throw new Error('macOS artifacts must be packaged on macOS.')
}
if (platform === 'windows' && process.platform !== 'win32') {
  throw new Error('Windows artifacts must be packaged on Windows.')
}

const certificate = process.env.CSC_LINK
const password = process.env.CSC_KEY_PASSWORD
if (Boolean(certificate) !== Boolean(password)) {
  throw new Error('CSC_LINK and CSC_KEY_PASSWORD must be supplied together.')
}
const windowsSigning = platform === 'windows'
  ? resolveWindowsSigning({
      ...process.env,
      WINDOWS_CSC_LINK: certificate,
      WINDOWS_CSC_KEY_PASSWORD: password,
    })
  : null

const env = { ...process.env }
if (!certificate && windowsSigning?.mode !== 'azure') {
  // Prevent electron-builder from discovering an unrelated local identity. A
  // package is signed only when the documented certificate inputs are explicit.
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
} else {
  delete env.CSC_IDENTITY_AUTO_DISCOVERY
}

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const buildInfo = await writeBuildInfo()
console.log(`Packaging build ${buildInfo.buildId} from ${buildInfo.sourceCommit} (${buildInfo.sourceDirty ? 'dirty' : 'clean'} ${buildInfo.channel}).`)
await unlink(join(desktopRoot, 'release', `attestation-${platform}.json`)).catch((error) => {
  if (error?.code !== 'ENOENT') throw error
})
const builderCli = resolve(desktopRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const args = platform === 'macos'
  ? [builderCli, '--mac', '--universal', '--publish', 'never']
  : [builderCli, '--win', '--x64', '--publish', 'never']

if (certificate || windowsSigning?.mode === 'azure') {
  args.push('--config.forceCodeSigning=true')
}
if (windowsSigning?.mode === 'azure') {
  for (const [name, value] of Object.entries(windowsSigning.azureSignOptions)) {
    args.push(`--config.win.azureSignOptions.${name}=${value}`)
  }
}

const child = spawn(process.execPath, args, {
  cwd: desktopRoot,
  env,
  shell: false,
  stdio: 'inherit',
  windowsHide: true,
})
const result = await new Promise((resolveExit, rejectExit) => {
  child.once('error', rejectExit)
  child.once('exit', (code, signal) => {
    if (code === 0) resolveExit()
    else rejectExit(new Error(`electron-builder failed (${signal ?? code ?? 'unknown'}).`))
  })
})
await result
