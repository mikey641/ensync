# Ensync

Ensync is a universal AI agent workspace for continuing one coding task across subscription-backed CLIs. It preserves the conversation, verified project, shared `.ensync` feature memory and plan, `CLAUDE.md` and `AGENTS.md` adapters, and host-observed Git state. It is conversation-first: code stays out of the primary interface unless you ask to see it.

The desktop app (macOS/Windows) drives a local **Ensync Host** that runs the coding agents you already subscribe to, inside an isolated Git worktree, and can automatically merge (land) and deploy (deliver) the results. The **mobile app** (iOS/Android, or the same client installed as a web PWA) signs into your self-hosted **Ensync Sync** service and remotely starts, follows, stops, and steers those same jobs on your paired computer.

- Public site: [ensync.vercel.app](https://ensync.vercel.app)
- Source: [github.com/mikey641/ensync](https://github.com/mikey641/ensync) (MIT-licensed)
- Full user guide: [USER-MANUAL.md](USER-MANUAL.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)

---

## What Ensync does

A coding task lives **above** any one provider. You write one conversation; Ensync keeps its identity (project, transcript, feature memory, instructions, verified Git state) together and hands it across providers. Agents run through the official CLIs you already log into, never through a per-token API key behind your back.

```
You (desktop or phone) ──┐
                          ├─ Ensync Host (your computer) ── Codex / Claude Code / Factory Droid
   Ensync Sync (optional) ┘      └─ isolated worktree → auto-land → auto-push → deploy-verify
```

## Desktop features (computer)

- **Durable conversation tabs** with searchable history, adjacent-or-end new-tab placement, and `Cmd/Ctrl+T`, `Cmd/Ctrl+K`, `Cmd/Ctrl+W`.
- **Split panes**: open several tasks side by side, each with its own draft, provider, model size, and execution state, resizable and hideable with a hidden-pane shelf.
- **Verified project focus**: native Finder/Windows folder picker, or manual absolute-path entry, re-inspected and canonicalized by the Host before any run. Recent-workspaces history.
- **Git workflows**: import/clone, real status (branch, upstream, ahead/behind, dirty), remote verification, guarded branch push, and an explicitly-confirmed "Direct to production" push.
- **Provider + Model size selectors** in every conversation header. Provider `Auto` (default) or a fixed runner; model size `Provider default`, `Small`, `Medium`, `Large`, or `XL` (maps to the provider's verified low/medium/high/max effort, local or SSH).
- **Automatic routing** picks the first connected, tested runner in your saved priority with verified remaining usage.
- **Safe automatic fallback** (separate toggle) continues a run only when the Host proves the failure is safe to retry with **no** tool, command, file, or unknown activity. Ambiguous or post-mutation failures are never replayed.
- **Host-enforced Git isolation**: each conversation gets a durable protected worktree/branch via the pinned open-source `agent-worktree` runtime, so different chats in one repo run concurrently. A dirty canonical checkout fails closed and stays unchanged.
- **Immediate automatic landing**: each completed turn queues its exact commit and releases the chat; per-repository FIFO trains merge compatible completions in the background. There is no manual merge-review state. Conflicts use a subscription resolver (Codex, Claude Code, or Factory Droid) and otherwise remain preserved for automatic retry.
- **Delivery pipeline**: `Saved → Landing → Pushed → Building → Production`, with a per-project destination of **Production** (merge, push, deploy-verify) or **Protected branch only** (anchor the exact commit, never merge/push/deploy).
- **Typed, non-fabricated usage telemetry**: quota percentages, plans, resets, and models appear only when the real CLI reports them.
- **Remote execution**: local Host, SSL-free **SSH worker** (public-key only), a guided **VirtualBox** Ubuntu VM, and **Ensync Sync**-brokered mobile/web clients.
- **Telegram bridge**: approval-gated operation through a private chat.
- **Local-first help desk** with redacted diagnostics and an opt-in one-run repair through your subscription (always review-required, never "auto-fixed").
- **Native updates**: checks and downloads run automatically in the background (startup + hourly), then an explicit open-installer step completes it, with stable/beta channels and SHA-256 plus publisher verification; Microsoft Store builds are "Managed by Store".

### Runnable providers today

| Provider | Status | Billing |
| --- | --- | --- |
| **Codex** | Tested structured runner | ChatGPT subscription |
| **Claude Code** | Tested structured runner | Claude subscription |
| **Factory Droid** | Tested structured runner | Factory subscription |

Everything else in the catalog is shown honestly as **discovery-only** until its runner, quota contract, session adapter, and paid-overage guard are verified: GitHub Copilot CLI, Cursor Agent, Google Antigravity, Google Jules, Kimi Code, Kiro CLI, Junie CLI, GitLab Duo CLI, Warp Oz, Amp, Augment Auggie, Qoder CLI, CodeBuddy Code. **Ollama** is a separate local runtime, not a subscription runner.

> Cursor has an implemented adapter but stays discovery-only because account login and quota telemetry do not prove paid Additional Usage is disabled. GitHub Copilot CLI account status is verified via the official `auth.getStatus`, but its task runner and fallback remain disabled.

## Mobile features (phone)

The `mobile/` client (Capacitor iOS/Android, or the **same app installed as a web PWA**) signs into Ensync Sync and controls a paired Host:

- Create an account / sign in with the same Ensync account.
- Register the device, then claim a one-time pairing code shown in desktop Settings.
- List paired hosts.
- Submit a **Codex or Claude Code** job with a manually entered project path (re-verified by the Host).
- Poll and decrypt progress events live; **stop** and **steer** the running turn.

All commands, events, and results are end-to-end encrypted (AES-256-GCM) through Sync; the service never sees plaintext prompts, paths, results, or credentials. Closing the phone does not cancel the job — the Host owns it durably.

**Not yet available on mobile** (not implied): host project discovery, attachments, approval UI, background push wake-up, OS-backed keychain storage, and App Store / Play Store signing.

---

## Settings reference

All settings are in the Settings modal (**Preferences — Make Ensync yours**, gear icon or `Cmd/Ctrl+,`) and save automatically.

| Setting | Options | Default |
| --- | --- | --- |
| Theme | System / Light / Dark | System |
| Text size | Comfortable / Large | Large |
| Task-finished indicator | Small dot / Green header / Whole tab | Small dot |
| New conversation view | Open as tab / Open in split pane | Split pane |
| New split pane position | Beside current pane / At the end | Beside |
| Delivery destination | Production / Protected branch only | Production |
| Ensync Auto Context skill | on / off | off |
| Automatic fallback | on / off + saved provider ranking | on (Codex, Claude Code, Factory Droid) |
| Agent updates | Remind weekly / Automatic weekly / Manual only | Remind weekly |
| Agent alerts | Off / Ringtone / Spoken text (+ "answer needed" alerts, words, voice) | Off |
| Interface sections | Activity rail, Title bar, Tab strip, Sidebar, Header, Composer — each toggleable | all on |
| Ensync updates | Stable / Beta channel; auto-check + auto-download, then explicit open | Stable |
| Account & chat sync | username (3–32) + password (12–256); create / sign in / sync | — |

## Run it yourself

Requires Node.js 20 or newer.

```bash
npm install
npm run dev            # Vite UI + Ensync Host + dev-only account-sync service
```

For the native desktop shell:

```bash
npm --prefix desktop install
npm --prefix desktop start
```

Build the mobile web app (PWA) to `mobile/dist`:

```bash
npm --prefix mobile install
npm --prefix mobile run build
```

For native mobile builds:

```bash
npm --prefix mobile run sync
npm --prefix mobile run open:ios      # macOS + Xcode
npm --prefix mobile run open:android  # Android Studio + Android SDK
```

### Self-host Ensync Sync (for two devices / remote mobile)

1. Deploy `npm run sync-service` behind HTTPS with one persistent `ENSYNC_SYNC_DATA_FILE`.
2. Set the same `ENSYNC_SYNC_SERVICE_URL` on Ensync Host for both computers/devices.
3. Add the browser origin of a hosted phone PWA to `ENSYNC_SYNC_ALLOWED_ORIGINS`.

Plain HTTP is accepted only for an exact loopback address. The service hashes account passwords with scrypt and stores only AES-256-GCM encrypted conversation documents. Host login state is memory-only, so restarting the Host requires signing in again; uploads remain available.

### Configuration knobs (`ENSYNC_*`)

- `ENSYNC_SYNC_SERVICE_URL` — HTTPS Sync URL for account sync / brokered execution.
- `ENSYNC_SYNC_ALLOWED_ORIGINS` — comma-separated extra browser origins (native `capacitor:` is always accepted).
- `ENSYNC_AUTO_INIT_GIT=0` — disable automatic `git init` for non-Git projects.
- `ENSYNC_GITHUB_ISSUES_URL` — exact `github.com/<owner>/<repo>/issues/new` URL for the issue-draft button.
- `ENSYNC_ALLOW_VIRTUALBOX_MUTATION=0` — disable all VirtualBox mutations.
- `ENSYNC_CHAT_HARD_TIMEOUT_MS` — pin the absolute run ceiling (≥1000 ms).
- `ENSYNC_HOST_PORT` — loopback Host port (default 43121).
- `VERCEL_TOKEN` — Vercel API token for the deploy adapter.
- `ENSYNC_WORKSPACE_RECOVERY_FILE` — operator-supplied crash-recovery envelope.
- `ENSYNC_CODEX_IMPORT_*` — one-shot Codex JSONL transcript import (see `desktop/README.md`).

## Setup overview (end to end)

1. Install the agent CLIs you subscribe to and log into them (Codex, Claude Code, or Factory Droid).
2. Launch Ensync and focus a project (folder or absolute path).
3. Pick `Auto` (or a fixed provider) and a model size, write a prompt, and send.
4. (Optional) For remote control from your phone: run Sync over HTTPS, sign into the same account in desktop Settings → **Remote execution**, and pair the phone with the one-time code.
5. Watch landing/delivery status per chat; merge/push/deploy according to the chosen destination.

The full walkthrough, including SSH workers, VirtualBox, Telegram, and mobile step-by-step, is in [USER-MANUAL.md](USER-MANUAL.md). Every provider's official install link is listed in the app and on the [documentation site](https://ensync.vercel.app/docs/).

## Understanding the pieces

| Piece | Where | What it owns |
| --- | --- | --- |
| **UI** | `src/` (React/Vite) | Conversations, tabs, panes, settings, git UI, support, delivery panels |
| **Desktop shell** | `desktop/` (Electron) | Native windows, folder picker, downloads/updates, launching the daemon |
| **Host** | `host/` | Provider discovery, worktree isolation, runs, landing, delivery, journals, recovery |
| **Sync service** | `sync-service/` | Encrypted account sync + encrypted job/command broker |
| **Mobile** | `mobile/` | Capacitor iOS/Android + PWA remote client |
| **Site** | `site/` | Public docs, privacy, and manifest-gated downloads |

## Verification

```bash
npm run build
npm run build:mobile
npm run test:host
npm --prefix desktop test
npm --prefix desktop run smoke
npm --prefix site test
```

## Distribution

There is currently **no signed public installer**. macOS unlocks only after signing, notarization, and checksum verification; Windows unlocks only through the certified Microsoft Store listing. Development and unsigned builds are local test artifacts and fail closed for updates. The tag-triggered release workflow refuses generation unless macOS and Windows signing plus notarization are verified. See `docs/release-runbook.md`, `desktop/README.md`, and `site/README.md`.

## Project memory

- `.ensync/project.md` — cross-feature product rules.
- `.ensync/architecture.md` — runtime and isolation boundaries.
- `.ensync/features/*.md` — focused durable decisions per feature.
- Root `AGENTS.md` / `CLAUDE.md` — thin adapters directing agents at the same sources.

## License

MIT — see [LICENSE](LICENSE).
