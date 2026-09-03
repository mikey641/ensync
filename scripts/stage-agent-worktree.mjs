#!/usr/bin/env node
import { chmod, copyFile, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
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

export async function stageAgentWorktree(options = {}) {
  const repoRoot = requiredAbsolutePath(options.repoRoot, 'repository root')
  const toolsDirectory = requiredAbsolutePath(options.toolsDirectory, 'tools directory')
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const packageName = PLATFORM_PACKAGES[`${platform}-${arch}`]
  if (!packageName) throw new Error(`Unsupported platform for agent-worktree: ${platform}-${arch}.`)

  const packageRoot = join(repoRoot, 'node_modules', ...packageName.split('/'))
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.version !== AGENT_WORKTREE_VERSION) {
    throw new Error(`agent-worktree runtime must be ${AGENT_WORKTREE_VERSION}; found ${manifest.version ?? 'unknown'}.`)
  }

  const executableName = platform === 'win32' ? 'wt.exe' : 'wt'
  const source = join(packageRoot, 'bin', executableName)
  const destination = join(toolsDirectory, executableName)
  const staging = `${destination}.${process.pid}.staging`
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, staging)
  if (platform !== 'win32') await chmod(staging, 0o755)
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
