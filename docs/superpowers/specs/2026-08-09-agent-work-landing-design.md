# Agent work landing & sync — design

Date: 2026-08-09
Status: approved (auto-commit + review-to-land, auto-sync at run start)

## Problem

Ensync's per-conversation worktree isolation works: no agent ever overwrites
another chat's files. But nothing makes agent work durable or visible. Verified
2026-08-09: ~43 agent worktrees under `agent-workspaces-v1/` all branch from the
single release commit `35642bf`, each carrying large uncommitted change sets that
exist nowhere else. A feature built in chat A lives only in chat A's working
tree; chat B branches from the stale baseline, cannot see it, and rebuilds or
ships over it. The user experiences this as "models running over each other's
work," across providers, even though nothing is ever deleted.

Fix direction (user-approved): make agent work durable (commit it) and visible
(a reviewed path back to `main`), not more locking.

Throughout this spec, "`main`" means the shared checkout's checked-out branch —
the baseline conversation worktrees branch from — discovered at operation time,
not a hardcoded branch name.

## Requirements

1. Work from any chat, on any provider, survives the run that produced it.
2. Every run starts from a baseline that includes all previously landed work.
3. Work reaches `main` only through an explicit user action with a clean-merge
   guarantee; Ensync never auto-merges into user history.
4. All flows are Host-owned Git and therefore provider-neutral.
5. Fail closed everywhere; never mutate the shared checkout except during the
   explicit Land action, and never mix agent merges into uncommitted user
   changes.
6. Existing stranded worktree work is recovered, not abandoned.

## Design

### 1. Run-end auto-commit (durability)

- At the end of every provider run — success, failure, timeout, cancel — the
  Host commits the worktree's tracked and non-ignored untracked changes to the
  conversation's `ensync/chat-…` branch, while still holding the workspace
  write lease.
- Failed/cancelled/timed-out runs commit too: partial mutations are exactly the
  state that must survive for reconciliation. The outcome is recorded in a
  structured commit message: outcome, provider, workspace key, Host job ID.
- Commits use a distinct `Ensync Agent` author and committer identity so agent
  commits are never attributed to the user.
- Empty diff → no commit.
- Crash recovery: if a previous run died before committing (Host crash), the
  next run start for that workspace commits the leftover dirty state first,
  labeled as a recovered snapshot.

### 2. Run-start auto-sync (freshness)

- After lease acquisition and before provider start, if `main` has commits the
  chat branch lacks, the Host merges `main` into the chat branch inside its
  worktree.
- Clean merge → run proceeds on the current baseline.
- Conflict → the merge is aborted, the run fails closed before any provider
  process starts, and the conversation reports the exact conflicting files.
- New conversations keep existing behavior: branch from shared `HEAD` with the
  temporary-index dirty-snapshot seed.
- Out of scope for v1: an explicit "let the agent resolve the conflict" run
  mode.

### 3. Landing (visibility on `main`)

- New "Unlanded work" section in the Git panel: every `ensync/chat-…` branch
  with commits ahead of `main`, showing chat title, last activity, ahead count,
  and changed-file summary.
- Land is an explicit per-branch user action, the same class as Push, so it may
  mutate the shared checkout.
- The Host verifies the merge is clean using plumbing (no checkout mutation
  during the check), then performs a real non-force merge commit onto `main`.
- Guards, both fail closed with factual messages:
  - Dirty shared checkout → landing refuses, reporting the dirty-file count.
  - Conflicting branch → Land is not offered; the UI directs the user to
    continue that chat (run-start auto-sync pulls `main` into the worktree,
    conflicts are resolved in agent territory), after which landing is clean.
- Landing never force-pushes, never deletes the chat branch, and never touches
  remotes. Push remains its own separately guarded flow.

### 4. One-time recovery of stranded worktrees

- A migration on upgrade commits each existing `agent-workspaces-v1/` worktree's
  uncommitted changes to its branch as a labeled recovered snapshot.
- All recovered branches appear in Unlanded work for review. Nothing is merged
  automatically.

### 5. Unchanged behavior

- Same conversation on any provider reuses the same worktree, branch, and write
  lease (existing behavior; isolation was never the bug).
- The shared checkout, index, current branch, and history are untouched outside
  the explicit Land action.
- Worktrees and branches remain durable after runs; nothing is auto-deleted.

## Error handling

- Every new Git operation runs under the existing fixed-executable,
  argument-array discipline; no shell construction.
- Auto-commit failure at run end is reported in the conversation as
  reconciliation-required state; the worktree still holds the changes.
- Auto-sync conflict, dirty-checkout landing, and conflicted landing all fail
  closed with specific file/count detail and no partial state left behind
  (aborted merges are fully aborted in the worktree; the landing check never
  starts a merge in the shared checkout it cannot complete).

## Testing

Host tests with temporary local repositories and bare remotes only:

- Run-end commit on success, failure, timeout, and cancel; structured message
  content; `Ensync Agent` identity; empty-diff no-op.
- Recovered-snapshot commit at run start after a simulated crash.
- Run-start clean merge advances the branch; conflict fails closed before
  provider start and reports files.
- Land: clean merge commits to `main`; refused on dirty shared checkout;
  refused (not offered) on conflict; never force, never remote.
- Migration commits every stranded dirty worktree and surfaces it as unlanded.

## Documentation updates

`.relay/features/git-workflows.md` and `.relay/architecture.md` currently state
that worktree changes remain uncommitted and that managed worktrees are only
reconciled manually; both must be revised to describe run-end auto-commit,
run-start auto-sync, and the Land flow.

## Out of scope

- The `/Applications/Ensync.app` install race (dev-process issue; landing fixes
  it indirectly because builds include landed work).
- Agent-driven conflict resolution runs.
- Auto-merge to `main` and shared integration branches (rejected approaches).
