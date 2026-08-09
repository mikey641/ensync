---
name: Git workflows
description: Real repository import, remote verification, status, and guarded push behavior.
---

# Git workflows

Ensync Host owns Git operations for the focused local project. The browser never builds a shell command and never collects or stores a Git service token. The host launches the fixed `git` executable with a separate argument array and relies on the computer's existing Git credential helper or SSH agent.

## Agent workspaces

Coding agents do not mutate the focused shared checkout. For each stable workspace/conversation key, Ensync Host creates or reuses a durable `ensync/chat-…` branch in a managed Git worktree, maps a selected repository subdirectory to the same location inside that worktree, and reports the protected identity in the conversation. Git before/after continuation status is read from that worktree. The selected canonical path remains the project identity for navigation and explicit user Git operations.

The renderer persists an explicit `conversation:<chat-id>` agent-workspace key on the conversation before starting local or SSH execution. Chats already bound to a worktree under the former object-coerced key keep that exact key so an upgrade cannot orphan their branch or continuation state. A request with no key indicates a mixed-version client and fails before provider execution with an actionable quit-and-reopen upgrade error; malformed supplied keys still fail validation.

One renewable write lease in the repository's shared Git directory covers each conversation workspace for the entire provider run across local windows and Host processes. Different chats use different worktrees and run concurrently even inside the same repository; only duplicate runs targeting the same conversation workspace wait before provider start. For a first-time conversation, a dirty shared checkout is captured through a temporary private index and synthetic transport commit, used to seed the protected worktree, then immediately mixed-reset to the real base commit; the inherited tracked and non-ignored untracked files therefore remain uncommitted inside the protected workspace. The synthetic commit is not retained on the conversation branch, and the shared checkout, index, branch, and history remain untouched. Ensync never cleans, stashes, commits into user history, deletes, or auto-merges those changes into the user's own branches. Managed worktrees and branches survive run completion and failure so the user can verify and reconcile them before any future explicit cleanup workflow.

## Canonical workspace base

A protected worktree must never be seeded from a commit that the canonical branch has already moved past. Otherwise a later conversation starts from history that does not contain already-integrated work, and its agent reasonably concludes the work was never done. The Host enforces the base; a prompt-level instruction cannot, because base selection happens before any agent starts.

Before creating or resuming a workspace, Ensync resolves a canonical base from the repository's own configured remote. It selects `origin`, or the single configured remote when there is exactly one, and validates every configured URL for that remote against the same location allowlist used for verification and push, so a repository-configured external helper can never execute. It then fetches that remote's refs under a repository-scoped lock in the shared Git directory, deduplicated by a short freshness window so simultaneous conversations in one checkout share a single real fetch. The canonical branch is the remote's symbolic HEAD, then its `main` or `master` remote ref.

Ensync advances the base past the shared checkout's own commit only when that commit is already contained by the fetched canonical commit. Every other relationship keeps the shared checkout commit and records an explicit reason: a checkout that is ahead of the canonical branch, divergent history, a feature checkout whose commits are not on the canonical branch, an unsafe or missing remote URL, no single configured remote, a missing fetched ref, or a failed fetch. A fetch failure is reported and never fatal, so an offline computer still starts from the last fetched reference instead of being blocked.

When the base has moved ahead and the shared checkout is dirty, the snapshot is replayed onto the canonical base as a patch against its own parent, not copied as a tree. A tree-level copy would present everything the base already contains as an agent deletion. If that replay conflicts, Ensync keeps the user's uncommitted work exactly as they left it on the shared checkout commit and reports the conflict instead of resolving it for them.

A resumed conversation worktree is brought onto the current canonical base by merge, never by rebase, so in-progress uncommitted agent work is never rewritten. Ensync refuses and reports instead of forcing whenever Git reports a conflict or an unfinished merge, cherry-pick, rebase, or revert in that worktree.

Every run reports its resolved base commit, canonical remote and branch, the exact reason when the base is not the canonical commit, and whether this conversation's committed work is already contained by the canonical branch. Ensync does not merge a conversation branch back automatically; unintegrated commits stay counted and visible rather than silently disappearing from the next workspace.

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
