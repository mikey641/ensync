---
name: Git workflows
description: Real repository import, remote verification, status, and guarded push behavior.
---

# Git workflows

Ensync Host owns Git operations for the focused local project. The browser never builds a shell command and never collects or stores a Git service token. The host launches the fixed `git` executable with a separate argument array and relies on the computer's existing Git credential helper or SSH agent.

## Agent workspaces

Coding agents do not mutate the focused shared checkout. For each stable workspace/conversation key, Ensync Host creates or reuses a durable `ensync/chat-…` branch in a managed Git worktree, maps a selected repository subdirectory to the same location inside that worktree, and reports the protected identity in the conversation. Git before/after continuation status is read from that worktree. The selected canonical path remains the project identity for navigation and explicit user Git operations.

The renderer persists an explicit `conversation:<chat-id>` agent-workspace key on the conversation before starting local or SSH execution. Chats already bound to a worktree under the former object-coerced key keep that exact key so an upgrade cannot orphan their branch or continuation state. A request with no key indicates a mixed-version client and fails before provider execution with an actionable quit-and-reopen upgrade error; malformed supplied keys still fail validation.

One renewable write lease in the repository's shared Git directory covers each conversation workspace for the entire provider run across local windows and Host processes. Different chats use different worktrees and run concurrently even inside the same repository; only duplicate runs targeting the same conversation workspace wait before provider start. For a first-time conversation, a dirty shared checkout is captured through a temporary private index and synthetic transport commit, used to seed the protected worktree, then immediately mixed-reset to the real shared `HEAD`; the inherited tracked and non-ignored untracked files remain uncommitted inside the protected workspace until that conversation's first run ends. The synthetic commit is not retained on the conversation branch, and the shared checkout, index, branch, and history remain untouched. A reused worktree that is already dirty at run start is committed first, on the conversation branch, as recovered work before the provider starts. Before the provider starts, a reused conversation branch also merges the current baseline branch (the shared checkout's checked-out branch, discovered at operation time); a conflict aborts the merge and fails the run closed before any provider process starts, listing the conflicting files. Every run end — success, failure, timeout, or cancellation — commits the worktree's tracked and non-ignored untracked changes to the conversation branch as `Ensync Agent <agent@ensync.local>`, recording the run outcome (succeeded, failed, timed out, or cancelled) in the commit message; an empty diff commits nothing. Ensync never cleans, stashes, deletes, or auto-merges the shared checkout; it commits into user history only through the explicit Land action described below. Managed worktrees and branches survive run completion and failure so the user can verify and reconcile them before landing.

## Landing

Land is an explicit, per-branch user action — the same class of operation as Push — and it is the only way agent work reaches the shared checkout's history. It requires a clean shared checkout and a conflict-free plumbing pre-check of the merge that never mutates the checkout while checking; a dirty shared checkout refuses the Land with the dirty-file count, and a conflicting branch is not offered for Land at all — the user continues that chat so run-start baseline sync merges the current baseline branch into the worktree and the conflict is resolved in agent territory before landing is clean. A successful Land produces one non-force `Ensync land: <branch>` merge commit on the baseline branch. Land never touches configured remotes and never deletes the conversation branch; Push remains its own, separately guarded flow.

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
