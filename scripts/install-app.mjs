#!/usr/bin/env node
/**
 * Installs the CURRENT CHECKOUT into /Applications/Ensync.app.
 *
 * This exists so installing is a consequence of landing, never a step a
 * conversation performs from its own branch. Chats used to build and install
 * straight from their worktree, so whichever chat installed last won and
 * unlanded work silently replaced landed work — the installed app could hold
 * code that was on no branch, and the next install from main would revert it
 * with no trace. The sweep calls this only after a merge has passed
 * land:check, so what runs is always something that landed.
 *
 * Refuses to install anything unverified: the checkout must be clean and must
 * be the repository's baseline branch. It ships the renderer bundle, the host
 * modules and the daemon bootstrap (both copies — the bundle keeps its own
 * copy of host-bootstrap.mjs), re-signs, and stops there. It never restarts
 * anything: the running daemon retires itself when its source changes, and app
 * windows pick the renderer up on their next launch.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { access, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const APP_PATH = process.env.ENSYNC_APP_PATH ?? '/Applications/Ensync.app'
const BUILD_TIMEOUT_MS = 10 * 60 * 1_000

async function run(command, args, options = {}) {
  return execFile(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: BUILD_TIMEOUT_MS,
    ...options,
  })
}

async function git(args, cwd) {
  const { stdout } = await run('git', args, { cwd })
  return stdout.trim()
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function installApp({ repoRoot, appPath = APP_PATH, log = console.log } = {}) {
  if (!(await exists(appPath))) {
    log(`[install] ${appPath} is not installed; skipping.`)
    return { installed: false, reason: 'app_not_installed' }
  }

  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoRoot)
  if (status.split('\0').filter(Boolean).length > 0) {
    log('[install] Checkout is dirty; refusing to install unverified files.')
    return { installed: false, reason: 'checkout_dirty' }
  }
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)
  if (branch !== 'main') {
    log(`[install] On ${branch}, not main; refusing to install from a conversation branch.`)
    return { installed: false, reason: 'not_baseline_branch' }
  }

  log('[install] Building renderer...')
  await run('npm', ['run', 'build'], { cwd: repoRoot })

  const resources = join(appPath, 'Contents', 'Resources')
  const backup = await mkdtemp(join(tmpdir(), 'ensync-app-backup-'))
  await cp(join(resources, 'ui'), join(backup, 'ui'), { recursive: true })
  await cp(join(resources, 'host'), join(backup, 'host'), { recursive: true })
  log(`[install] Previous bundle backed up to ${backup}`)

  try {
    await run('rsync', ['-a', '--delete', `${join(repoRoot, 'dist')}/`, `${join(resources, 'ui')}/`])
    await run('rsync', ['-a', '--delete', '--exclude=*.test.mjs', `${join(repoRoot, 'host')}/`, `${join(resources, 'host')}/`])
    // electron-builder maps desktop/src/host-bootstrap.mjs to this top-level
    // copy; syncing only host/ leaves the daemon entry point behind.
    await run('cp', [join(repoRoot, 'desktop', 'src', 'host-bootstrap.mjs'), join(resources, 'desktop-host-bootstrap.mjs')])
    await run('codesign', ['--force', '--deep', '--sign', '-', appPath])
    await run('codesign', ['--verify', '--strict', appPath])
  } catch (error) {
    log(`[install] FAILED (${error.message}); restoring the previous bundle.`)
    await run('rsync', ['-a', '--delete', `${join(backup, 'ui')}/`, `${join(resources, 'ui')}/`])
    await run('rsync', ['-a', '--delete', `${join(backup, 'host')}/`, `${join(resources, 'host')}/`])
    await run('codesign', ['--force', '--deep', '--sign', '-', appPath]).catch(() => {})
    return { installed: false, reason: 'install_failed', backup }
  }

  await rm(backup, { recursive: true, force: true }).catch(() => {})
  log('[install] Installed and signed. The daemon retires itself; app windows update on next launch.')
  return { installed: true }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = await git(['rev-parse', '--show-toplevel'], process.cwd())
  const result = await installApp({ repoRoot })
  if (!result.installed && result.reason === 'install_failed') process.exit(1)
}
