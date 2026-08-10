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
import { readdir, readFile } from 'node:fs/promises'
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

/**
 * Conversations whose workspace write lease is currently held, meaning a run
 * is genuinely in flight. Every Ensync conversation keeps a permanent
 * worktree, so worktree existence proves nothing — using it as the "busy"
 * signal meant no chat branch could ever land. The Host heartbeats this lease
 * every 5s and treats it as abandoned after 30s, so a lease whose heartbeat
 * has gone quiet belongs to a finished or crashed run.
 */
async function leasedWorkspaceHashes(repoRoot, staleMs = 30_000) {
  const commonDir = await git(['rev-parse', '--git-common-dir'], { cwd: repoRoot })
  const lockRoot = join(commonDir.startsWith('/') ? commonDir : join(repoRoot, commonDir), 'ensync', 'workspace-write-locks')
  const held = new Set()
  let entries
  try {
    entries = await readdir(lockRoot)
  } catch {
    return held
  }
  for (const entry of entries) {
    if (!entry.endsWith('.lock')) continue
    try {
      const owner = JSON.parse(await readFile(join(lockRoot, entry, 'owner.json'), 'utf8'))
      const heartbeat = Date.parse(owner?.heartbeatAt ?? '')
      if (Number.isFinite(heartbeat) && Date.now() - heartbeat < staleMs) {
        held.add(entry.slice(0, -'.lock'.length))
      }
    } catch {
      // An unreadable or half-written lease is not proof of an active run.
    }
  }
  return held
}

/** A worktree with uncommitted changes may hold work no commit has captured. */
async function worktreePathsByBranch(repoRoot) {
  const paths = new Map()
  try {
    const list = await git(['worktree', 'list', '--porcelain'], { cwd: repoRoot })
    let current = null
    for (const line of list.split('\n')) {
      if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
      else if (line.startsWith('branch ') && current) {
        paths.set(line.slice('branch '.length).replace(/^refs\/heads\//, ''), current)
      }
    }
  } catch {
    // Without the list every branch is simply treated as having no worktree.
  }
  return paths
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
  const invoke = () => execFile('npm', ['run', 'land:check'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: LAND_CHECK_TIMEOUT_MS,
  })
  // Timing-sensitive tests can fail under the load of concurrent agent runs.
  // A flaky red would roll back a good merge, so a failure is confirmed by a
  // second run; a genuine break fails both times.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await invoke()
      return { ok: true }
    } catch (error) {
      if (error.killed || error.signal) {
        return { ok: false, reason: 'land:check did not finish within its time limit' }
      }
      if (attempt === 2) {
        const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim()
        return { ok: false, reason: 'land:check failed twice', output: output.slice(-2_000) }
      }
      console.log(`[${repoName}]   land:check failed; confirming with a second run...`)
    }
  }
  return { ok: false, reason: 'land:check failed twice' }
}

async function run() {
  const repoRoot = await git(['rev-parse', '--show-toplevel'])
  const repoName = repoRoot.split('/').pop()
  const remote = await hasRemote()
  const leased = await leasedWorkspaceHashes(repoRoot)
  const worktrees = await worktreePathsByBranch(repoRoot)

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
    const workspaceHash = /^ensync\/chat-([0-9a-f]{24})$/.exec(branch)?.[1] ?? null
    if (workspaceHash && leased.has(workspaceHash)) {
      console.log(`[${repoName}] Skipping ${branch} — a run holds its workspace lease.`)
      active += 1
      continue
    }
    const worktreePath = worktrees.get(branch)
    if (worktreePath && !(await checkoutIsClean(worktreePath))) {
      console.log(`[${repoName}] Skipping ${branch} — its worktree has uncommitted changes.`)
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
