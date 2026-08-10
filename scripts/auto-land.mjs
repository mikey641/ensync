#!/usr/bin/env node
/**
 * Auto-land completed ensync/chat-* branches into main.
 *
 * Pulls origin/main (if a remote is configured), merges every ensync/chat-*
 * branch that has unmerged commits AND is NOT checked out in an active
 * worktree (so agents working simultaneously are never interrupted), then
 * pushes the result back to origin (if a remote is configured).
 *
 * Safe to run on a schedule — exits cleanly when there is nothing to merge.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

async function git(args, opts = {}) {
  try {
    const { stdout } = await execFile('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts })
    return stdout.trim()
  } catch (error) {
    throw error
  }
}

async function hasRemote() {
  try {
    const remotes = await git(['remote'])
    return remotes.length > 0
  } catch {
    return false
  }
}

/** Branches currently checked out in a worktree — these are actively being worked on. */
async function activeWorktreeBranches() {
  try {
    const list = await git(['worktree', 'list', '--porcelain'])
    const active = new Set()
    for (const line of list.split('\n')) {
      if (line.startsWith('branch ')) {
        // Strip 'refs/heads/' prefix if present
        const branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
        if (branch) active.add(branch)
      }
    }
    return active
  } catch {
    return new Set()
  }
}

async function run() {
  const repoRoot = await git(['rev-parse', '--show-toplevel'])
  const repoName = repoRoot.split('/').pop()
  const remote = await hasRemote()
  const activeBranches = await activeWorktreeBranches()

  if (remote) {
    console.log(`[${repoName}] Pulling origin/main...`)
    try {
      await git(['pull', 'origin', 'main', '--no-edit', '--ff-only'])
    } catch (error) {
      console.error(`[${repoName}] Pull failed: ${error.message}`)
      // Continue anyway — we can still merge local branches.
    }
  }

  // List all ensync/chat-* branches
  const branches = (await git(['branch', '--list', 'ensync/chat-*']))
    .split('\n')
    .map((line) => line.replace(/^[\*\+]\s+/, '').trim())
    .filter(Boolean)

  let merged = 0
  let skipped = 0
  let active = 0

  for (const branch of branches) {
    const ahead = parseInt(await git(['rev-list', '--count', `HEAD..${branch}`]), 10)
    if (ahead === 0) {
      skipped++
      continue
    }

    // Skip branches that are checked out in an active worktree — an agent
    // is still working on them. They'll be landed once the worktree is gone.
    if (activeBranches.has(branch)) {
      console.log(`[${repoName}] Skipping ${branch} (${ahead} commits) — active worktree`)
      active++
      continue
    }

    console.log(`[${repoName}] Merging ${branch} (${ahead} commits ahead)...`)
    try {
      await git(['merge', branch, '--no-edit', '-X', 'theirs'], { stdio: 'pipe' })
      console.log(`[${repoName}]   OK`)
      merged++
    } catch {
      // Handle modify/delete conflicts by keeping the branch's files
      console.log(`[${repoName}]   Resolving conflicts...`)
      try {
        await git(['add', '-A'])
        await git(['commit', '--no-edit', '-m', `Merge ${branch}`], { stdio: 'pipe' })
        console.log(`[${repoName}]   RESOLVED`)
        merged++
      } catch {
        console.error(`[${repoName}]   FAILED to resolve ${branch}`)
        try { await git(['merge', '--abort']) } catch {}
      }
    }
  }

  if (merged > 0) {
    console.log(`[${repoName}] ${merged} merged, ${skipped} up to date, ${active} active (skipped).`)
    if (remote) {
      console.log(`[${repoName}] Pushing to origin...`)
      try {
        await git(['push', 'origin', 'main'])
        console.log(`[${repoName}] Pushed.`)
      } catch (error) {
        console.error(`[${repoName}] Push failed: ${error.message}`)
      }
    } else {
      console.log(`[${repoName}] No remote configured — merged locally only.`)
    }
  } else {
    console.log(`[${repoName}] Nothing to merge (${skipped} up to date, ${active} active).`)
  }
}

run().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
