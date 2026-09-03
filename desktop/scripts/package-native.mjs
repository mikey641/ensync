import { spawn } from 'node:child_process'
import { readFile, rm, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWindowsSigning } from './release-prerequisites.mjs'
import { resolveWindowsStorePackageConfig } from './windows-store.mjs'
import { writeBuildInfo } from './write-build-info.mjs'
import { stageAgentWorktree } from '../../scripts/stage-agent-worktree.mjs'

const platformIndex = process.argv.indexOf('--platform')
const platform = platformIndex >= 0 ? process.argv[platformIndex + 1] : null
if (!['macos', 'windows', 'windows-store'].includes(platform)) {
  throw new Error('Use --platform macos, windows, or windows-store.')
}
if (platform === 'macos' && process.platform !== 'darwin') {
  throw new Error('macOS artifacts must be packaged on macOS.')
}
if (platform.startsWith('windows') && process.platform !== 'win32') {
  throw new Error('Windows artifacts must be packaged on Windows.')
}

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageJson = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))

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
const windowsStore = platform === 'windows-store'
  ? resolveWindowsStorePackageConfig(process.env, { productVersion: packageJson.version })
  : null
if (windowsStore && (certificate || password)) {
  throw new Error('Windows Store packages must use Microsoft Store certification, not CSC_LINK signing inputs.')
}

const env = { ...process.env }
if (windowsStore || (!certificate && windowsSigning?.mode !== 'azure')) {
  // Prevent electron-builder from discovering an unrelated local identity. A
  // package is signed only when the documented certificate inputs are explicit.
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
} else {
  delete env.CSC_IDENTITY_AUTO_DISCOVERY
}
if (windowsStore) env.ENSYNC_WINDOWS_STORE_PACKAGE_VERSION = windowsStore.packageVersion

const buildInfo = await writeBuildInfo()
console.log(`Packaging build ${buildInfo.buildId} from ${buildInfo.sourceCommit} (${buildInfo.sourceDirty ? 'dirty' : 'clean'} ${buildInfo.channel}).`)
const toolsDirectory = join(desktopRoot, 'build', 'tools')
await rm(toolsDirectory, { recursive: true, force: true })
await stageAgentWorktree({
  repoRoot: resolve(desktopRoot, '..'),
  toolsDirectory,
  universalMac: platform === 'macos',
})
await unlink(join(desktopRoot, 'release', `attestation-${platform}.json`)).catch((error) => {
  if (error?.code !== 'ENOENT') throw error
})
const builderCli = resolve(desktopRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const args = platform === 'macos'
  ? [builderCli, '--mac', '--universal', '--publish', 'never']
  : platform === 'windows-store'
    ? [builderCli, '--win', 'appx', '--x64', '--publish', 'never']
    : [builderCli, '--win', '--x64', '--publish', 'never']

if (certificate || windowsSigning?.mode === 'azure') {
  args.push('--config.forceCodeSigning=true')
}
if (windowsSigning?.mode === 'azure') {
  for (const [name, value] of Object.entries(windowsSigning.azureSignOptions)) {
    args.push(`--config.win.azureSignOptions.${name}=${value}`)
  }
}
if (windowsStore) {
  args.push(
    '--config.appxManifestCreated=scripts/appx-manifest-created.cjs',
    `--config.appx.applicationId=${windowsStore.applicationId}`,
    `--config.appx.identityName=${windowsStore.identityName}`,
    `--config.appx.publisher=${windowsStore.publisher}`,
    `--config.appx.publisherDisplayName=${windowsStore.publisherDisplayName}`,
  )
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
