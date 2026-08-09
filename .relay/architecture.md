---
name: Ensync architecture
description: Durable runtime, routing, and isolation decisions.
---

# Architecture

The UI is a React/Vite prototype. A production build should use a small native desktop shell and a separate Ensync Host runner.

## Boundaries

1. The desktop app owns windows, tabs, preferences, credential prompts, and local project selection.
2. Ensync Host owns CLI discovery, process isolation, subscriptions, job queues, usage telemetry, and encrypted remote access.
3. Agent adapters normalize streaming events, session IDs, limit/reset signals, tool calls, and final responses.
4. The router retries another subscription only for availability, authentication, quota, or capacity failures. It must not replay after a mutating tool call.
5. The context compiler reads `.relay` and emits thin provider-specific instruction files without duplicating durable project facts.
6. Telegram is a restricted client of Ensync Host, not an independent model transport.
7. Ensync Sync is an optional account service for encrypted conversation documents. The local Host owns login, encryption/decryption, and revision handling; the remote service owns password verification and opaque ciphertext storage. It never becomes an execution target and cannot supply CLI credentials, provider sessions, or machine verification.
8. Provider integration is capability-driven and catalog-wide. Shared Host contracts cover discovery, account authentication, billing/overage guards, structured events, sessions, permissions, cancellation, usage, updates, local/remote execution, and both desktop platforms; provider-specific adapters may report an unsupported capability but may not silently disappear from a provider-facing change.
9. Coding providers never run in the user-selected shared checkout. Ensync Host creates or reuses a stable Git worktree and branch for the exact conversation, then holds one renewable repository-wide write lease for the full provider run. The lease lives under Git's shared common directory, so linked worktrees, native windows, and separate Host processes serialize mutations to the same repository while unrelated repositories remain concurrent.

Project isolation fails closed before provider execution when Git, an initial commit, or a consistent managed worktree cannot be verified. When a first-time conversation finds a dirty shared checkout, it uses a temporary private Git index to snapshot tracked and non-ignored untracked state into the new protected worktree, then resets that branch to the real shared `HEAD` so the inherited state remains visible as uncommitted work. This never changes the shared worktree, shared index, current branch, or durable history and never cleans, stashes, commits, merges, or deletes user changes. A waiting run starts no provider process, can be cancelled safely, and exposes its queued state in the conversation. Worktree branches are durable conversation state and are not automatically deleted after a run, timeout, cancellation, or crash. Renewable lock ownership and conservative stale-lock quarantine provide cross-process recovery without granting one Host authority to remove another live owner's lease.

Provider maintenance is also Host-owned. The renderer may request only a catalog provider ID, whether to launch or preview, and the fixed manual/automatic trigger kind; the Host resolves the installed executable and fixed provider-owned update arguments. It refuses update launches while Host-owned agent jobs are active, deduplicates concurrent automatic launches across native windows, and never infers that a newer version exists from package registries. Every installed catalog provider participates in the device-wide maintenance policy: the default weekly reminder reviews them all, while opt-in automatic mode opens every verified self-update command when the Host is online and idle, recognizes providers whose own background updater is authoritative, and flags installation-method/platform-dependent providers for their official guide. It never launches an agent session merely to trigger a background update and does not claim completion that the Host cannot observe.

The subscription bridge pattern is based on the proven queue-and-runner separation in `../nadlan-desk/worker/src/subscription-agent.ts` and `project-agent.ts`.
