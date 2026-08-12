---
name: Git workflows
description: Real repository import, remote verification, status, and guarded push behavior.
---

# Git workflows

Ensync Host owns Git operations for the focused local project. The browser never builds a shell command and never collects or stores a Git service token. The host launches the fixed `git` executable with a separate argument array and relies on the computer's existing Git credential helper or SSH agent.

## Agent workspaces

Coding agents do not mutate the focused shared checkout. For each stable workspace/conversation key, Ensync Host creates or reuses a durable `ensync/chat-…` branch in a managed Git worktree, maps a selected repository subdirectory to the same location inside that worktree, and reports the protected identity in the conversation. Git before/after continuation status is read from that worktree. The selected canonical path remains the project identity for navigation and explicit user Git operations.

The renderer persists an explicit `conversation:<chat-id>` agent-workspace key on the conversation before starting local or SSH execution. Chats already bound to a worktree under the former object-coerced key keep that exact key so an upgrade cannot orphan their branch or continuation state. A request with no key indicates a mixed-version client and fails before provider execution with an actionable quit-and-reopen upgrade error; malformed supplied keys still fail validation.

One renewable write lease in the repository's shared Git directory covers each conversation workspace for the entire provider run across local windows and Host processes. Local lease heartbeats serialize their ticks and replace `owner.json` atomically, so readers cannot observe a truncate-before-write record and falsely abort a run as lost ownership under filesystem load. Different chats use different worktrees and run concurrently even inside the same repository; only duplicate runs targeting the same conversation workspace wait before provider start. For a first-time conversation, a dirty shared checkout is captured through a temporary private index and synthetic transport commit, used to seed the protected worktree, then immediately mixed-reset to the real shared `HEAD`; the inherited tracked and non-ignored untracked files remain uncommitted inside the protected workspace until that conversation's first run ends. The synthetic commit is not retained on the conversation branch, and the shared checkout, index, branch, and history remain untouched. A reused worktree that is already dirty at run start is committed first, on the conversation branch, as recovered work before the provider starts. Before the provider starts, a reused conversation branch also merges the current baseline branch (the shared checkout's checked-out branch, discovered at operation time); a conflict aborts the merge and fails the run closed before any provider process starts, listing the conflicting files. For local executions, every run end — success, failure, timeout, or cancellation — commits the worktree's tracked and non-ignored untracked changes to the conversation branch as `Ensync Agent <agent@ensync.local>`, recording the run outcome (succeeded, failed, timed out, or cancelled) in the commit message; an empty diff commits nothing. This run-end auto-commit, the run-start dirty-worktree recovery above, and the run-start baseline-branch merge above all currently apply to local executions only: SSH runs receive the same seeded protected worktree and branch but do not yet auto-commit at run end or sync the baseline branch at run start — a named follow-up. Ensync never cleans, stashes, deletes, or auto-merges the shared checkout; it commits into user history only through the guarded Land operation described below — explicit, or automatic after a verified successful local run. Managed worktrees and branches survive run completion and failure so the user can verify and reconcile them before landing.

## Landing

Land is the guarded, per-branch merge operation — the same class of operation as Push — and it is the only way agent work reaches the shared checkout's history. It requires a clean shared checkout and a conflict-free plumbing pre-check of the merge that never mutates the checkout while checking; a dirty shared checkout refuses the Land with the dirty-file count. A successful Land produces one non-force `Ensync land: <branch>` merge commit on the baseline branch. Land never touches configured remotes and never deletes the conversation branch; Push remains its own, separately guarded flow. Land runs two ways: as the explicit per-branch user action, and automatically at the end of eligible runs as described below. In the explicit flow, a conflicting branch is not offered for Land at all — the user continues that chat so run-start baseline sync merges the current baseline branch into the worktree and the conflict is resolved in agent territory before landing is clean.

### Automatic landing

When a local run ends verified-successful and its run-end auto-commit succeeds, Ensync Host attempts the same guarded Land for that conversation branch automatically, while it still holds the conversation's workspace write lease. Only that combination is eligible: failed, cancelled, timed-out, and ambiguous runs, runs whose auto-commit failed, and all SSH runs keep their branches unlanded for explicit review. A dirty shared checkout skips automatic landing with a notice and never touches user work; a branch with nothing new to land is skipped silently. Automatic landing is on by default and can be disabled host-wide with `ENSYNC_AUTO_LAND=0` (or the `autoLandAgentWork` host option). It is also a user preference: the renderer's Automatic landing settings toggle (on by default, persisted with the workspace snapshot) travels with each local run request as its optional boolean `autoLand` field, and `autoLand: false` keeps that run's branch unlanded for explicit review. Because the shared Host daemon outlives any one window, the preference is carried per request rather than stored host-side; a request can opt out of landing but never re-enable it when the host-wide switch has it off.

When the conflict pre-check reports content conflicts — the baseline moved while the run was active — Ensync resolves them in agent territory. It starts the baseline merge inside that conversation's protected worktree, leaves the conflicted merge in progress, and runs a conflict-resolution agent run there: same provider, fresh session, same workspace containment, prompted only to resolve and conclude that merge. The resolution is verified before anything lands: the provider process must exit successfully with a parseable completed result, no unmerged paths may remain, the previously conflicted files must carry no leftover conflict markers, and the concluded merge commit must contain the baseline commit. Only then is the Land retried, exactly once. If the agent run or any verification step fails, the in-progress merge is aborted so the branch's committed work is restored unchanged, and the branch stays unlanded with an explanatory notice. Automatic-landing failures are reported as notices and never change the finished run's own outcome or response.

## Repository import

- Import requires an allowlisted HTTP, HTTPS, SSH, or Git-protocol URL, a strict `user@host:path` SSH location, or an absolute local repository path.
- Relative repository paths, credentials embedded in HTTP URLs, `file::`, `ext::`, unknown external remote helpers, control characters, and option-like locations are rejected before Git starts.
- The destination must be an absolute path for a new folder whose parent exists. Ensync canonicalizes the parent, rejects filesystem roots and existing destinations, and enforces configured host project roots.
- A successful clone is inspected by Ensync Host and becomes the focused project using the canonical path returned by the filesystem.

## Status and connection

Status is derived from real Git commands and reports the repository root, checked-out branch or detached state, configured upstream, exact ahead/behind counts when Git has them, dirty state, changed-file count, and configured fetch/push remotes. The production branch is discovered from the selected remote's symbolic HEAD, then `main` or `master` remote refs; otherwise it remains unknown until the user supplies it.

Remote verification runs `git ls-remote --symref` non-interactively against the selected configured remote. It uses only credentials already available to Git. Ensync reports the connection as verified only after that command succeeds. Before verification or push, every configured URL for the selected remote is checked against the same location allowlist so a repository-configured external helper cannot execute.

## Push policy

The default mode pushes the checked-out non-production branch to the same branch name on the selected remote and sets its upstream. If the checked-out branch is the discovered production branch, safe mode refuses the push and asks the user to switch to a feature branch or use the guarded production flow.

Direct production push sends the current commit to the chosen production branch without force. It requires all of the following in both UI and host request:

1. Explicit production mode.
2. A valid production branch.
3. The server-side `allowProduction` flag.
4. The exact typed confirmation `PUSH TO <branch>`.

Push means a Git branch update, not a guaranteed deployment. It may trigger deployment only when the remote repository is configured to deploy from that branch.

Tests must use temporary local repositories and bare remotes. They must never push a real external repository.
