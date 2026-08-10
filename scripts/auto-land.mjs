#!/usr/bin/env node
/**
 * Auto-land all unlanded ensync/chat-* branches into main.
 *
 * Pulls origin/main, merges every ensync/chat-* branch that has unmerged
 * commits (using -X theirs for content conflicts, keeping branch files for
 * modify/delete conflicts), then pushes the result back to origin.
 *
 * Run manually after agent work sessions:
 *   node scripts/auto-land.mjs
 *
 * Or set up as a cron job / launchd task to run periodically.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

async function git(args, opts = {}) {
  const { stdout } = await execFile('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts })
  return stdout.trim()
}

async function run() {
  console.log('Pulling origin/main...')
  try {
    await git(['pull', 'origin', 'main', '--no-edit', '--ff-only'])
  } catch (error) {
    console.error('Pull failed (may need manual rebase):', error.message)
    process.exit(1)
  }

  // List all ensync/chat-* branches with unmerged commits
  const branches = (await git(['branch', '--list', 'ensync/chat-*']))
    .split('\n')
    .map((line) => line.replace(/^\*?\s+/, '').trim())
    .filter(Boolean)

  let merged = 0
  let skipped = 0

  for (const branch of branches) {
    const ahead = parseInt(await git(['rev-list', '--count', `HEAD..${branch}`]), 10)
    if (ahead === 0) {
      skipped++
      continue
    }

    console.log(`\nMerging ${branch} (${ahead} commits ahead)...`)
    try {
      await git(['merge', branch, '--no-edit', '-X', 'theirs'], { stdio: 'pipe' })
      console.log(`  OK`)
      merged++
    } catch {
      // Handle modify/delete conflicts by keeping the branch's files
      console.log('  Resolving modify/delete conflicts...')
      await git(['add', '-A'])
      await git(['commit', '--no-edit', '-m', `Merge ${branch}`], { stdio: 'pipe' })
      console.log(`  RESOLVED`)
      merged++
    }
  }

  console.log(`\n${merged} branch(es) merged, ${skipped} already up to date.`)

  if (merged > 0) {
    console.log('Pushing to origin...')
    try {
      await git(['push', 'origin', 'main'])
      console.log('Pushed.')
    } catch (error) {
      console.error('Push failed:', error.message)
      process.exit(1)
    }
  } else {
    console.log('Nothing to push.')
  }
}

run().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
