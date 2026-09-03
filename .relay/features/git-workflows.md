---
name: Git workflows
description: Real repository import, remote verification, status, and guarded push behavior.
---

# Git workflows

Ensync Host owns Git operations for the focused local project. The browser never builds a shell command and never collects or stores a Git service token. The host launches the fixed `git` executable with a separate argument array and relies on the computer's existing Git credential helper or SSH agent.

## Agent workspaces

Coding agents do not mutate the focused shared checkout. For each stable workspace/conversation key, Ensync Host creates or reuses a durable `ensync/chat-…` branch in a managed Git worktree, maps a selected repository subdirectory to the same location inside that worktree, and reports the protected identity in the conversation. Git before/after continuation status is read from that worktree. The selected canonical path remains the project identity for navigation and explicit user Git operations.

The renderer persists an explicit `conversation:<chat-id>` agent-workspace key on the conversation before starting local or SSH execution. Chats already bound to a worktree under the former object-coerced key keep that exact key so an upgrade cannot orphan their branch or continuation state. A request with no key indicates a mixed-version client and fails before provider execution with an actionable quit-and-reopen upgrade error; malformed supplied keys still fail validation.

The pinned open-source `agent-worktree` CLI owns creation and durable location of new conversation worktrees. Ensync pins its private runtime config to empty hooks, empty copied files, and disabled automatic submodule cloning, because upstream 0.13.6 otherwise permits unbounded unsandboxed hooks and network cloning during these operations. Since that release has no per-command switch that can disable project config, a repository containing `.agent-worktree.toml` fails fast before `wt new` or `wt merge` rather than executing it with Host authority. The singleton Host keeps only a process-local owner map so a duplicate run for the exact same conversation fails immediately instead of waiting; different chats run concurrently. A dirty canonical checkout blocks creation before the provider starts and remains byte-for-byte unchanged. Ensync does not create filesystem workspace locks, poll for lock release, synthesize a transport commit, or merge a new shared baseline during admission. Existing registered legacy `ensync/chat-*` worktrees and branches are adopted non-destructively. Managed worktrees and branches survive run completion and failure.

## Automatic landing

A successful local turn is committed on its conversation branch and identified by that exact immutable SHA. The Host atomically appends the item to a checksummed landing journal, then marks the provider job complete immediately; repository integration never extends the chat spinner or pins the provider process.

The event-driven coordinator maintains one completion-order FIFO train per repository. The first completion starts integration on the next microtask. Completions arriving during that train are batched into the next train, while different repositories integrate concurrently. Each train gets a separate tool-owned worktree, applies item SHAs in order with `agent-worktree`, verifies commit ancestry and a clean index, runs `git diff --check` plus an optional bounded `land:quick`, and publishes the target branch once. Source conversation worktrees are never the integration workspace.

If an item conflicts, the integrator may invoke the same subscription-backed provider with a bounded conflict-only prompt inside the integration worktree. It must prove that all conflict markers are gone and verification passes before publishing. An unresolved item returns to durable retry state and is automatically retrained at startup or ahead of the next completion for that repository; later compatible items are still allowed to land. There is no automatic-landing toggle, environment opt-out, polling interval, filesystem repository lease, force merge, ours/theirs choice, or manual `Needs merge review` state.

## Repository creation

Ensync isolates every local agent run in a Git worktree, so a focused project that is not inside a repository cannot host one. Rather than refusing that project, Ensync Host creates what the run needs: `git init --initial-branch=main` in the project folder, then one `Initial commit` holding the files already in it. A folder that is already inside a repository is never re-initialized; a repository that exists with no commit gets only the missing first commit, made at that repository's own root so a partial tree is never committed into it. The commit uses the computer's configured Git identity and falls back to an Ensync identity only when Git has none. Nothing is pushed.

Creation runs automatically before local isolation, and the Git panel also offers it explicitly whenever status reports the focused project outside a repository. A host can keep the previous fail-closed behavior with `ENSYNC_AUTO_INIT_GIT=0` (or the `autoInitializeGitRepositories` host option); a non-Git project then refuses local agent execution with an explanation instead. A home directory is always refused as too broad to become one project repository, and remote SSH execution still requires a repository that already exists on the remote.

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
