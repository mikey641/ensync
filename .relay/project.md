---
name: Ensync project context
description: Product intent and cross-feature rules shared by every coding agent.
---

# Ensync

Ensync is the universal AI agent workspace, not another coding editor. Its primary promise is to continue one provider-neutral task across supported CLIs without making the user reconstruct the work. Source code stays out of the primary experience unless the user explicitly asks to see it.

## Product rules

- A selected project is the hard context boundary for chats, files, searches, terminals, memory, and remote jobs.
- Every conversation can be opened as a durable tab and recovered from history.
- The user's new-tab placement preference persists: beside the current tab or at the end.
- Provider handoff preserves the shared task identity, relevant transcript, canonical project, `.relay` feature memory and plan, root `CLAUDE.md` and `AGENTS.md` adapters, and host-verified Git branch/status. Vendor session IDs remain provider-specific below that shared task identity.
- Every provider-facing change must review the complete provider catalog. Each provider must be explicitly supported, discovery-only, or unavailable with a factual reason; no provider may be silently omitted because an implementation started with one vendor. Recheck first-party interface documentation and update the dated provider research before changing authentication, execution, streaming, sessions, usage, fallback, updates, permissions, or remote behavior.
- Terminal and runtime context is carried forward only when Ensync Host can verify it; the interface must not claim unobserved shell state.
- Subscription CLIs are preferred over per-token APIs. Never silently fall back to paid API usage.
- An SDK, API, API key, or machine-readable CLI is technical capability, not proof of subscription eligibility. Provider adapters must separately prove account identity, included allowance, paid-overage behavior, mutation evidence, cancellation, and macOS/Windows behavior before becoming runnable or eligible for automatic routing.
- Show only usage and model values returned by the real CLI. Never infer subscription percentages, plan names, models, or reset windows. Distinguish subscription quota, per-session usage, local-runtime facts, and unavailable telemetry rather than forcing every provider into a percentage meter.
- Support reports are local and review-first. Never invent a staffed queue, response SLA, external ticket, completed fix, download artifact, or code-signing state.
- Risky remote actions require explicit approval, including through Telegram.
- macOS and Windows are equal first-class desktop targets.
