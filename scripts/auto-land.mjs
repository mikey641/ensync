#!/usr/bin/env node
/**
 * Auto-land all unlanded ensync/chat-* branches into main.
 *
 * Pulls origin/main (if a remote is configured), merges every ensync/chat-*
 * branch that has unmerged commits (using -X theirs for content conflicts,
 * keeping branch files for modify/delete conflicts), then pushes the result
 * back to origin (if a remote is configured).
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

async function run() {
  const repoRoot = await git(['rev-parse', '--show-toplevel'])
  const repoName = repoRoot.split('/').pop()
  const remote = await hasRemote()

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

  for (const branch of branches) {
    const ahead = parseInt(await git(['rev-list', '--count', `HEAD..${branch}`]), 10)
    if (ahead === 0) {
      skipped++
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
    console.log(`[${repoName}] ${merged} merged, ${skipped} already up to date.`)
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
    console.log(`[${repoName}] Nothing to merge (${skipped} already up to date).`)
  }
}

run().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
