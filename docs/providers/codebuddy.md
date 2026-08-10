# CodeBuddy Code — Ensync provider mapping

Verified against the binary installed on this machine on 2026-08-11. Every claim below is
either a direct observation (command + output recorded here) or is marked **UNVERIFIED**.
Nothing in this document is inferred from Claude Code's behaviour without saying so.

**No prompt was ever sent to a model while producing this document.** Every headless probe
ran with empty stdin (`< /dev/null`), which CodeBuddy reports as `duration_api_ms: 0`,
`total_cost_usd: 0`, `input_tokens: 0` — no turn was billed.

## Identity

| Field | Value |
| --- | --- |
| Executable | `/opt/homebrew/bin/codebuddy` (symlink → `../lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy`) |
| `--version` | `2.133.1` |
| npm package | `@tencent-ai/codebuddy-code` |
| Aliases | `codebuddy`, `codebuddy-code`, `cbc` |
| Vendor / hosting | Tencent, `deploymentType: "SaaS"`, endpoint `https://www.codebuddy.ai` |
| Headless bundle | `dist/codebuddy-headless.js` (18 MB), separate from the interactive `dist/codebuddy.js` |

CodeBuddy Code is a Claude Code-family CLI: it reproduces the `-p/--print` +
`--output-format stream-json` contract, the `system`/`assistant`/`result` event
vocabulary, and the `settings.permissions.{allow,deny}` rule schema. The similarity is
useful but is **not** a licence to assume unobserved behaviour — every item below was
re-checked against this binary.

## Authentication state on this machine — the blocking finding

CodeBuddy is **not signed in**, and the CLI gates ordinary subcommands behind that:

```
$ codebuddy help config
Authentication required. Please use /login command to sign in to your account
```

Corroborating evidence:

- `~/.codebuddy/user-state.json` reports `"numStartups": 0`.
- `~/.codebuddy/sessions/` is empty.
- No macOS Keychain item exists for `CodeBuddy` or `codebuddy`
  (`security find-generic-password -s …` → *item could not be found*).
- `~/.codebuddy/local_storage/` holds only cached product config (the endpoint URL and a
  141 KB product-config blob), no credential.

Consequence: **no authenticated turn has ever been observed on this machine.** The
headless probes below still work, because `system.init` is emitted before any model call —
but `tools: []` and `model: "unknown"` in every capture are artefacts of being logged out.
Anything that depends on a real agentic turn is therefore UNVERIFIED, and that is the
reason this provider stays gated (see *Promotion decision*).

Auth mechanism, from `product.json`: `"type": "cli-external-link"` — browser sign-in against
`www.codebuddy.ai`, using an `Authorization: bearerToken` header plus an `X-User-Id` header.
There is **no** documented non-interactive authentication-status subcommand; `config`,
which would be the natural status surface, is itself auth-gated.

## Non-interactive invocation

`codebuddy --help` states plainly: *"starts an interactive session by default, use
`-p/--print` for non-interactive output"*.

| Concern | Finding |
| --- | --- |
| One-shot flag | `-p` / `--print` |
| Prompt via stdin | **Yes — verified.** With `-p` and no argv prompt, CodeBuddy reads stdin to EOF. |
| Prompt via argv | Supported (`codebuddy [options] [prompt]`) but Ensync never uses it. |

### stdin proof (no prompt content sent)

Timing the process against a stdin pipe that stays open for 2 s versus `/dev/null`:

```
{ sleep 2; } | codebuddy -p --verbose --output-format stream-json --permission-mode dontAsk
  → elapsed_ms=2006
codebuddy -p --verbose --output-format stream-json --permission-mode dontAsk < /dev/null
  → elapsed_ms=1093
```

The run blocks until stdin closes, which proves stdin is the prompt channel without
sending a single prompt byte. This matches Ensync's rule that prompts never appear in argv.

## Machine-readable output

Flags: `--output-format text|json|stream-json` (only with `--print`), and `--verbose` is
required for `stream-json` to emit the full event stream. `--input-format text|stream-json`
exists; Ensync uses the default `text`.

Observed stream (empty prompt, logged out), one JSON value per line:

```json
{"type":"system","subtype":"init","uuid":"8d356972-…","session_id":"8d356972-…","apiKeySource":"www.codebuddy.ai","cwd":"/private/tmp","tools":[],"mcp_servers":[],"model":"unknown","permissionMode":"dontAsk","slash_commands":[],"output_style":"default","__timestamp":"…"}
{"type":"result","subtype":"success","is_error":false,"result":"","uuid":"fd778c06-…","session_id":"8d356972-…","duration_ms":61,"duration_api_ms":0,"num_turns":1,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,…},"permission_denials":[],"__timestamp":"…"}
```

**Terminal event proving a completed turn:** a line with `type: "result"`, carrying
`subtype: "success"`, `is_error: false`, and the answer in `result`. The failure variant is
`{"type":"result","subtype":"error_during_execution","is_error":true,…}` (string found in
the headless bundle alongside the success branch).

This is byte-for-byte the shape Ensync's existing `parseClaudeChatResult` already consumes
(`type: "result"` → `is_error` → `result` → `session_id`, plus `system`/`init` for the model
and session fallback), so CodeBuddy reuses that parser rather than duplicating one.

Two stream hazards, both observed:

- **Non-JSON lines can appear on stdout.** `--add-dir /path/that/does/not/exist` printed a
  bare `"/private/tmp/allowed-extra not found"` line into the middle of the JSON stream.
  Ensync's `decodeJsonEventStream` repair tolerates this, but the runner avoids
  `--add-dir` entirely rather than relying on repair.
- **An empty prompt yields `is_error: false` with `result: ""`.** Ensync's parser correctly
  turns that into `empty_cli_response` rather than reporting a successful empty answer.

## Session resume

| Flag | Behaviour |
| --- | --- |
| `--session-id <uuid>` | **Verified honoured** — the supplied id is echoed back as `session_id` in `system.init`. Help text allows letters, numbers, hyphens, underscores and colons, starting with a letter or number; a plain UUID satisfies both this and Ensync's stricter `SESSION_ID_PATTERN`. |
| `-r, --resume [sessionId]` | Resumes a conversation. **Verified failure path:** an unknown id emits exactly one line, `{"type":"error","error":"No conversation found with session ID: …"}`, and **exits 0**. There is no `result` event. |
| `-c, --continue` | Continue most recent conversation. Not used by Ensync (implicit state). |
| `--fork-session` | New id when resuming. Not used. |

The unknown-session path is a real trap: **exit code 0 with no terminal event.** A runner
that trusts the exit code would report success on a run that never happened. Ensync's
runner keys off the `result` event, never the exit status, and surfaces the `error` line's
own text.

## Model selection

`--model <model>`, taking a model **ID**. IDs advertised by `--help` on this build:

```
default-model, gemini-3.1-pro, gemini-3.0-flash, gemini-3.5-flash, gemini-2.5-pro,
gemini-2.5-flash, gemini-3.1-flash-lite, gpt-5.5, gpt-5.4, gpt-5.3-codex, gpt-5.1-codex,
gpt-5.1-codex-mini, deepseek-v3-2-volc, glm-5.0, kimi-k2.5
```

`product.json` carries a 22-entry catalogue with per-model `credits` multipliers
(e.g. `default-model` → `"x2.00 credits"`, `default-model-lite` → `"x0.67 credits"`),
`maxInputTokens`/`maxOutputTokens`, and `supportsToolCall`/`supportsImages` flags. Billing
is **credit-based**, which is why no prompt was sent during this mapping.

Related flags: `--effort <minimal|low|medium|high|xhigh|max>` (reasoning effort — Ensync's
`low|medium|high|max` size tiers are a subset), and `--fallback-model` (only with `--print`).

**UNVERIFIED:** whether an invalid `--model` is rejected or silently ignored.
`--model __no_such_model__` produced no error, but `system.init` reported
`model: "unknown"` because the session is logged out, so this probe cannot distinguish
"silently accepted" from "never resolved". Do not assume validation exists.

## Permission / approval model — and the headless-hang question

Modes accepted by `--permission-mode`, with the CLI's own descriptions extracted from
`dist/codebuddy-headless.js`:

| Mode | CLI's own description |
| --- | --- |
| `default` | "Prompts for permission on first use of each tool" |
| `acceptEdits` | "Automatically accepts file edit permissions for the session" |
| `plan` | Planning mode; agent does not execute changes |
| `bypassPermissions` | "Skips all permission prompts" |
| `dontAsk` | "Never shows permission prompts; runs pre-approved and safe actions, denies anything that would require approval" |
| `auto` | Classifier-driven; "if the classifier is unavailable, the action falls back to a prompt (or is denied when prompts cannot be shown)" |

Related flags: `-y/--dangerously-skip-permissions`, `--subagent-permission-mode`,
`--tools`, `--allowedTools`, `--disallowedTools`, `--max-turns`.

### The pinning flag is fail-open — verified

`--permission-mode` is documented with a `choices:` list, but an unrecognised value is
**silently discarded**, exactly like droid's `.optional().catch(void 0)` autonomy field:

```
--permission-mode __bogus__        → init.permissionMode = "default"
--permission-mode dontAsk          → init.permissionMode = "dontAsk"
--permission-mode acceptEdits      → init.permissionMode = "acceptEdits"
--permission-mode bypassPermissions→ init.permissionMode = "bypassPermissions"
--permission-mode plan             → init.permissionMode = "plan"
--permission-mode auto             → init.permissionMode = "auto"
```

No error, no non-zero exit — the request silently degrades to `default`. **Passing the flag
is therefore not proof that it applied.**

The mitigating discovery is that `system.init` **echoes the effective `permissionMode` and
`cwd`**. That gives Ensync the same verify-before-you-trust hook droid has, and it arrives
*before* any model call. The runner refuses to send the prompt unless the echo matches the
pinned mode — see `host/codebuddy-exec.mjs`.

### `--settings` is also fail-open — verified

A syntactically broken payload is ignored without complaint:

```
--settings '{{{not json'  → normal init + result, no error, exit 0
```

This is the same silent-validation-failure gap already recorded for Claude Code in
`CHAT_PROVIDER_CONTAINMENT`. Deny rules supplied this way cannot be assumed to be in force.

### Does a headless run hang on approval? — **UNVERIFIED, and it is the reason for gating**

The `auto` description says an action "is denied when prompts cannot be shown", which
*suggests* headless runs deny rather than block. That is suggestive, not proof, and it is
the exact failure that made droid hang on "Working" forever. Confirming it requires an
authenticated turn that actually triggers an approval, which cannot be done while logged
out and cannot be done without spending credits.

Ensync's runner mitigates rather than assumes: it pins a mode, verifies the echo, and runs
under the inactivity watchdog so that even a hypothetical blocked approval is terminated
with a `run_timed_out` error instead of hanging indefinitely.

## Containment

| Mechanism | Status |
| --- | --- |
| CWD constraint | `cwd` is set by the spawn and **echoed back** in `system.init` — verified. |
| Path-scoped deny rules | `settings.permissions.deny`, rule grammar `ToolName(ruleContent)` — confirmed from the bundle's `ruleValueToString` / rule parser (`toolName` + parenthesised `ruleContent`). |
| Extra roots | `--add-dir <dirs…>`; also `permissions.additionalDirectories`. Not used by Ensync. |
| Tool restriction | `--tools`, `--allowedTools`, `--disallowedTools` (the bundle maps these onto `settings.permissions.allow` / `.deny`). |
| OS sandbox | `--sandbox container|<E2B URL>` exists, but it is a **Docker/Podman or remote-E2B** sandbox, not a local OS sandbox like Codex's `--sandbox workspace-write`. It relocates the whole run off the protected worktree, so Ensync does not use it. |

**Recorded containment level: `permission_config`** — the same tier as Claude Code and
droid, and for overlapping reasons. Honest caveats, all verified here:

1. **The mode flag fails open.** An unrecognised `--permission-mode` degrades to `default`
   silently. Mitigated only because `system.init` echoes the effective mode and the runner
   checks it.
2. **`--settings` fails open.** Malformed settings JSON is ignored with no error, so deny
   rules are not self-proving.
3. **Deny rules are not an OS boundary.** They are rule-engine entries evaluated by the
   agent process itself, so they constrain the agent's own tools, not arbitrary
   subprocesses that a shell tool may spawn.
4. **Bash is not path-scoped.** The rule grammar is `ToolName(content)`; for shell tools the
   content is a command prefix, not a file glob, so `Write(<canonical>/**)`-style rules do
   not constrain commands run through a shell tool. Same caveat already recorded for Claude Code.
5. **No authenticated turn has been observed**, so none of items 2–4 has been watched
   actually blocking a write. They are read off the CLI's own schema and help text.

## Auth / usage without a model turn

- **Authentication status:** no non-interactive command. `codebuddy config` — the obvious
  candidate — is itself auth-gated and answers `Authentication required…`.
- **Usage / credits:** no CLI surface. `product.json` prices models in credits; the balance
  lives in the web account dashboard. This matches the existing catalogue entry's
  `usageKind: 'unavailable'`.
- **Free, non-billing status commands that do work:** `codebuddy ps [--json]` (active
  sessions; returned `No active sessions.`), `codebuddy agents --jobs`, `codebuddy doctor`,
  `codebuddy mcp list`.
- **A zero-cost liveness probe exists:** `-p --verbose --output-format stream-json` with
  empty stdin emits `system.init` + `result` with `duration_api_ms: 0` and
  `total_cost_usd: 0`. That is how every probe in this document was taken, and it is a
  legitimate way to read the effective permission mode and cwd without billing.

## Stated unknowns

These are genuinely unknown, not guesses withheld:

- Whether an approval request in a headless run denies or blocks (see above).
- Whether `permissions.deny` rules actually stop a write in a real turn.
- Whether an invalid `--model` is rejected.
- The full `result` event field set for a *failing* authenticated turn
  (`subtype: "error_during_execution"` is known from the bundle; never observed live).
- Whether any quota/credit-exhaustion signal appears in the stream, and in what field —
  so Ensync cannot classify CodeBuddy quota failures from the protocol the way it does for
  droid, and falls back to its generic text matcher.
- Whether `--effort` values map onto Ensync's size tiers with the same meaning.

## Promotion decision

**Stays `discovery_only`, gated with an exact reason.**

Containment *is* pinnable and, unusually, *verifiable* via the `system.init` echo — that
half of the bar is met, and `host/codebuddy-exec.mjs` implements it. The bar is missed on
the other half: the runner has never completed a single authenticated turn, so the
headless approval behaviour — the specific defect that made droid hang forever — remains
unverified, as does whether deny rules stop anything. Promoting on a logged-out CLI would
mean asserting a contract nobody has watched hold.

`GATED_CHAT_PROVIDERS` therefore carries the precise outstanding requirement, so a user who
selects CodeBuddy is told what is missing instead of meeting a crash.

To promote later: sign in (`codebuddy` interactive, browser login), then verify on one real
turn that (a) `system.init` still echoes the pinned mode with tools loaded, (b) a write
outside the worktree is refused, and (c) an approval-triggering action denies rather than
blocks. All three are cheap to check on a single small task.
