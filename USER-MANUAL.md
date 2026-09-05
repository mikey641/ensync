# Ensync — User Manual

A practical guide to running Ensync on your computer and controlling it from your phone.

---

## 1. What Ensync does

Ensync is a workspace for the coding agents you already subscribe to. Instead of juggling separate CLIs, editors, and merge steps, you write a conversation once and let Ensync:

1. Keep the **project, transcript, and task context** together across providers.
2. Run the agent inside a **protected Git worktree** so your real checkout is never a scratchpad.
3. Automatically **merge** the finished work (land) and optionally **push** and **deploy-verify** it (deliver).
4. Let you **start, follow, stop, and steer** that work from your phone.

Agents run through their **official CLIs** (Codex, Claude Code, Factory Droid). There is no silent fallback to a per-token API key.

---

## 2. Terminology

| Term | Meaning |
| --- | --- |
| **Provider** | A coding agent CLI (Codex, Claude Code, Factory Droid, …). |
| **Host** | The background service on your computer that runs providers, queues jobs, and owns merge/deploy state. |
| **Conversation / tab** | One durable chat with its own project, provider, model size, and execution state. |
| **Landing** | Automatically merging a finished turn's exact commit into the target branch. |
| **Delivery** | The state after landing: Saved → Landing → Pushed → Building → Production. |
| **Ensync Sync** | Optional self-hosted account service for encrypted sync and phone control. |
| **Pairing** | A one-time code that links your phone to a specific Host. |

---

## 3. Install and run the desktop app

### Requirements

- **Node.js 20** or newer.
- One or more installed, logged-in agent CLIs:
  - **Codex** ([install](https://developers.openai.com/codex/cli/))
  - **Claude Code** ([install](https://code.claude.com/docs/en/installation))
  - **Factory Droid** ([install](https://docs.factory.ai/cli/getting-started/quickstart))

### Run from source (no signed installer yet)

```bash
git clone https://github.com/mikey641/ensync
cd ensync
npm ci
npm --prefix desktop ci
npm --prefix desktop start
```

The packaged desktop app is a thin native shell: it starts the Ensync Host and serves the UI. There is no signed release yet, so everything runs locally from source. (macOS `npm --prefix desktop run package:mac` and Windows `npm --prefix desktop run package:win` create unsigned local test builds.)

### First launch

1. Open **Settings** (gear icon or `Cmd/Ctrl + ,`).
2. Review appearance and routing preferences (defaults work).
3. Use the **project switcher** to choose a folder (native picker) or type an absolute path.

---

## 4. Interface tour

- **Activity rail (left)** — new conversation, search, history, settings.
- **Conversation sidebar** — searchable list of your durable chats; resizable, can collapse.
- **Tab strip / split panes** — open one conversation as a tab or several as side-by-side resizable panes. Double-click a pane header to maximize; the hidden-pane shelf restores hidden tasks.
- **Conversation header** — provider picker (`Auto` or a fixed runner) and model-size picker.
- **Composer** — write a prompt and send. `Cmd/Ctrl+T` new tab, `Cmd/Ctrl+K` jump, `Cmd/Ctrl+W` close tab.
- **Command palette** — `Cmd/Ctrl+K` searches conversations and offers "New conversation" and "Open preferences".

---

## 5. Providers and accounts

Ensync discovers the signed-in CLIs on your computer through their official login commands. Nothing you do in Ensync signs you into a provider; you still log in through each vendor's own CLI.

- **Runnable today:** Codex, Claude Code, Factory Droid.
- **Discovery-only:** GitHub Copilot CLI (account verified, runner not ready), Cursor, Google Antigravity, Google Jules, Kimi Code, Kiro CLI, Junie CLI, GitLab Duo CLI, Warp Oz, Amp, Augment Auggie, Qoder CLI, CodeBuddy Code.
- **Local runtime:** Ollama (model discovery only; it is not a subscription runner).

A provider in the catalog can be **connected** (discovered + authenticated), **not installed**, or **installed but not ready**. Only the concrete state each CLI actually reports is shown.

---

## 6. Provider routing and model size

### Provider mode

- **Auto** (default) — the Host picks the first connected, tested runner in your saved priority that has verified remaining usage.
- **Fixed** — always use the provider you pinned.

### Model size

Applies to whichever supported runner runs the turn:

| Tier | What it sends |
| --- | --- |
| Provider default | no effort override (vendor default) |
| Small | low reasoning effort |
| Medium | medium |
| Large | high |
| XL | max |

### Automatic fallback

A **separate** setting from Auto. When enabled, Ensync may continue a run on the next eligible provider **only** when the Host proves the failure is safe to retry with zero observed tool/command/file activity. Timeouts, malformed output, and any work that may have mutated files are never replayed — they stop for your review.

---

## 7. Running an agent — what actually happens

1. You focus a project and send a prompt.
2. The Host validates and canonicalizes the path, then creates or reuses a **protected worktree** branched from your HEAD.
3. The provider runs with model API-key and paid-override environment variables stripped, passed the prompt over stdin, and accepts only structured results.
4. A watchdog times out a turn after 15 minutes of inactivity (plus an optional hard ceiling).
5. On success, the exact clean state is committed and anchored, and the chat is released immediately — without waiting for merge.

Your shared checkout is never the agent's workspace, and its uncommitted changes are never touched or synthesized.

### Landing (automatic merge)

One FIFO train per Git repository merges compatible completions in order. Conflicts are retried by subscription resolvers (Codex, Claude Code, Factory Droid) with durable backoff; compatible later work proceeds meanwhile. After a successful train, the target branch is auto-pushed (no force). A conflicted item retries without blocking other saved work.

### Delivery

Each prompt remembers its destination:

- **Production** (default) — merge, push, then verify a deployment artifact.
- **Protected branch only** — anchor the exact commit under a protected ref; never merge, push, or deploy.

Watch the per-chat delivery panel for `Saved → Landing → Pushed → Building → Production`.

---

## 8. Git workflows

- **Import repository** — clone an allowlisted URL and focus it.
- **Git status** — real branch, upstream, ahead/behind, dirty, and remotes.
- **Push** — guarded branch push, plus **Direct to production** with an explicit typed confirmation.
- Non-Git projects can be auto-initialized with `git init --initial-branch=main` and an initial commit (disable with `ENSYNC_AUTO_INIT_GIT=0`); home directories are refused.

---

## 9. Full settings reference

Open **Settings → Preferences**. Changes save automatically.

### Appearance
- **Theme** — System / Light / Dark.
- **Text size** — Comfortable / Large.
- **Task-finished indicator** — Small dot / Green header / Whole tab.

### Conversations
- **New conversation view** — Open as tab / Open in split pane.
- **New split pane position** — Beside current pane / At the end.

### Execution
- **Delivery destination** — Production / Protected branch only.
- **Ensync Auto Context** — opt-in continuity envelope across provider handoffs.
- **Automatic fallback** — toggle + ordered provider ranking.

### Updates
- **Agent updates** — Remind weekly / Automatic weekly / Manual only (for the installed provider CLIs).
- **Ensync updates** — Stable / Beta channel; only manual Check → Download → Open. Microsoft Store builds report "Managed by Store".

### Notifications
- **Agent alerts** — Off / Ringtone / Spoken text, with "answer needed" alerts, custom words, and a voice.

### Interface
- Toggle each section independently: **Activity rail, Title bar, Tab strip, Conversation sidebar, Conversation header, Composer and status**.

### Account & chat sync
- Create an account or sign in, sync now, or sign out. Username 3–32 characters, password 12–256 characters.

---

## 10. Remote execution

Open the **remote runtime** settings to choose where a task runs.

### This computer
The default: your local Host.

### Remote machine (SSH)
A public-key-only OpenSSH worker on another machine.

- Provide hostname/IP, username, port, an optional absolute identity-file path, and an absolute non-root project path.
- No passwords, key contents, passphrases, or tokens are collected. `StrictHostKeyChecking=yes` always.
- Only directly runnable **Codex** and **Claude Code** executables with a verified login are supported.
- Local attachments are blocked over SSH; remote automatic landing is unavailable.

### VirtualBox
A guided local Ubuntu VM.

- Discover `VBoxManage`, list VMs, and preview/provision an Ubuntu VM (CPU, RAM, disk, ISO, NAT, loopback SSH).
- Provisioning is a separate, explicit action (`CREATE VM <name>`), and starting is another (`START VM <name>`). The guest OS still has to be installed from the ISO afterward.
- Disable all VirtualBox mutations with `ENSYNC_ALLOW_VIRTUALBOX_MUTATION=0`.

---

## 11. Phone (mobile) setup

The mobile client is a Capacitor iOS/Android app **or** the same client installed as a web app.

### What you can do from the phone
- Sign into the same Ensync account.
- Claim a pairing code and see paired Hosts.
- Start a **Codex or Claude Code** job by entering the project's absolute path on the Host.
- Watch encrypted progress update live; **stop** and **steer** the run.

### Prerequisites
- A reachable, HTTPS **Ensync Sync** service (see §12).
- Desktop: sign into the same account and enable **Remote execution**, then generate a one-time pairing code.

### Option A — Install the PWA (no app store)

```bash
npm --prefix mobile ci
npm --prefix mobile run build
```

Host the generated `mobile/dist/` from any HTTPS static site, add that origin to `ENSYNC_SYNC_ALLOWED_ORIGINS`, then open the URL on the phone and choose **Add to Home Screen**. The PWA caches only its shell; every Sync request is network-first so job state always reflects the live Host.

### Option B — Native dev build

```bash
npm --prefix mobile run sync
npm --prefix mobile run open:ios      # macOS + Xcode
npm --prefix mobile run open:android  # Android Studio + Android SDK
```

### Pairing walkthrough
1. On the phone: enter the Sync URL, then create an account or sign in.
2. On the desktop: open account settings and generate a pairing code.
3. On the phone: enter the 8-character code in the **Pair** field.
4. Enter the Host project's absolute path, pick Codex or Claude Code, write the instruction, and **Run remotely**.
5. Use **Steer** to correct an active turn or **Stop** to cancel it.

Closing the app does not cancel a submitted job: the Host owns it durably and it keeps running.

### Mobile limitations
Host project discovery, attachments, approval UI, background push wake-up, OS-backed credential storage, and App Store / Play Store signing are not yet implemented.

---

## 12. Self-hosting Ensync Sync

Sync is three things: encrypted conversation documents, an execution broker for phone control, and device pairing. Deploy it yourself:

```bash
npm run sync-service
```

Environment:

- `ENSYNC_SYNC_PORT` (default 43122)
- `ENSYNC_SYNC_HOST` (default 127.0.0.1)
- `ENSYNC_SYNC_DATA_FILE` (default `.ensync-sync-data.json`)
- `ENSYNC_SYNC_ALLOWED_ORIGINS` — comma-separated extra browser origins

Requirements and behavior:

- Put it behind **HTTPS**; plain HTTP is accepted only for exact loopback addresses.
- Passwords are stored as scrypt hashes; workspace documents as AES-256-GCM envelopes. Sync never receives plaintext prompts, paths, results, attachment contents, or provider credentials.
- Bearer sessions expire (24 h), device tokens are hashed, and pairing codes expire after 10 minutes.
- Host login is memory-only: restarting the Host requires signing in again.

---

## 13. Telegram

Connect a private Telegram chat as a restricted remote control:

1. Create a bot with BotFather and paste the token in **Connect Telegram**.
2. Message the bot `/pair <CODE>` from the paired account.
3. Risky remote actions require explicit approval.

The token is kept in Host memory only and forgotten on disconnect or restart.

---

## 14. Updates

- **Ensync itself** — manual three-stage updates (Check → Download → Open) with SHA-256 and publisher verification. Nothing installs, quits, or restarts silently.
- **Provider CLIs** — a device-wide maintenance policy (weekly reminder, automatic weekly, or manual only). Update launches are refused while agent jobs are active.

---

## 15. Support and troubleshooting

The in-app **help desk** keeps tickets locally and generates redacted diagnostics (no transcripts, secrets, paths, or command output). `Fix with my subscription` runs a single review-required repair through Codex or Claude — it never claims an automatic fix, commit, push, or deploy.

Before reporting anything, remove passwords, bot tokens, API keys, SSH private keys, and subscription cookies.

### Common checks
- **Provider not runnable** — verify the CLI is installed and logged in; check connection state in the provider list.
- **Auto found no runner** — all connected runners are exhausted or none are authenticated; pin a runner or reduce work.
- **Dirty checkout** — commit or stash changes; Ensync never mutates the shared checkout to admit a provider.
- **Remote job not progressing** — the Host must be online with an outbound Sync connection; the phone only polls, it does not own execution.

---

## 16. Security model in one page

- Credentials stay with the official provider CLIs; Ensync does not stockpile passwords or API keys.
- Provider processes run with model API-key and paid-override variables removed, with internal tool servers bound to loopback.
- Every coding run is isolated in its own worktree; a dirty shared checkout fails closed.
- Remote phone traffic is end-to-end encrypted; Sync is an opaque relay, never an execution target or credential store.
- Risky remote actions (including over Telegram) are approval-gated.

---

## 17. Environment variables reference

| Variable | Purpose |
| --- | --- |
| `ENSYNC_SYNC_SERVICE_URL` | HTTPS Sync URL for account sync / brokered execution |
| `ENSYNC_SYNC_ALLOWED_ORIGINS` | extra browser origins for the Sync CORS allowlist |
| `ENSYNC_AUTO_INIT_GIT=0` | disable automatic `git init` |
| `ENSYNC_GITHUB_ISSUES_URL` | enable the GitHub issue-draft button |
| `ENSYNC_ALLOW_VIRTUALBOX_MUTATION=0` | disable VirtualBox mutations |
| `ENSYNC_CHAT_HARD_TIMEOUT_MS` | absolute run ceiling (≥1000 ms) |
| `ENSYNC_HOST_PORT` | loopback Host port (default 43121) |
| `VERCEL_TOKEN` | Vercel token for the deploy adapter |
| `ENSYNC_WORKSPACE_RECOVERY_FILE` | operator crash-recovery envelope |
| `ENSYNC_CODEX_IMPORT_*` | one-shot Codex JSONL import (see `desktop/README.md`) |
