# Ensync

Ensync is a universal AI agent workspace for continuing one coding task across subscription-backed CLIs. It preserves the conversation, verified project, shared `.relay` feature memory and plan, `CLAUDE.md` and `AGENTS.md` adapters, and host-observed Git state. It is conversation-first: code stays out of the primary interface unless the user asks for it.

The public product site is [ensync.vercel.app](https://ensync.vercel.app). Download buttons are deliberately disabled until real signed Windows and signed/notarized macOS builds are published with matching SHA-256 checksums.

## What works

- Durable conversations, adjacent-or-end new-tab placement, resizable split panes, double-click maximize/restore, and hideable history and chrome.
- Light, dark, and system themes with large default typography.
- Verified local project focus with a native macOS Finder/Windows folder chooser in the desktop app, browser-safe absolute-path entry, plus Git clone/import, status, remote verification, guarded branch push, and explicitly confirmed production push.
- Real Codex and Claude Code subscription chat runners with provider-neutral Auto selection and retry-safe quota fallback.
- Separate provider and Model size selectors in every conversation header. Provider default sends no effort override; Small, Medium, Large, and XL apply the verified low, medium, high, and max effort levels to the provider's own default model across local and SSH runs.
- Opt-in Ensync Auto Context skill: preserves an Auto or fixed provider choice, provider-neutral Model size over each CLI's native default model, synchronized session resume, full project/conversation handoff on provider switches, same-target local/SSH execution, and verified continuation metadata.
- Discovery, provider-specific account setup, exact installed versions, and official install links ordered as a mainstream-recognition navigation heuristic: Codex, Claude Code, GitHub Copilot CLI, Cursor Agent, Google Antigravity, Google Jules, Kimi Code, Kiro CLI, Junie CLI, GitLab Duo CLI, Warp Oz, Factory Droid, Amp, Augment Auggie, Qoder CLI, CodeBuddy Code, and the separate local Ollama fallback. This order is not a measured market-share ranking.
- Guarded agent updates for Codex and Claude Code through their official `update` subcommands. Ensync resolves the installed executable, ignores caller-supplied command data, refuses updates while Host-owned agent runs are active, and requires a manual status refresh afterward. Other agents stay guide-only until a provider-owned cross-platform updater is verified.
- Typed, non-fabricated usage telemetry: subscription quota for Codex and Claude when reported; session-only data for Copilot and Junie; local model inventory/load state for Ollama; explicit unavailable state for Cursor and Kiro account quota.
- Verified SSH workers, guarded Oracle VirtualBox provisioning, and approval-gated Telegram operation through Ensync Host.
- Local-first help desk with reviewable redacted diagnostics and an opt-in one-run bug repair through the connected Codex or Claude subscription. Results always require user review and never claim the bug is fixed automatically.
- Electron packaging for universal macOS DMG/ZIP and Windows x64 NSIS/ZIP, with native CI, signature/notarization attestations, checksums, and fail-closed public release generation.
- Manual native updates in Settings: the signed desktop app shows its installed version, checks the same production manifest as the download site only on request, downloads with real byte progress, verifies SHA-256 plus the installed publisher identity, and opens the verified DMG/installer only after a separate click. Development, unsigned, unconfigured, and unverifiable builds remain explicitly unavailable; Ensync never silently installs, quits, or restarts.

Only Codex and Claude currently have tested structured chat runners and may enter automatic fallback. Every other account-backed provider remains discovery-only until its execution adapter has equivalent parsing, subscription-authentication proof, paid-overage guards, session handling, and safe-retry proof. Ollama remains a separate local fallback and never enters the subscription pool.

GitHub Copilot CLI account status is verified automatically through its official SDK-compatible `auth.getStatus` method. Ensync starts the installed CLI only in bounded headless stdio mode, negotiates protocol v2 or v3, creates no session, sends no prompt, and accepts only a stored `user` login with an explicit account name. Token environment variables and generic GitHub CLI authentication are excluded from this proof. Account quota remains unknown, and Copilot task execution plus automatic fallback remain disabled until structured events, subscription entitlement, AI-credit overage protection, sessions, and safe retry are tested end to end. See GitHub's official [SDK compatibility](https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/compatibility), [local CLI setup](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/local-cli), and [Copilot CLI overview](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli).

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

This starts the Vite interface and the Node Ensync Host on loopback. The Host launches only fixed provider commands, validates project paths, removes model API-key billing environment variables, passes prompts over stdin, and accepts only structured CLI results.

Run the native desktop shell:

```bash
npm --prefix desktop install
npm --prefix desktop start
```

In the native app, open the project switcher and choose **Choose folder** to use Finder on macOS or the system folder chooser on Windows. The selected absolute path is still inspected and canonicalized by Ensync Host before it becomes the focused project. Cancelling changes nothing. The browser build keeps manual absolute-path entry because websites cannot receive this narrow desktop bridge.

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
npm --prefix desktop run package:win # on Windows
cd site && npm test
```

The tag-triggered release workflow refuses to create a public GitHub release unless Windows signing and macOS app/DMG signing plus app/DMG notarization are verified. It then deploys the exact generated manifest to the Vercel download/update feed; a failed Vercel deployment leaves the older fail-closed feed in place. Local unsigned artifacts stay private test builds. See `desktop/README.md` for certificate, notarization, and Vercel inputs and `site/README.md` for the manifest contract.

## Project memory

- `.relay/project.md` contains cross-feature product rules.
- `.relay/architecture.md` defines runtime and isolation boundaries.
- `.relay/features/*.md` contains focused durable decisions for each feature.
- Root `AGENTS.md` and `CLAUDE.md` direct supported agents to the same sources instead of maintaining competing memory.

## Verification

```bash
npm run build
npm run test:host
npm --prefix desktop test
npm --prefix desktop run smoke
npm --prefix site test
```
