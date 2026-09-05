---
name: ensync-auto-context
description: Continue one coding task across Ensync's subscription-backed CLI providers while preserving the focused project, conversation, feature memory, Git state, execution target, provider choice, model-size effort, and safe handoff rules. Use when Ensync Auto Context is enabled, when a user asks to use the default/Auto provider with its native default model, or when a task must move between Codex, Claude Code, or another verified Ensync runner without being re-explained.
---

# Ensync Auto Context

Keep the task identity above the provider session. A provider may change; the focused project, task, constraints, execution target, and accumulated decisions may not.

## Start the task

1. Confirm the focused canonical project directory and current execution target (`local` or the selected SSH/VM worker). Never change targets merely because the provider changes.
2. Read applicable repository instructions, including root `AGENTS.md` and `CLAUDE.md` when present.
3. Read `.ensync/project.md`, `.ensync/architecture.md`, and only the relevant `.ensync/features/*.md` files. If the repository uses Claude Code project memory, treat its canonical memory store as shared project knowledge and do not create a competing copy.
4. Inspect current Git branch and worktree status before editing. Preserve the branch and unrelated user changes.
5. Honor the chat's independent provider choice: use Auto when selected, or keep a fixed Codex/Claude preference when pinned. Leave the vendor model unset so the chosen CLI uses its own current default model. Preserve the selected provider-neutral Model size effort (Provider default, Small, Medium, Large, or XL). Never send one vendor's model name to another vendor.

## Build the task context

Keep these fields together as the provider-neutral context capsule:

- canonical project path and execution target;
- task objective and acceptance criteria established before the current turn;
- applicable repository instructions;
- relevant `.ensync` feature and architecture decisions;
- conversation transcript and prior provider responses;
- verified Git branch, worktree state, files changed, and checks already run;
- unresolved errors, user corrections, safety constraints, prior attempt evidence, and the next intended action.

Do not invent context, usage, model, plan, authentication, Git, VM, or test state. Label unavailable facts as unavailable. If the envelope would exceed a runner's input limit, preserve the current request, user corrections, durable decisions, mutation state, and recent turns verbatim; compact only older redundant turns into a clearly labeled summary.

## Run and resume

- Resume the existing session only when the selected provider, project, execution target, and synchronized conversation cursor still match. Send exactly one current request because the CLI session already owns the earlier transcript.
- When there is no matching session, Auto selects a different provider, or an enabled safe fallback changes providers, start a provider-specific session and send one combined input containing the complete context capsule followed by exactly one current request.
- Use only the provider's official subscription/account login. Keep model API keys and alternate usage-billed credentials out of the process environment.
- Keep durable feature decisions in the existing focused `.ensync/features/<feature>.md` file. Do not store verbose transcripts or transient progress logs there.

## Fall back safely

Switch providers after a failed or exhausted run only when the separate Automatic fallback setting is enabled, Ensync has verified that the destination runner is installed and subscription-authenticated on the same target, the selected provider is unavailable, unauthenticated, exhausted, rate-limited, or capacity-limited, and the failed attempt is safe to retry. Auto Context never enables fallback by itself. Choose the next eligible destination from the same persistent top-to-bottom Automatic fallback priority used for the initial Auto route; never substitute provider catalog/popularity order or sort by the size of remaining capacity. Track providers attempted during the turn and never loop back to one already attempted. A provider whose account quota is unavailable is a last-resort candidate after providers with verified remaining usage, not an assumed-full or assumed-empty subscription.

Never replay after a tool call, command, file edit, or unknown activity. A timeout or malformed/incomplete provider stream is not proof that no mutation occurred. In those cases, stop and report the failure instead of risking a duplicate change.

A user-requested Stop is never a fallback signal. Cancel only that chat's active transport and provider process, clear its resumable vendor session, suppress completion alerts and unread completion state, and retain the user turn as stopped context that future agents must not execute. When the provider or buffered SSH run had started, record cancellation with `reconciliation_required` because partial mutations may exist; never label it completed, failed quota, or safe to retry.

On a safe switch, keep the same project directory, Git branch, execution target, context capsule, user request, and selected Model size effort. A fixed provider remains the chat's preferred provider after the one-turn fallback; the message and continuation metadata record the provider that actually ran. If the target is lost, stop instead of moving the task to another computer. Do not resume the failed provider for this turn; select or create a destination session whose provider/project/target/cursor lineage matches, and leave the destination vendor model unset. A coordinator may retain an older source-provider session only if its conversation cursor prevents it from missing work completed elsewhere.

## End with continuation state

Finish each successful coding turn with a compact semantic handoff containing:

- outcome and remaining work;
- decisions or user corrections that future providers must preserve;
- files changed and verification actually completed;
- the single next action, or `none` when the requested work is complete.

The Ensync coordinator must extract this semantic handoff from the provider response, keep it out of the user-visible message, and retain it in structured continuation state. It must also attach the verified turn ID, attempt chain and fallback proof, actual provider, provider-reported model or `null`, execution target, session resumability, Git state when available, and completion time. Record blocked and ambiguous turns too; ambiguous execution must be marked `reconciliation_required`, never replayable.

Keep the handoff concise and useful to the next provider. Never claim a test, deployment, push, usage percentage, or completion state that was not verified.
