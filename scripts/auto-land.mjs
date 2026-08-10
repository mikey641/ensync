#!/usr/bin/env node
/**
 * Catch-up sweep that lands completed ensync/chat-* branches into main.
 *
 * The Host lands each conversation's work when its run finishes; this sweep
 * exists only for branches whose conversation ended without landing (a crashed
 * run, a quit app, a daemon restart).
 *
 * SAFETY — this script previously merged with `-X theirs` and, when that
 * failed, ran `git add -A && git commit`. That silently discarded main's side
 * of every conflicting hunk and committed unresolved conflict markers, which
 * is what repeatedly deleted working code (declarations whose usages survived,
 * whole functions, entire imports) and broke the app. Never reintroduce
 * either. The rules now:
 *   - A real merge with no "pick a side" strategy. Any conflict aborts and
 *     leaves the branch for the Host's conflict-resolution agent.
 *   - After a merge, the repository's own `land:check` must pass on the
 *     merged tree; a failure resets to the pre-merge commit.
 *   - Never merge into a dirty checkout, and never touch a branch that is
 *     checked out in a worktree (an agent may still be working in it).
 *   - Push only what was verified, never with force.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const LAND_CHECK_TIMEOUT_MS = 15 * 60 * 1_000

async function git(args, opts = {}) {
  const { stdout } = await execFile('git', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  })
  return stdout.trim()
}

async function gitOk(args, opts = {}) {
  try {
    await git(args, opts)
    return true
  } catch {
    return false
  }
}

async function hasRemote() {
  try {
    return (await git(['remote'])).length > 0
  } catch {
    return false
  }
}

/** Branches checked out in any worktree — an agent may still be writing there. */
async function activeWorktreeBranches() {
  try {
    const list = await git(['worktree', 'list', '--porcelain'])
    const active = new Set()
    for (const line of list.split('\n')) {
      if (!line.startsWith('branch ')) continue
      const branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      if (branch) active.add(branch)
    }
    return active
  } catch {
    return new Set()
  }
}

async function checkoutIsClean(repoRoot) {
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repoRoot })
  return status.split('\0').filter(Boolean).length === 0
}

async function landCheck(repoRoot, repoName) {
  let scripts
  try {
    scripts = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))?.scripts
  } catch {
    return { ok: true, skipped: true }
  }
  if (typeof scripts?.['land:check'] !== 'string' || !scripts['land:check'].trim()) {
    return { ok: true, skipped: true }
  }
  console.log(`[${repoName}]   Running land:check...`)
  try {
    await execFile('npm', ['run', 'land:check'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: LAND_CHECK_TIMEOUT_MS,
    })
    return { ok: true }
  } catch (error) {
    if (error.killed || error.signal) {
      // An infrastructure problem must not block landing or silently pass it.
      return { ok: false, reason: 'land:check did not finish within its time limit' }
    }
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim()
    return { ok: false, reason: 'land:check failed', output: output.slice(-2_000) }
  }
}

async function run() {
  const repoRoot = await git(['rev-parse', '--show-toplevel'])
  const repoName = repoRoot.split('/').pop()
  const remote = await hasRemote()
  const activeBranches = await activeWorktreeBranches()

  if (!(await checkoutIsClean(repoRoot))) {
    console.log(`[${repoName}] Checkout is dirty — skipping this sweep so nothing merges over local work.`)
    return
  }

  if (remote && !(await gitOk(['pull', 'origin', 'main', '--no-edit', '--ff-only']))) {
    console.log(`[${repoName}] Fast-forward pull failed; continuing with local branches.`)
  }

  const branches = (await git(['branch', '--list', 'ensync/chat-*']))
    .split('\n')
    .map((line) => line.replace(/^[*+]\s+/, '').trim())
    .filter(Boolean)

  let merged = 0
  let upToDate = 0
  let active = 0
  let refused = 0

  for (const branch of branches) {
    const ahead = Number.parseInt(await git(['rev-list', '--count', `HEAD..${branch}`]), 10) || 0
    if (ahead === 0) {
      upToDate += 1
      continue
    }
    if (activeBranches.has(branch)) {
      active += 1
      continue
    }

    const before = await git(['rev-parse', 'HEAD'])
    console.log(`[${repoName}] Merging ${branch} (${ahead} ahead)...`)
    const mergeOk = await gitOk(
      ['-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', `Ensync land: ${branch}`, branch],
      { cwd: repoRoot },
    )
    if (!mergeOk) {
      await gitOk(['merge', '--abort'], { cwd: repoRoot })
      console.log(`[${repoName}]   CONFLICT — left for the conversation's resolution agent.`)
      refused += 1
      continue
    }

    const verified = await landCheck(repoRoot, repoName)
    if (!verified.ok) {
      await git(['reset', '--hard', before], { cwd: repoRoot })
      console.error(`[${repoName}]   ROLLED BACK ${branch}: ${verified.reason}`)
      if (verified.output) console.error(verified.output)
      refused += 1
      continue
    }
    console.log(`[${repoName}]   LANDED${verified.skipped ? ' (no land:check defined)' : ' and verified'}`)
    merged += 1
  }

  console.log(`[${repoName}] ${merged} landed, ${refused} refused, ${upToDate} up to date, ${active} active.`)
  if (merged > 0 && remote) {
    console.log(`[${repoName}] ${await gitOk(['push', 'origin', 'main'], { cwd: repoRoot }) ? 'Pushed.' : 'Push failed; landed locally.'}`)
  }
}

run().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
