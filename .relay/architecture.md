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

Provider maintenance is also Host-owned. The renderer may request only a catalog provider ID and whether to launch or preview; the Host resolves the installed executable and fixed provider-owned update arguments. It refuses update launches while Host-owned agent jobs are active and never infers that a newer version exists from package registries.

The subscription bridge pattern is based on the proven queue-and-runner separation in `../nadlan-desk/worker/src/subscription-agent.ts` and `project-agent.ts`.
