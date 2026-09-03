#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGENT_WORKTREE_VERSION = '0.13.6'

const PLATFORM_PACKAGES = Object.freeze({
  'darwin-arm64': '@nekocode/agent-worktree-darwin-arm64',
  'darwin-x64': '@nekocode/agent-worktree-darwin-x64',
  'linux-x64': '@nekocode/agent-worktree-linux-x64',
  'win32-x64': '@nekocode/agent-worktree-win32-x64',
})

function requiredAbsolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} must be an absolute path.`)
  }
  return value
}

async function runCommand(executable, args, options = {}) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) return resolveRun({ stdout, stderr })
      rejectRun(new Error(`${basename(executable)} failed (${signal ?? code ?? 'unknown'}): ${stderr.trim() || stdout.trim() || 'no output'}`))
    })
  })
}

async function fetchPinnedPackage({ packageName, repoRoot }) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ensync-agent-worktree-package-'))
  try {
    const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const packed = await runCommand(npmExecutable, [
      'pack',
      `${packageName}@${AGENT_WORKTREE_VERSION}`,
      '--ignore-scripts',
      '--prefer-offline',
      '--json',
      '--pack-destination',
      temporaryRoot,
    ], { cwd: repoRoot })
    const packResult = JSON.parse(packed.stdout)
    const filename = Array.isArray(packResult) ? packResult[0]?.filename : null
    if (typeof filename !== 'string' || basename(filename) !== filename) {
      throw new Error(`npm did not return a safe archive name for ${packageName}.`)
    }
    const extractedRoot = join(temporaryRoot, 'extracted')
    await mkdir(extractedRoot, { recursive: true })
    await runCommand('/usr/bin/tar', [
      '-xzf',
      join(temporaryRoot, filename),
      '-C',
      extractedRoot,
    ])
    return {
      packageRoot: join(extractedRoot, 'package'),
      cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

async function verifiedPackage(repoRoot, packageName, options = {}) {
  let packageRoot = join(repoRoot, 'node_modules', ...packageName.split('/'))
  let cleanup = null
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT' || !options.fetchMissing) throw error
    const fetched = await (options.fetchPackage ?? fetchPinnedPackage)({ packageName, repoRoot })
    packageRoot = requiredAbsolutePath(fetched.packageRoot, `${packageName} package root`)
    cleanup = fetched.cleanup ?? null
    manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  }
  if (manifest.name !== packageName || manifest.version !== AGENT_WORKTREE_VERSION) {
    await cleanup?.()
    throw new Error(
      `${packageName} runtime must be the exact ${AGENT_WORKTREE_VERSION} package; found ${manifest.name ?? 'unknown'}@${manifest.version ?? 'unknown'}.`,
    )
  }
  return { packageRoot, cleanup }
}

async function combineUniversalMac({ arm64, x64, destination }) {
  await runCommand('/usr/bin/lipo', ['-create', arm64, x64, '-output', destination])
}

export async function stageAgentWorktree(options = {}) {
  const repoRoot = requiredAbsolutePath(options.repoRoot, 'repository root')
  const toolsDirectory = requiredAbsolutePath(options.toolsDirectory, 'tools directory')
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const packageName = PLATFORM_PACKAGES[`${platform}-${arch}`]
  if (!packageName) throw new Error(`Unsupported platform for agent-worktree: ${platform}-${arch}.`)

  const executableName = platform === 'win32' ? 'wt.exe' : 'wt'
  const destination = join(toolsDirectory, executableName)
  const staging = `${destination}.${process.pid}.staging`
  await mkdir(dirname(destination), { recursive: true })
  const cleanups = []
  try {
    if (platform === 'darwin' && options.universalMac) {
      const packages = {}
      for (const candidateArch of ['arm64', 'x64']) {
        const candidateName = PLATFORM_PACKAGES[`darwin-${candidateArch}`]
        packages[candidateArch] = await verifiedPackage(repoRoot, candidateName, {
          fetchMissing: true,
          fetchPackage: options.fetchPackage,
        })
        if (packages[candidateArch].cleanup) cleanups.push(packages[candidateArch].cleanup)
      }
      await (options.combineUniversal ?? combineUniversalMac)({
        arm64: join(packages.arm64.packageRoot, 'bin', 'wt'),
        x64: join(packages.x64.packageRoot, 'bin', 'wt'),
        destination: staging,
      })
    } else {
      const resolved = await verifiedPackage(repoRoot, packageName)
      await copyFile(join(resolved.packageRoot, 'bin', executableName), staging)
    }
    if (platform !== 'win32') await chmod(staging, 0o755)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  } finally {
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()))
  }
  try {
    await rename(staging, destination)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
    await rm(destination, { force: true })
    await rename(staging, destination)
  }
  return destination
}

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1]
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const output = argumentValue('--output')
  if (!output) throw new Error('Use --output <absolute tools directory>.')
  const staged = await stageAgentWorktree({ repoRoot: repositoryRoot, toolsDirectory: resolve(output) })
  process.stdout.write(`${staged}\n`)
}
