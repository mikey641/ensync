# Kimi Code — Ensync provider map

Verified 2026-08-11 against the installed CLI. Facts came from `--help`, subcommand
`--help`, `--version`, local config paths, and **reading the CLI's own bundled
JavaScript source**, which is recoverable in plaintext from the compiled binary
(`strings` over the Mach-O reveals the unminified bundle, including region markers such
as `//#region ../../packages/agent-core/src/agent/permission/policies/index.ts`). That
source is the authority for every claim below about permission ordering and terminal
events. **No prompt was ever sent to a model**, so nothing here rests on observing a
live run; where a claim could only be settled by running a turn, it is marked unknown.

## Binary and version

- Path: `/Users/mikeyhasson/.kimi-code/bin/kimi`
- `kimi --version` → `0.34.0`
- Mach-O arm64 single-file binary with an embedded JS bundle. Commander-based CLI.

## Non-interactive invocation

- One-shot flag: `-p, --prompt <prompt>` — "Run one prompt non-interactively and print
  the response."
- **The prompt is argv-only.** `-p` is declared with a required value
  (`new Option("-p, --prompt <prompt>", ...)`), and the bundle contains no stdin read
  path for it: the prompt-mode entry point uses `opts.prompt` directly
  (`parseHeadlessGoalCreate(opts.prompt)`, then `runNativeTurn(..., opts.prompt, ...)`).
  There is no `--prompt -` convention and no TTY-detection fallback.

  **This is a direct conflict with Ensync's rule that prompts never go in argv.** An
  Ensync prompt is large (up to 100,000 characters) and wrapped with
  `withEnsyncMultiAgentInstructions`; putting it in argv exposes it in process listings
  and risks `E2BIG`. This is the single blocking gap for Kimi, and it is a property of
  the CLI, not of Ensync's wiring.
- Other relevant flags: `-c/--continue`, `-S/--session [id]`, `-m/--model <model>`,
  `--add-dir <dir>` (repeatable), `--plan`, `--agent`/`--agent-file`, `--skills-dir`.
- Subcommands that never start a model turn: `provider list|catalog|add|remove`,
  `doctor config|tui`, `login`, `export`, `acp`, `web`, `migrate`, `upgrade`, `vis`.

## Machine-readable output

- `--output-format <format>` with `choices(["text", "stream-json"])`. It applies to
  prompt mode only. There is also an env override; an invalid value raises
  `Invalid <OUTPUT_FORMAT_ENV> value "...". Expected one of: text, stream-json.`
- `stream-json` is **NDJSON**, one JSON value per line, written by `PromptJsonWriter`.
  Verified line shapes:
  - `{"role":"assistant","content":"...","tool_calls":[{"type":"function","id":"...","function":{"name":"...","arguments":"..."}}]}`
    — `content` and `tool_calls` are each omitted when empty.
  - `{"role":"tool","tool_call_id":"...","content":"..."}`
  - `{"role":"meta","type":"turn.step.retrying","failed_attempt":N,"next_attempt":N,"max_attempts":N,"delay_ms":N,"error_name":"...","error_message":"...","status_code":N}`
  - `{"role":"meta","type":"session.resume_hint","session_id":"...","command":"kimi -r <id>","content":"To resume this session: kimi -r <id>"}`
- Thinking deltas are **discarded** in `stream-json` (`writeThinkingDelta() {}`); in
  `text` mode they go to stderr. Tool progress text always goes to stderr.

### Terminal event proving a completed turn

`{"role":"meta","type":"session.resume_hint",...}` on **stdout**.

This is a genuine completion proof, not a heuristic, and the reason is structural.
`writeResumeHint` is called by the prompt-mode entry point *after* `runNativeTurn`
returns. `runNativeTurn` returns normally **only** when `result.type === "completed"`;
every other outcome throws (`throw new Error(formatNativeTurnFailure(result))`), as does
a failed background-drain policy (`PrintSteeredTurnFailedError`). A thrown error
propagates out of prompt mode, so the resume-hint line is never written. Therefore:
resume-hint present ⇒ the turn completed; absent ⇒ it did not.

It also carries `session_id`, which is the only place the new session's ID is exposed in
machine-readable form.

Caveat, recorded honestly: the agent event bus has a `turn.ended` event, but
`dispatchNativeEvent` has **no case for it**, so `turn.ended` never reaches stdout. Do
not look for it.

Goal mode (`parseHeadlessGoalCreate` matching the prompt) additionally writes a goal
summary line and can set a non-zero `process.exitCode`. Ensync must not use goal mode.

## Session resume

- `-S, --session [id]` (resume that session; **without** an ID it opens an interactive
  picker — a headless run must never pass a bare `-S`).
- `-r, --resume [id]` — a hidden alias with the same parser. This is the form the CLI
  prints in its own resume hint.
- `-c, --continue` — continue the most recent session **for this working directory**.
- ID format: opaque string. `resolveNativeSession` rejects a session created under a
  different directory with `Session "<id>" was created under a different directory.`
  and refuses to run — a useful containment-adjacent guarantee, and also a reason a
  resumed Ensync run must use the same worktree path.
- Unknown: the exact ID grammar. It is not a UUID in the CLI's own examples, so Ensync's
  `SESSION_ID_PATTERN` would need widening before resume could be wired.

## Model and effort selection

- `-m, --model <model>` — a model **alias** defined in `config.toml`, not a raw vendor
  model ID. Defaults to `default_model` in config. If neither is set,
  `requireConfiguredModel` throws.
- **No effort flag on the CLI.** Effort exists only in config
  (`[thinking] enabled/effort/keep` and per-alias `overrides`). Ensync's Model-size
  tiers have no argv surface to map onto, unlike droid's `reasoningEffort`.

## Permission / approval model

This is the crux, and the answer is unambiguous but double-edged.

**Prompt mode cannot hang on an approval — it forces fully autonomous mode.** In
`resolveNativeSession`, every path pins the mode:

- fresh session: `agent.accessor.get(IAgentPermissionModeService).setMode("auto")`
- `--session` / `--continue`: `forceAuto(agent)`, which saves the previous mode, calls
  `permissionMode.setMode("auto")`, and restores it afterwards.

This happens **regardless of `-y/--yolo` or `--auto`**; those flags matter for the
interactive TUI. So the droid-style "interactive prompt in a headless run hangs forever"
failure cannot occur here. `AutoModeAskUserQuestionDenyPermissionPolicy` additionally
denies the `AskUserQuestion` tool outright while auto mode is active, with the message
"AskUserQuestion is disabled while auto permission mode is active. Make a reasonable
decision and continue without asking the user."

**The cost is that `auto` approves everything else.**
`AutoModeApprovePermissionPolicy.evaluate()` is simply:
`if (mode !== "auto") return; return { kind: "approve" }`.

The policy chain (`createPermissionDecisionPolicies`, first non-undefined result wins):

```
PreToolCallHook → AgentSwarmExclusiveDeny → AutoModeAskUserQuestionDeny
→ PlanModeGuardDeny → UserConfiguredDeny → AutoModeApprove
→ SessionApprovalHistory → UserConfiguredAsk → UserConfiguredAllow
→ ExitPlanModeReviewAsk → GoalStartReviewAsk → PlanModeToolApprove
→ SensitiveFileAccessAsk → GitControlPathAccessAsk → YoloModeApprove
→ SwarmModeAgentSwarmApprove → DefaultToolApprove → GitCwdWriteApprove → FallbackAsk
```

Two things follow, and both matter:

1. `UserConfiguredDeny` runs **before** `AutoModeApprove`. Configured **deny** rules
   therefore *do* bite in prompt mode. This is the containment lever.
2. `SensitiveFileAccessAsk` and `GitControlPathAccessAsk` run **after**
   `AutoModeApprove`, so in prompt mode they never fire. The built-in protections for
   sensitive files and git control paths are inert in exactly the mode Ensync would use.

## Containment

**Level: `cwd_only`, with a documented gap that currently blocks promotion.**

What is real:

- The process `cwd` is the worktree, and `--add-dir` is the only way to widen the
  declared workspace (Ensync would simply never pass it).
- A resumed session is refused if its recorded `cwd` differs from the current one.
- Deny rules genuinely outrank auto-approve (see above). The schema is:
  ```
  PermissionRuleDecisionSchema = enum["allow","deny","ask"]
  PermissionRuleScopeSchema    = enum["turn-override","session-runtime","project","user"]  (default "user")
  PermissionRuleSchema         = { decision, scope, pattern (validated by parsePattern), reason? }
  PermissionConfigSchema       = { rules?: PermissionRule[] }
  ```

What is missing, and why Ensync must not claim `permission_config` for Kimi:

- **There is no per-run way to install those deny rules.** No `--permission`,
  `--deny`, `--allow`, or `--settings` flag exists on the CLI. Rules are read from the
  `[permission]` section of the user-global `config.toml`, resolved as
  `input.configPath ?? join(resolveKimiHome(homeDir), "config.toml")` where
  `resolveKimiHome = homeDir ?? process.env["KIMI_CODE_HOME"] ?? join(homedir(), ".kimi-code")`.
- The project-local file `<projectRoot>/.kimi-code/local.toml` **cannot carry rules**:
  its schema is exactly
  `WorkspaceLocalTomlSchema = object({ workspace: object({ additional_dir: array(string()) }).optional() })`.
  Nothing else is accepted.
- That leaves two bad options, and Ensync should take neither silently:
  1. Mutate the user's global `~/.kimi-code/config.toml` — a persistent, cross-project
     side effect Ensync has no right to make.
  2. Point `KIMI_CODE_HOME` at a Host-managed directory — but that same variable also
     relocates `credentials/` (the stored subscription login lives at
     `~/.kimi-code/credentials/kimi-code.json`), so it would very likely break
     subscription auth. **Unknown, and untestable without a run**: whether credentials
     can be resolved independently of `KIMI_CODE_HOME`. The `oauth` config block
     (`{storage: "file"|"keyring", key, oauthHost}`) hints they might, but this was not
     verified and must not be assumed.

Net effect: in the mode Ensync would use, Kimi auto-approves every tool call including
shell commands and writes outside the worktree, and Ensync has no per-run, non-global
way to constrain it. That is strictly weaker than droid's pinned `medium` autonomy
level, which at least refuses `git push`, sudo, and production changes.

## Auth and usage without a model turn

- `kimi login` — device-code flow. `kimi acp --login` runs the same flow and exits.
- **Stored credential (readable, no model turn):** `~/.kimi-code/credentials/kimi-code.json`
  (mode 0600). Also `~/.kimi-code/device_id`.
- `kimi provider list` shows configured providers and model counts — non-interactive and
  documented as such ("Manage LLM providers non-interactively"). Safe.
- `kimi doctor config [path]` / `kimi doctor tui [path]` validate config files. Safe.
- **Quota/usage: no local read found.** There is no `kimi usage`/`kimi limits`
  subcommand. Nothing in the CLI surface reports remaining subscription capacity
  without a turn.

## Unknowns, stated plainly

- Exact session-ID grammar (needed before resume can be wired).
- Whether `KIMI_CODE_HOME` can be relocated without losing the stored login.
- The `parsePattern` permission-pattern grammar (validated by `isValidPermissionPattern`,
  but the grammar itself was not read).
- Exit codes for prompt mode beyond "throws ⇒ non-zero".
- Whether a very large `-p` argument hits `E2BIG` at a specific size on macOS. Not
  measured; the argv concern stands regardless.

## Ensync decision

**Stays `discovery_only`; gated with an exact reason.** A runner module
(`host/kimi-exec.mjs`) is implemented and unit-tested against the verified argument
construction, NDJSON parsing, terminal-event rule, timeout, cancellation, and failure
paths — so the work is done and reviewable — but the provider is **not** promoted,
for two independently sufficient reasons:

1. The prompt can only be delivered in argv, which Ensync does not do.
2. Containment is not pinnable per run: prompt mode is forced to `auto`, and the only
   rule surface that outranks it is a global config file Ensync must not rewrite.

Either one alone would justify gating. Promotion should wait for a Kimi release that
accepts the prompt on stdin **and** exposes a per-run permission-rule surface.
