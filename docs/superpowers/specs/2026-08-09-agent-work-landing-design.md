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
7. Worktree containment works with any catalog provider — Codex, Claude Code,
   Kimi Code, or a future runner — as a declared, verified per-provider
   capability, never a single-vendor special case.

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

### 5. Worktree containment (provider-neutral)

The landing/sync mechanisms above need no provider cooperation: they are
Host-owned Git operations that run before the provider process spawns and after
it exits. The only place agent obedience matters is staying inside the
protected worktree, which today rests on `cwd` plus one prompt instruction.
Containment therefore becomes a required entry in the existing catalog-wide
provider capability contract, alongside discovery, authentication, billing,
sessions, and cancellation:

Prompt confinement (`cwd` plus the isolation instruction at `host/chat.mjs`
and `host/remote-ssh-bridge.mjs`) is advisory. It is a strong nudge to a
cooperative model, not a security boundary, and no Ensync surface may imply
otherwise.

**Layer 1 — universal detection (v1, every provider, local and SSH).** The
Host snapshots the canonical shared checkout before and after every run:
`HEAD` hash plus `git status --porcelain` output hash. For SSH runs the
bridge takes the same snapshot on the remote canonical checkout. If the
snapshot changed during the run and the change was not Ensync's own explicit
Land operation, the run's persisted metadata records a
`shared_checkout_changed` fact and the execution panel and conversation
surface it prominently — without attribution, because the user may have
edited or committed concurrently and Ensync never claims unobserved causes.
One signature escalates to a stronger warning because it is near-certainly
destructive: previously-dirty tracked files reverting to `HEAD` content with
no new commit containing their changes (the `git checkout .` shape, which
silently corrupts the seed future first-time conversations inherit).
Deliberate deviation from reviewer feedback: detection does not
auto-block later runs, because legitimate concurrent user edits and commits
would constantly trip a block on an actively-used checkout and an
unattributable fact must not lock the user out; visibility plus the
escalated destructive-shape warning is v1 behavior.

**Layer 2 — per-provider containment capability (fail closed).** Every
catalog provider records exactly one verified containment level in the
existing catalog-wide capability contract, alongside discovery,
authentication, billing, sessions, and cancellation:

- `os_sandbox` — the CLI offers OS-enforced write restriction the Host can
  pin per run to the protected worktree.
- `permission_config` — the CLI offers machine-configurable permission rules
  the Host can pin per run, with any residual gaps stated factually.
- `prompt_only` — `cwd` plus the isolation instruction is all the CLI
  supports; recorded as a fact, never implied to be enforcement.

A provider without a recorded containment level is refused as runnable —
this is a design rule, not just a test expectation. Kimi Code, Copilot,
Cursor, and every other discovery-only provider cannot become runnable until
the enablement audit records its containment level; no provider is silently
omitted. The Host always applies the strongest verified mechanism as fixed,
allowlisted arguments scoped to the protected worktree. The renderer never
chooses or edits containment arguments.

Runnable today: Codex is pinned to its OS sandbox in workspace-write mode
with the worktree as the writable root, after first-party re-verification
against the existing exec/resume/steer flows. Claude Code is pinned to
per-run permission settings denying file mutation outside the worktree and
recorded as `permission_config` with its headless-shell gap stated honestly.

**Layer 3 — Host-owned generic OS sandbox (roadmap, platform-dependent).** A
Host-applied OS-level wrapper (macOS Seatbelt first) that confines any local
provider process to the worktree regardless of native CLI support, making
native sandboxes defense-in-depth rather than the mechanism. It is not the
v1 primitive because it cannot be universal: Windows offers no comparable
wrapper for arbitrary CLIs, and SSH runs execute on the remote machine where
a local wrapper cannot reach — both facts recorded per-platform rather than
papered over. Layer 1 is the guarantee that exists everywhere.

### 6. Unchanged behavior

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
- Containment: Codex launch arguments include the pinned sandbox scoped to the
  worktree on new, resumed, and steered runs; Claude launch includes the pinned
  per-run permission settings; fixed arguments are not renderer-editable; a
  provider without a recorded containment level is refused as runnable.
- Detection: a change to the canonical checkout during a run is recorded and
  surfaced without attribution; an Ensync Land during the run is excluded; the
  destructive reversion shape (dirty files reverting with no commit containing
  them) produces the escalated warning; the SSH bridge snapshot exercises the
  same contract against a remote repository fixture.

## Documentation updates

`.relay/features/git-workflows.md` and `.relay/architecture.md` currently state
that worktree changes remain uncommitted and that managed worktrees are only
reconciled manually; both must be revised to describe run-end auto-commit,
run-start auto-sync, and the Land flow. `.relay/features/agent-routing.md`'s
provider capability contract gains containment as a required audited
capability, and the dated provider research must record each provider's
containment mechanism before its runner is enabled.

## Out of scope

- The `/Applications/Ensync.app` install race (dev-process issue; landing fixes
  it indirectly because builds include landed work).
- Agent-driven conflict resolution runs.
- Auto-merge to `main` and shared integration branches (rejected approaches).
