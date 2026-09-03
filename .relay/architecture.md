---
name: Ensync architecture
description: Durable runtime, routing, and isolation decisions.
---

# Architecture

The UI is a React/Vite prototype. A production build should use a small native desktop shell and a separate Ensync Host runner.

## Boundaries

1. The desktop app owns windows, tabs, preferences, credential prompts, and local project selection.
2. Ensync Host owns CLI discovery, process isolation, subscriptions, job queues, usage telemetry, and encrypted remote access. Installing a Windows client through Microsoft Store does not move execution or provider credentials away from the selected local or remote Host.
3. Agent adapters normalize streaming events, session IDs, limit/reset signals, tool calls, and final responses.
4. The router retries another subscription only for availability, authentication, quota, or capacity failures. It must not replay after a mutating tool call.
5. The context compiler reads `.relay` and emits thin provider-specific instruction files without duplicating durable project facts.
6. Telegram is a restricted client of Ensync Host, not an independent model transport.
7. Ensync Sync is an optional account service for encrypted conversation documents. The local Host owns login, encryption/decryption, and revision handling; the remote service owns password verification and opaque ciphertext storage. It never becomes an execution target and cannot supply CLI credentials, provider sessions, or machine verification.
8. Provider integration is capability-driven and catalog-wide. Shared Host contracts cover discovery, account authentication, billing/overage guards, structured events, sessions, permissions, cancellation, usage, updates, local/remote execution, and both desktop platforms; provider-specific adapters may report an unsupported capability but may not silently disappear from a provider-facing change.
9. Coding providers never run in the user-selected shared checkout. The exact pinned `agent-worktree` runtime creates or reuses one stable branch and worktree for each conversation. The singleton Host uses a process-local owner check to reject a duplicate run for the same workspace immediately; it never creates filesystem workspace leases, heartbeat timers, lock polling, or stale-lock quarantine. Different conversation worktrees in one repository run concurrently.

Project isolation fails closed before provider execution when Git, an initial commit, a clean canonical checkout, or a consistent managed worktree cannot be verified. It never cleans, stashes, synthesizes hidden history from a dirty checkout, or mutates the shared checkout to admit a provider. Legacy registered `ensync/chat-*` worktrees remain adoptable so upgrades do not orphan work.

After a successful local provider turn, the Host commits the exact workspace state, records that immutable SHA in a checksummed landing journal, and completes the provider job without waiting for integration. A background coordinator starts on the next microtask, runs one FIFO train per repository, and batches completions that arrive during an active train into the next train. A tool-owned integration worktree applies each exact SHA through `agent-worktree`, runs structural checks plus an optional bounded `land:quick`, and publishes the verified train once. Conflicts are offered only to the same subscription-backed provider in that isolated integration worktree; unresolved items remain saved and retry on startup or the next repository completion while later compatible items proceed. There is no landing preference, polling delay, or `Needs merge review` state. Startup recovery resumes journaled queued/retry entries without replaying a provider prompt.

Provider maintenance is also Host-owned. The renderer may request only a catalog provider ID, whether to launch or preview, and the fixed manual/automatic trigger kind; the Host resolves the installed executable and fixed provider-owned update arguments. It refuses update launches while Host-owned agent jobs are active, deduplicates concurrent automatic launches across native windows, and never infers that a newer version exists from package registries. Every installed catalog provider participates in the device-wide maintenance policy: the default weekly reminder reviews them all, while opt-in automatic mode opens every verified self-update command when the Host is online and idle, recognizes providers whose own background updater is authoritative, and flags installation-method/platform-dependent providers for their official guide. It never launches an agent session merely to trigger a background update and does not claim completion that the Host cannot observe.

The subscription bridge pattern is based on the proven queue-and-runner separation in `../nadlan-desk/worker/src/subscription-agent.ts` and `project-agent.ts`.
