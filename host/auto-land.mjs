import { landAgentBranch, pushLandedBaseline, runGit } from './git.mjs'

const AGENT_MERGE_IDENTITY = {
  GIT_AUTHOR_NAME: 'Ensync Agent',
  GIT_AUTHOR_EMAIL: 'agent@ensync.local',
  GIT_COMMITTER_NAME: 'Ensync Agent',
  GIT_COMMITTER_EMAIL: 'agent@ensync.local',
}

// `<<<<<<< `/`>>>>>>> ` at line start. `=======` alone is skipped because it is
// a legitimate Markdown underline; an unresolved conflict always keeps its
// opening or closing marker too.
const CONFLICT_MARKER_PATTERN = '^(<{7}|>{7})( |$)'

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
}

async function git(args, options = {}) {
  return runGit(args, {
    cwd: options.cwd,
    env: options.env,
    gitExecutable: options.gitExecutable,
    timeoutMs: options.timeoutMs,
  })
}

async function mergeInProgress(worktreePath, options) {
  const result = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { ...options, cwd: worktreePath })
  return result.exitCode === 0
}

async function unmergedFiles(worktreePath, options) {
  const result = await git(['diff', '--name-only', '--diff-filter=U'], { ...options, cwd: worktreePath })
  if (result.exitCode !== 0) return null
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

export async function abortMergeInProgress(worktreePath, options = {}) {
  if (!(await mergeInProgress(worktreePath, options))) return false
  const aborted = await git(['merge', '--abort'], { ...options, cwd: worktreePath })
  return aborted.exitCode === 0
}

/**
 * Starts the baseline merge inside the protected worktree so a conflict can be
 * resolved in agent territory. A clean merge completes immediately; a content
 * conflict is left in progress (MERGE_HEAD and conflict markers present) for
 * the conflict-resolution agent run; anything else is aborted and reported.
 */
export async function startBaselineMerge(worktreePath, baselineSha, branch, options = {}) {
  const env = {
    ...AGENT_MERGE_IDENTITY,
    GIT_AUTHOR_DATE: new Date().toISOString(),
    GIT_COMMITTER_DATE: new Date().toISOString(),
  }
  const merge = await git(
    ['-c', 'commit.gpgsign=false', 'merge', '--no-edit', '--no-verify',
      '-m', `Ensync conflict resolution: merge ${baselineSha} into ${branch}`, baselineSha],
    { ...options, cwd: worktreePath, env },
  )
  if (merge.exitCode === 0) return { completed: true, conflicted: false, conflictFiles: [] }

  const conflicted = await mergeInProgress(worktreePath, options)
  const conflictFiles = conflicted ? await unmergedFiles(worktreePath, options) : []
  if (!conflicted || !Array.isArray(conflictFiles) || conflictFiles.length === 0) {
    await abortMergeInProgress(worktreePath, options)
    return {
      completed: false,
      conflicted: false,
      conflictFiles: [],
      reason: firstLine(merge.stderr) || firstLine(merge.stdout) || 'Git could not start the baseline merge in the protected worktree.',
    }
  }
  return { completed: false, conflicted: true, conflictFiles }
}

/**
 * Verifies and concludes a conflict-resolution agent run. The merge counts as
 * resolved only when no unmerged paths remain, the previously conflicted files
 * carry no leftover conflict markers, and the resulting commit contains the
 * baseline commit. While MERGE_HEAD still exists the failure is abortable —
 * `git merge --abort` restores the branch's committed state exactly.
 */
export async function concludeBaselineMerge(worktreePath, branch, baselineSha, conflictFiles, options = {}) {
  const stillMerging = await mergeInProgress(worktreePath, options)
  const unresolved = await unmergedFiles(worktreePath, options)
  if (!Array.isArray(unresolved)) {
    return { ok: false, abortable: stillMerging, reason: 'Git could not inspect the protected worktree after conflict resolution.' }
  }
  if (unresolved.length > 0) {
    return {
      ok: false,
      abortable: stillMerging,
      reason: `Conflicts remain unresolved in: ${unresolved.join(', ')}.`,
    }
  }

  const markerPathspecs = conflictFiles.map((file) => `:(top)${file}`)
  if (stillMerging) {
    if (markerPathspecs.length > 0) {
      const markers = await git(
        ['grep', '-l', '-E', CONFLICT_MARKER_PATTERN, '--', ...markerPathspecs],
        { ...options, cwd: worktreePath },
      )
      if (markers.exitCode === 0) {
        const files = markers.stdout.split(/\r?\n/).filter(Boolean)
        return {
          ok: false,
          abortable: true,
          reason: `Conflict markers are still present in: ${files.join(', ')}.`,
        }
      }
    }
    const env = {
      ...AGENT_MERGE_IDENTITY,
      GIT_AUTHOR_DATE: new Date().toISOString(),
      GIT_COMMITTER_DATE: new Date().toISOString(),
    }
    const staged = await git(['add', '-A', '--', '.'], { ...options, cwd: worktreePath, env })
    if (staged.exitCode !== 0) {
      return { ok: false, abortable: true, reason: firstLine(staged.stderr) || 'Git could not stage the resolved merge.' }
    }
    const committed = await git(
      ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--no-edit'],
      { ...options, cwd: worktreePath, env },
    )
    if (committed.exitCode !== 0) {
      return { ok: false, abortable: true, reason: firstLine(committed.stderr) || `Git could not conclude the merge on ${branch}.` }
    }
  } else {
    // The agent concluded the merge itself. Commit any leftover working-tree
    // changes so verification inspects exactly what would land.
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { ...options, cwd: worktreePath })
    if (status.stdout.split('\0').filter(Boolean).length > 0) {
      const env = {
        ...AGENT_MERGE_IDENTITY,
        GIT_AUTHOR_DATE: new Date().toISOString(),
        GIT_COMMITTER_DATE: new Date().toISOString(),
      }
      await git(['add', '-A', '--', '.'], { ...options, cwd: worktreePath, env })
      await git(
        ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', `Ensync conflict resolution: merge ${baselineSha} into ${branch}`],
        { ...options, cwd: worktreePath, env },
      )
    }
    if (markerPathspecs.length > 0) {
      const markers = await git(
        ['grep', '-l', '-E', CONFLICT_MARKER_PATTERN, 'HEAD', '--', ...markerPathspecs],
        { ...options, cwd: worktreePath },
      )
      if (markers.exitCode === 0) {
        const files = markers.stdout.split(/\r?\n/).filter(Boolean)
        return {
          ok: false,
          abortable: false,
          reason: `Conflict markers were committed in: ${files.join(', ')}.`,
        }
      }
    }
  }

  const contained = await git(['merge-base', '--is-ancestor', baselineSha, 'HEAD'], { ...options, cwd: worktreePath })
  if (contained.exitCode !== 0) {
    return {
      ok: false,
      abortable: false,
      reason: `The conflict-resolution run did not merge baseline commit ${baselineSha} into ${branch}.`,
    }
  }
  return { ok: true }
}

async function tryLand(landInput, landOptions) {
  try {
    const result = await landAgentBranch(landInput, landOptions)
    return { landed: true, result }
  } catch (error) {
    return {
      landed: false,
      code: typeof error?.code === 'string' ? error.code : 'agent_branch_land_failed',
      message: error instanceof Error ? error.message : 'Git could not land the agent branch.',
      files: Array.isArray(error?.files) ? error.files : [],
      verification: error?.verification ?? null,
    }
  }
}

/**
 * Publishing after a verified land is best-effort: a repository without a
 * remote lands silently, and any push failure becomes a notice so the finished
 * run and the land itself are never affected.
 */
async function pushLandedWork(workspace, options, notify) {
  if (options.autoPush !== true) return { pushed: false }
  const result = await pushLandedBaseline(workspace.canonicalProjectPath, {
    allowedRoots: options.allowedRoots,
    gitExecutable: options.gitExecutable,
  })
  if (result.pushed) {
    notify('agent_work_pushed', `Pushed ${result.branch} to ${result.remote} after landing.`)
  } else if (result.code !== 'git_remote_not_found') {
    notify('auto_push_failed', `The landed work could not be pushed automatically: ${result.reason ?? result.code} Push manually when ready.`)
  }
  return result
}

async function commitWorktreeLeftovers(worktreePath, message, options) {
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { ...options, cwd: worktreePath })
  if (status.stdout.split('\0').filter(Boolean).length === 0) return
  const env = {
    ...AGENT_MERGE_IDENTITY,
    GIT_AUTHOR_DATE: new Date().toISOString(),
    GIT_COMMITTER_DATE: new Date().toISOString(),
  }
  await git(['add', '-A', '--', '.'], { ...options, cwd: worktreePath, env })
  await git(['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', message], { ...options, cwd: worktreePath, env })
}

/**
 * Lands a verified successful run's conversation branch through the same
 * guarded Land operation the explicit user action uses. A dirty shared
 * checkout or any non-conflict refusal leaves the branch unlanded with a
 * notice; a conflict pre-check failure hands the conflict to a
 * conflict-resolution agent run in the protected worktree, verifies it, and
 * retries the land exactly once. This function reports outcomes and never
 * throws into the finished run.
 */
export async function autoLandWorkspace(workspace, options = {}) {
  const branch = workspace.branch
  const notify = (code, message) => {
    try {
      options.onNotice?.(code, message)
    } catch { /* notices are best-effort */ }
  }
  const gitOptions = { gitExecutable: options.gitExecutable }
  let landWaitNotified = false
  const landInput = { projectPath: workspace.canonicalProjectPath, branch }
  const landOptions = {
    allowedRoots: options.allowedRoots,
    gitExecutable: options.gitExecutable,
    verifyLand: options.verifyLand,
    signal: options.signal,
    landLeaseOptions: options.landLeaseOptions,
    onWait: () => {
      if (landWaitNotified) return
      landWaitNotified = true
      notify('repository_land_waiting', `Waiting for another Ensync conversation to finish landing into ${workspace.shared?.repositoryPath ?? 'the repository'}. Protected work stays on ${branch}.`)
    },
  }

  const first = await tryLand(landInput, landOptions)
  if (first.landed) {
    notify('agent_work_landed', `Automatically landed ${branch} into ${first.result.land.mergedInto} as merge ${first.result.land.mergeHead.slice(0, 12)}.`)
    const push = await pushLandedWork(workspace, options, notify)
    return { landed: true, resolvedConflicts: false, pushed: push.pushed === true, land: first.result.land }
  }
  if (first.code === 'agent_branch_already_landed') {
    return { landed: false, code: first.code }
  }
  if (first.code === 'shared_checkout_dirty') {
    notify('auto_land_skipped', `Automatic landing skipped: ${first.message} The work stays on ${branch} for explicit review and landing.`)
    return { landed: false, code: first.code }
  }
  if (first.code === 'agent_branch_verification_failed') {
    return autoRepairFailedLandCheck(workspace, first, { ...options, gitOptions, landInput, landOptions, notify })
  }
  if (first.code !== 'agent_branch_conflicts') {
    notify('auto_land_failed', `Automatic landing of ${branch} did not complete: ${first.message} The work stays on ${branch} for explicit review and landing.`)
    return { landed: false, code: first.code }
  }
  if (typeof options.runConflictAgent !== 'function') {
    notify('auto_land_failed', `Automatic landing of ${branch} did not complete: ${first.message}`)
    return { landed: false, code: first.code }
  }

  notify(
    'auto_land_conflict',
    `Landing ${branch} would conflict with the baseline in: ${first.files.join(', ') || 'unknown files'}. Ensync is starting a conflict-resolution agent run in the protected worktree.`,
  )
  const worktreePath = workspace.repositoryPath
  const sharedHead = await git(['rev-parse', '--verify', 'HEAD'], { ...gitOptions, cwd: workspace.shared.repositoryPath })
  if (sharedHead.exitCode !== 0) {
    notify('auto_land_failed', `Automatic landing of ${branch} did not complete: Git could not read the shared checkout's baseline commit.`)
    return { landed: false, code: 'agent_branch_land_failed' }
  }
  const baselineSha = firstLine(sharedHead.stdout)

  const merge = await startBaselineMerge(worktreePath, baselineSha, branch, gitOptions)
  if (!merge.completed && !merge.conflicted) {
    notify('auto_land_failed', `Automatic landing of ${branch} did not complete: ${merge.reason} The work stays on ${branch} for explicit review and landing.`)
    return { landed: false, code: 'baseline_merge_failed' }
  }
  if (!merge.completed) {
    try {
      if (options.signal?.aborted) throw new Error('The run was cancelled before conflict resolution started.')
      await options.runConflictAgent({
        worktreePath,
        branch,
        baselineSha,
        conflictFiles: merge.conflictFiles,
      })
    } catch (error) {
      await abortMergeInProgress(worktreePath, gitOptions)
      notify(
        'auto_land_failed',
        `The conflict-resolution agent run did not succeed: ${error instanceof Error ? error.message : 'unknown error'} ${branch} stays unlanded for review; its committed work is unchanged.`,
      )
      return { landed: false, code: 'conflict_resolution_failed' }
    }
    const concluded = await concludeBaselineMerge(worktreePath, branch, baselineSha, merge.conflictFiles, gitOptions)
    if (!concluded.ok) {
      if (concluded.abortable) await abortMergeInProgress(worktreePath, gitOptions)
      notify(
        'auto_land_failed',
        `Conflict resolution could not be verified: ${concluded.reason} ${branch} stays unlanded for review.`,
      )
      return { landed: false, code: 'conflict_resolution_unverified' }
    }
  }

  const second = await tryLand(landInput, landOptions)
  if (second.landed) {
    notify('agent_work_landed', `Automatically landed ${branch} into ${second.result.land.mergedInto} after resolving baseline conflicts in the protected worktree.`)
    const push = await pushLandedWork(workspace, options, notify)
    return { landed: true, resolvedConflicts: true, pushed: push.pushed === true, land: second.result.land }
  }
  notify('auto_land_failed', `Automatic landing of ${branch} still did not complete after conflict resolution: ${second.message} The work stays on ${branch} for explicit review and landing.`)
  return { landed: false, code: second.code }
}

/**
 * A land that merged cleanly but failed the repository's land check was rolled
 * back by landAgentBranch. The failure is handed to a repair agent run inside
 * the protected worktree — with the baseline already merged in so the agent
 * sees exactly the tree that failed — and the land is retried exactly once;
 * the retry re-verifies, so an unrepaired failure stays unlanded.
 */
async function autoRepairFailedLandCheck(workspace, first, context) {
  const branch = workspace.branch
  const { gitOptions, landInput, landOptions, notify } = context
  if (typeof context.runRepairAgent !== 'function') {
    notify('auto_land_failed', `Automatic landing of ${branch} did not complete: ${first.message}`)
    return { landed: false, code: first.code }
  }

  notify(
    'auto_land_check_failed',
    `${first.message} Ensync is starting a land-check repair agent run in the protected worktree.`,
  )
  const worktreePath = workspace.repositoryPath
  const sharedHead = await git(['rev-parse', '--verify', 'HEAD'], { ...gitOptions, cwd: workspace.shared.repositoryPath })
  if (sharedHead.exitCode !== 0) {
    notify('auto_land_failed', `Automatic landing of ${branch} did not complete: Git could not read the shared checkout's baseline commit.`)
    return { landed: false, code: 'agent_branch_land_failed' }
  }
  const baselineSha = firstLine(sharedHead.stdout)

  const merge = await startBaselineMerge(worktreePath, baselineSha, branch, gitOptions)
  if (!merge.completed) {
    // The land pre-check found no conflicts moments ago, so a conflicted or
    // failed baseline merge here means the baseline moved; stay bounded and
    // leave the branch for the next run's ordinary conflict path.
    await abortMergeInProgress(worktreePath, gitOptions)
    notify('auto_land_failed', `Automatic landing of ${branch} did not complete: the protected worktree could not be prepared for the land-check repair. The work stays on ${branch} for explicit review and landing.`)
    return { landed: false, code: first.code }
  }

  try {
    if (context.signal?.aborted) throw new Error('The run was cancelled before the land-check repair started.')
    await context.runRepairAgent({
      worktreePath,
      branch,
      baselineSha,
      reason: first.message,
      output: first.verification?.output ?? null,
    })
  } catch (error) {
    notify(
      'auto_land_failed',
      `The land-check repair agent run did not succeed: ${error instanceof Error ? error.message : 'unknown error'} ${branch} stays unlanded for review; its committed work is unchanged.`,
    )
    return { landed: false, code: 'land_check_repair_failed' }
  }
  await commitWorktreeLeftovers(worktreePath, `Ensync land check repair: ${branch}`, gitOptions)

  const second = await tryLand(landInput, landOptions)
  if (second.landed) {
    notify('agent_work_landed', `Automatically landed ${branch} into ${second.result.land.mergedInto} after repairing the failed land check in the protected worktree.`)
    const push = await pushLandedWork(workspace, context, notify)
    return { landed: true, resolvedConflicts: false, repairedLandCheck: true, pushed: push.pushed === true, land: second.result.land }
  }
  notify('auto_land_failed', `Automatic landing of ${branch} still did not complete after the land-check repair: ${second.message} The work stays on ${branch} for explicit review and landing.`)
  return { landed: false, code: second.code }
}
