# Ensync

Ensync is a universal AI agent workspace for continuing one coding task across subscription-backed CLIs. It preserves the conversation, verified project, shared `.relay` feature memory and plan, `CLAUDE.md` and `AGENTS.md` adapters, and host-observed Git state. It is conversation-first: code stays out of the primary interface unless the user asks for it.

The public product site is [ensync.vercel.app](https://ensync.vercel.app). The macOS download stays disabled until a signed/notarized build with a matching SHA-256 checksum is published; Windows stays disabled until the certified Microsoft Store listing URL is configured.

## What works

- Durable conversations, adjacent-or-end new-tab placement, resizable split panes, double-click maximize/restore, and hideable history and chrome.
- Username/password account sync for encrypted cross-computer conversation history. Stable chat/message IDs merge concurrent additions; CLI credentials, provider sessions, queued or active work, terminal output, and local attachments never enter the account document.
- Light, dark, and system themes with large default typography.
- Verified local project focus with a native macOS Finder/Windows folder chooser in the desktop app, browser-safe absolute-path entry, plus Git clone/import, status, remote verification, guarded branch push, and explicitly confirmed production push.
- Real Codex and Claude Code subscription chat runners with provider-neutral Auto selection and retry-safe quota fallback.
- Host-enforced Git isolation for every coding run: each conversation receives a durable protected worktree/branch and its own cross-process write lease, so different chats in the same repository run concurrently while duplicate runs against one chat serialize safely. Dirty local and SSH checkouts are preserved through a private-index transport snapshot and inherited as uncommitted protected-worktree state without changing the shared checkout.
- One bundled Superpowers coordination policy for every current and future provider runner, locally and over SSH. Native provider plugins are optional: Ensync always preserves requirements, delegates only genuinely independent work, assigns non-overlapping mutation scopes, keeps one lead responsible for integration, and verifies the combined result without creating nested worktrees inside the protected conversation workspace.
- Separate provider and Model size selectors in every conversation header. Provider default sends no effort override; Small, Medium, Large, and XL apply the verified low, medium, high, and max effort levels to the provider's own default model across local and SSH runs.
- Opt-in Ensync Auto Context skill: preserves an Auto or fixed provider choice, provider-neutral Model size over each CLI's native default model, synchronized session resume, full project/conversation handoff on provider switches, same-target local/SSH execution, and verified continuation metadata.
- Discovery, provider-specific account setup, exact installed versions, and official install links ordered as a mainstream-recognition navigation heuristic: Codex, Claude Code, GitHub Copilot CLI, Cursor Agent, Google Antigravity, Google Jules, Kimi Code, Kiro CLI, Junie CLI, GitLab Duo CLI, Warp Oz, Factory Droid, Amp, Augment Auggie, Qoder CLI, CodeBuddy Code, and the separate local Ollama fallback. This order is not a measured market-share ranking.
- Guarded update maintenance for every installed catalog provider. Ensync can launch fixed native updaters for Codex, Claude Code, Copilot, Cursor, Kimi, Qoder, CodeBuddy, Droid, Auggie, and Amp; it recognizes Antigravity, Kiro, and Junie's provider-managed background updates; and it keeps Jules, GitLab Duo, Warp Oz, and Ollama in the weekly review with official guides because their update paths depend on installation method or platform. The policy defaults to a weekly reminder, with Manual only and opt-in Automatic weekly alternatives. Automatic cycles wait until the Host is idle, deduplicate native windows, ignore caller-supplied command data, and never claim unobserved completion.
- Typed, non-fabricated usage telemetry: subscription quota for Codex and Claude when reported; session-only data for Copilot and Junie; local model inventory/load state for Ollama; explicit unavailable state for Cursor and Kiro account quota.
- Verified SSH workers, guarded Oracle VirtualBox provisioning, and approval-gated Telegram operation through Ensync Host.
- Local-first help desk with reviewable redacted diagnostics and an opt-in one-run bug repair through the connected Codex or Claude subscription. Results always require user review and never claim the bug is fixed automatically.
- Electron packaging for universal macOS DMG/ZIP and a guarded Windows x64 AppX upload package. macOS uses native signing/notarization attestations and fail-closed public release generation; Windows is signed, certified, installed, and updated by Microsoft Store.
- Manual native updates in Settings for direct desktop releases: the signed macOS app checks the production manifest only on request, verifies SHA-256 plus its Developer ID, and opens the verified DMG only after a separate click. A Microsoft Store Windows install instead reports Store-managed updates and disables Ensync's installer controls. Development, unsigned, unconfigured, and unverifiable builds remain explicitly unavailable.

Only Codex and Claude currently have tested structured chat runners and may enter automatic fallback. Every other account-backed provider remains discovery-only until its execution adapter has equivalent parsing, subscription-authentication proof, paid-overage guards, session handling, and safe-retry proof. Ollama remains a separate local fallback and never enters the subscription pool.

GitHub Copilot CLI account status is verified automatically through its official SDK-compatible `auth.getStatus` method. Ensync starts the installed CLI only in bounded headless stdio mode, negotiates protocol v2 or v3, creates no session, sends no prompt, and accepts only a stored `user` login with an explicit account name. Token environment variables and generic GitHub CLI authentication are excluded from this proof. Account quota remains unknown, and Copilot task execution plus automatic fallback remain disabled until structured events, subscription entitlement, AI-credit overage protection, sessions, and safe retry are tested end to end. See GitHub's official [SDK compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility), [local CLI setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/local-cli), and [Copilot CLI overview](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli).

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

This starts the Vite interface, the Node Ensync Host, and a development-only account-sync service on loopback. The Host launches only fixed provider commands, validates project paths, removes model API-key billing environment variables, passes prompts over stdin, and accepts only structured CLI results. Development sync data is stored in the ignored `.ensync-sync-data.json` file.

For two computers, deploy `npm run sync-service` behind HTTPS with one persistent `ENSYNC_SYNC_DATA_FILE`, then set the same `ENSYNC_SYNC_SERVICE_URL` for Ensync Host on both devices. Plain HTTP is accepted only for an exact loopback address. The bundled service hashes account passwords with scrypt and stores only AES-256-GCM encrypted conversation documents. Host login state is currently memory-only, so restarting Ensync Host requires signing in again; uploaded conversations remain available.

Run the native desktop shell:

```bash
npm --prefix desktop install
npm --prefix desktop start
```

In the native app, open the project switcher and choose **Choose folder** to use Finder on macOS or the system folder chooser on Windows. The selected absolute path is still inspected and canonicalized by Ensync Host before it becomes the focused project. Cancelling changes nothing. The browser build keeps manual absolute-path entry because websites cannot receive this narrow desktop bridge.

## iPhone and Android

The mobile client lives in `mobile/` and includes generated Capacitor iOS and Android projects. In desktop Settings, sign in to the same Ensync account, enable **Remote execution**, and create a one-time pairing code. On mobile, sign in, enter that code, choose Codex or Claude Code, enter the absolute project path on the paired Host, and start the encrypted run.

```bash
npm --prefix mobile install
npm --prefix mobile run sync
npm --prefix mobile run open:ios      # Xcode on macOS
npm --prefix mobile run open:android  # Android Studio + Android SDK
```

The development app supports pairing, submission, encrypted event polling, cancellation, and steering. Host project discovery, attachments, secure OS credential persistence, background push wake-up, store signing, and App Store/Play Store publishing remain release work.

## Usage and fallback

Every new conversation defaults to provider mode `Auto`. Settings keeps a persistent top-to-bottom Automatic fallback priority, separate from provider popularity order. Auto chooses the first connected, tested runner in that priority with verified usage below 100%; priority wins over the size of remaining capacity. Providers with unreported quota remain explicitly unknown and are considered only when no provider has verified remaining usage.

Model size is independent from provider routing, Auto Context, and Automatic fallback. A selected size persists as a friendly tier, applies to a fixed Codex/Claude choice or whichever supported provider Auto runs, follows a safe fallback, and is re-applied when that provider session resumes. Ensync keeps the vendor `model` null: Codex receives only a strict `model_reasoning_effort` override and Claude receives only `--effort`.

Automatic fallback is independent from Auto Context. When enabled, it is allowed before a run when quota is provably exhausted. After a run starts, it advances through the same saved priority without repeating an attempted provider, and only if the provider's structured event stream proves a terminal availability/quota failure with no tool, command, file, or unknown activity. A one-turn fallback preserves a fixed provider preference and the selected Model size. Ambiguous failures, timeouts, and post-mutation failures are never replayed.

## Support repair

The in-app help desk stores tickets locally and creates a report for review. Automatic diagnostics exclude transcript text, secrets, file contents, absolute paths, environment variables, and command output. `Fix with my subscription` requires separate report-review, subscription-use, and project-edit consent; re-verifies the exact local project; runs Codex or Claude once without API-key billing or automatic fallback; and opens the real response in a review-required tab. No staffed support queue or SLA is claimed unless configured.

## Distribution

```bash
npm --prefix desktop test
npm --prefix desktop run smoke
npm --prefix desktop run package:mac # on macOS
npm --prefix desktop run package:win-store # on Windows with Partner Center identity variables
cd site && npm test
```

The tag-triggered release workflow refuses to create a public GitHub release unless macOS app/DMG signing and notarization are verified. Its Windows AppX remains a private Actions artifact for Partner Center upload and can never enter the public binary release. Microsoft Store owns Windows certification and updates. The workflow deploys the exact macOS manifest to Vercel; a failed deployment leaves the older fail-closed feed in place. See `desktop/README.md` for Store identity, Apple notarization, and Vercel inputs and `site/README.md` for the public link contract.

## Project memory

- `.relay/project.md` contains cross-feature product rules.
- `.relay/architecture.md` defines runtime and isolation boundaries.
- `.relay/features/*.md` contains focused durable decisions for each feature.
- Root `AGENTS.md` and `CLAUDE.md` direct supported agents to the same sources instead of maintaining competing memory.

## Verification

```bash
npm run build
npm run build:mobile
npm run test:host
npm --prefix desktop test
npm --prefix desktop run smoke
npm --prefix site test
```
