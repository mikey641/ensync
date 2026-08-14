# Auggie (Augment Code) — Ensync provider map

Verified 2026-08-11 against the installed CLI. Facts came from `--version`, `--help`,
subcommand `--help`, local state files, and **the CLI's own shipped source** — Auggie is
distributed as a readable (minified but unobfuscated) ESM bundle at
`/opt/homebrew/lib/node_modules/@augmentcode/auggie/augment.mjs`, so option tables,
output schemas, and the permission engine were read directly rather than inferred.
**No instruction was ever sent to a model.** Where a claim could only be settled by
running a turn, it is marked unknown.

## Binary and version

- `/opt/homebrew/bin/auggie` → symlink to
  `/opt/homebrew/lib/node_modules/@augmentcode/auggie/augment.mjs` (a Node ESM entry
  point; `package.json` declares `engines.node >= 20`, the README says 22+).
- `auggie --version` → `0.34.0 (commit 81042879)`, exit 0. Runs offline, no auth needed.
- Local state: `~/.augment/` (`.auggie.json` metadata, `sessions/`, `task-storage/`).
  Cache dir is `~/.augment` by default, overridable with `--augment-cache-dir <path>`.

## Non-interactive invocation

- One-shot flag: **`-p` / `--print`**. Help text: *"Print mode (one-shot). Note that the
  indexing confirmation prompt is skipped in print mode. Only use --print from a
  workspace root that you want to index."*
- **Prompt on stdin is supported, and it is the path Ensync uses.** From the bundle's
  own config assembly:

  ```js
  let f = this.config.input.instruction, h = this.config.input.instructionFile
  h && (f = await vQn(h, this.logger, !0))
  let A = null
  if (this.config.output.mode === "text") {
    A = await JEe()                                   // read stdin, non-TTY only
    A && (f ? (f = `${f}\n\n${A}`) : (f = A))
  }
  ```

  `output.mode` is `"text"` whenever `--print` or `--quiet` is passed (`n.acp ? "acp" :
  n.mcp ? "mcp" : (n.print || n.quiet) ? "text" : "tui"`). `output.format` (`text` /
  `json`) is a **separate** field, so `--print --output-format json` still reads stdin.
- Argv forms also exist and are deliberately unused by Ensync: a positional
  `[instruction]`, `-i/--instruction <text>`, and `-if/--instruction-file <path>`
  (`--instruction` and `--instruction-file` are mutually exclusive; the CLI throws
  `Cannot specify --instruction with --instruction-file`).
- **Stdin timing caveat, verified in the bundle.** The stdin reader `JEe()` is:

  ```js
  process.stdin.isTTY === true ? null : new Promise(t => {
    let e = "", n = false,
        r = setTimeout(() => { n || (i(), t(null)) }, 100)   // 100 ms first-chunk window
    ...
    process.stdin.once("end", s); process.stdin.on("data", o); process.stdin.resume()
  })
  ```

  If the **first** stdin chunk has not arrived within 100 ms of that read starting, the
  CLI gives up on stdin and proceeds with an empty instruction. Once any data arrives the
  timer is cleared and it waits for EOF. A Host runner must therefore write the prompt and
  `end()` the stream immediately after spawn, never after an async step.
- Other input: `--image <path...>` (PNG/JPEG/GIF/WEBP), `--file <path...>` (PDF),
  `--queue <text>` (repeatable, requires `--print`; incompatible with
  `--instruction-file`).

## Machine-readable output

- `--output-format <format>`: `"text"` (default) or `"json"`. Only works with `--print`.
- The JSON form is **one object printed once**, not a stream. There is no NDJSON /
  stream-json mode. In `json` format the CLI suppresses all per-tool and per-chunk
  console output (`onAssistantResponseChunk`, `onToolCallStart`, `onToolCallResult` all
  return early when `format === "json"`), buffers the assistant text into `finalMessage`,
  and prints the object in `onAgentLoopComplete`.

### Terminal event proving a completed turn

Exact shape, copied from `onAgentLoopComplete` in the bundle:

```js
{
  type: "result",
  result: this.finalMessage,          // final assistant text
  is_error: this.jsonOutputStatus.is_error,
  subtype: this.jsonOutputStatus.subtype,
  session_id: this.sessionId,
  num_turns: this.numTurns,
  request_id: e,
  ...(billing ? { billing } : {}),         // only with --show-cost
  ...(retries ? { retry_stats: {...} } : {})
}
```

`jsonOutputStatus` starts as `{ is_error: false, subtype: "success" }` and is only
changed by these three handlers:

| handler | `is_error` | `subtype` |
| --- | --- | --- |
| `onError` | `true` | `error_during_execution` |
| `onMaxIterationsExceeded` | `true` | `error_max_turns` |
| `onEmptyCompletion` | `false` | `empty_completion` |

**Ensync's success proof:** a stdout line parsing as an object with `type === "result"`,
`is_error === false`, and `subtype === "success"`. Anything else — including
`empty_completion`, which is *not* flagged as an error by the CLI — is not a completed
turn.

Parsing must be defensive rather than "stdout is the JSON": non-JSON lines are printed
around it on the same stream (observed live, unauthenticated:
`Warning: Could not fetch tenant MCP server configurations: Please configure Augment API URL`).
So: scan every stdout line, keep the last one that parses into a `type: "result"` object.

## Session resume

- `-c` / `--continue` — continue the most recent session in this workspace.
- `-r` / `--resume [sessionId]` — resume by **ID or ID prefix**; omitting the value opens
  an interactive picker, which a headless run must never do, so Ensync always supplies an
  explicit ID.
- `--dont-save-session` — do not persist history.
- `auggie session list|delete|share|stats` manage saved sessions.
- The ID to feed back is `session_id` from the terminal `result` object. **Its format was
  not verified**: `~/.augment/sessions/` is empty on this machine, and no authenticated run
  has produced one. It is treated as an opaque string; it is *not* assumed to be a UUID
  (Ensync's shared `SESSION_ID_PATTERN` is UUID-only, so an Auggie session ID may not be
  routable through the generic request field without a change there).
- Constraint from the bundle: `Cannot specify --resume with --continue`.

## Model and effort selection

- Model: `-m` / `--model <id>`. Valid IDs come from `auggie model list`, which requires a
  signed-in account (it answered *"You are not currently logged in to Augment"* here), so
  **no concrete model ID has been verified**.
- Persona: `--persona <id>` — a different axis (agent personality/system prompt), not an
  effort tier.
- **There is no effort / reasoning-level flag.** Ensync's Model-size tiers (low/medium/
  high/max) have no Auggie equivalent, so effort is simply not sent rather than mapped
  onto something it does not mean.
- Related run bound: `--max-turns <n>` (only works with `--print`).

## Permission / approval model

This is the crux, and Auggie's answer is unusually well-evidenced because the engine is
readable in the shipped bundle.

- Flag: **`--permission <rule>`**, repeatable, format `tool-name:policy`. Parser `hYo`:
  - tool name must match `/^[a-zA-Z0-9_-]+$/`;
  - policy ∈ `allow` | `deny` | `ask-user` | `webhook-policy(<url>)` |
    `script-policy(<path>)`;
  - `script-policy` paths are resolved and checked for existence + `R_OK` + `X_OK` at
    parse time.
  - Command-line permissions take precedence over `settings.json` permissions.
- Related flags: `--remove-tool <tool-name>` (repeatable; drops the tool entirely) and
  the hidden `--disable-process-tools` (drops `launch-process`, `read-process`,
  `write-process`, `kill-process`, `list-processes` in one switch). Also `-a`/`--ask`
  ("ask mode for retrieval and non-editing tools only").
- Resolution order, from `b2e` / `EEi`: the strongest matching rule wins —
  `deny`(5) > `webhook-policy`(4) > `script-policy`(3) > `ask-user`(2) > `allow`(1).
- **Default with no rules is ALLOW EVERYTHING.** `b2e` begins:
  `let o = r ? r.filter(...) : []; if (o.length === 0) return { allow: true }`.
  An Auggie run with no `--permission` flags and no settings file runs every tool without
  asking.
- **A headless approval cannot hang.** In `callTool`, when a rule denies with reason
  `ask-user`, the approval callback is
  `this.eventListener?.onToolApprovalRequired?.bind(...)`. In `--print` mode the event
  listener is the print/JSON reporter class, which defines no `onToolApprovalRequired`,
  so the callback is `undefined` and control falls into the `else` branch, which returns
  a tool result `{ text: <explanation>, isError: true }` and logs
  `Tool execution denied for: <tool> (reason: <denialReason>)`. The denial text is fed
  back to the model ("User approval required… Do not attempt to run variations of this
  command, instead use a different approach."), the loop continues, and the turn still
  ends with a `result` object. **This is the opposite of the droid hang.**
  (Verified by reading the code path, **not** by watching a live run — see Unknowns.)
- Tool names available for rules, from `auggie tools list` (runs offline, no auth):
  `remove-files`, `save-file`, `apply_patch`, `str-replace-editor`, `view`,
  `launch-process`, `kill-process`, `read-process`, `write-process`, `list-processes`,
  `web-fetch`, `view-session`, `codebase-retrieval-raw`, `view_tasklist`,
  `reorganize_tasklist`, `update_tasks`, `add_tasks`, `grep-search`,
  `view-range-untruncated`, `search-untruncated` (20 total, all enabled by default).

### Fail-open gap in `--permission` (recorded, not hidden)

`AYo`, the argParser, is:

```js
function AYo(t, e = []) {
  try { return e.concat([hYo(t)]) }
  catch (n) { return console.warn(`WARNING: Failed to parse permission rule "${t}": …`), e }
}
```

A malformed rule is **warned about on stdout and silently dropped** — the run proceeds
with weaker permissions rather than refusing to start. This is the same class of trap as
Claude Code's silently-ignored `--settings` and droid's `.optional().catch(void 0)`
autonomy field. Mitigation available to a runner: build only rules it knows parse, and
treat a `WARNING: Failed to parse permission rule` line on stdout as a hard containment
failure. There is **no** echo of the effective permission set (unlike CodeBuddy's
`system.init`), so that stdout warning is the only available signal.

## Containment

Honest level: **`permission_config`**. Specifically:

- **There is no OS sandbox and no path jail.** Nothing in the CLI restricts writes to the
  working directory; `launch-process` spawns a real shell.
- `-w` / `--workspace-root <path>` sets the root Auggie *indexes and reasons about*
  (auto-detects the git root when absent). It is a context boundary, not an enforcement
  boundary. `--add-workspace`, `--discover-workspaces`, `--no-discover-workspaces` widen
  or narrow that same indexing scope.
- Process cwd is the only positional constraint, and it is advisory in exactly the way
  droid's is: a `launch-process` command may `cd` anywhere the user can reach.
- Rules are matched on the **tool name only** (`AEi`: `t.toolName === e`). The one
  content-aware knob, `shellInputRegex` (matched against `command` for `launch-process` /
  `shell` / `bash`), exists **only in the `settings.json` rule schema** — the
  `--permission` string form cannot express it. So a runner can deny the shell entirely,
  or allow it entirely, but cannot allow a safe subset from argv.
- Denials are enforced by the agent process itself (it returns an error tool-result to
  the model), not by the kernel. A compromised or buggy agent process is not contained by
  them.
- Practical Ensync pinning that *is* expressible from argv: `--permission
  <tool>:deny` for each tool Ensync will not permit, plus `--remove-tool` for tools it
  wants gone, plus `--max-turns` as a run bound.

## Auth and usage without a model turn

- `auggie account status` → *"You are not currently logged in to Augment. Run 'auggie
  login' to authenticate first."* Runs offline, no model turn, human-readable only (no
  `--json`). **This machine is not signed in.**
- `auggie token print` — "Print the current authentication session for automation". Not
  run here: it prints a live credential.
- Credentials: `~/.augment/session.json` (absent here) or the `AUGMENT_SESSION_AUTH`
  environment variable; `--augment-session-json <json|path>` passes one per-run.
  `GITHUB_API_TOKEN` / `--github-api-token <path>` are separate.
- Usage/quota: `auggie account status` (balance + credit information) and
  `auggie session stats [sessionId]` (per-session credit usage); `--show-cost` adds a
  `billing` block (`usage_unit`: `credits` | `usd`, `total_cost`, `parent_cost`,
  `sub_agent_cost`) to the terminal JSON. All require a signed-in account, so **no
  quota shape has been verified on this machine**.
- `auggie tools list` and `auggie --version` are the only commands confirmed to work
  fully offline.

## Unknowns, stated plainly

1. **No authenticated turn has ever been observed.** Everything about live behaviour —
   that a denied tool really does return an error result instead of stalling, that the
   `result` object really is emitted, that stdin delivery beats the 100 ms window in
   practice — is read from the shipped source, not watched.
2. `session_id` format is unknown (no session has ever been created here).
3. Valid `--model` IDs are unknown (`auggie model list` needs auth).
4. Whether a `WARNING: Failed to parse permission rule` line goes to stdout or stderr was
   not confirmed; `console.warn` in Node writes to stderr, but the bundle's own `Y`/`ze`
   helpers are used inconsistently elsewhere. A runner should watch both.
5. Whether `--print` triggers workspace indexing that uploads code before the first
   model call — the help text warns *"Only use --print from a workspace root that you
   want to index"* — and what that costs, was not measured.

## Ensync decision

**Runner implemented (`host/auggie-exec.mjs`), catalog left `discovery_only`, gated with
its exact outstanding requirement.**

Promotion is withheld for the same reason CodeBuddy is withheld: the CLI is not signed in
on this machine, so no authenticated turn has ever been verified. The headless-approval
answer is strong (it is a read of the actual code path, and it says "deny and continue",
not "wait forever") but it has never been *watched*, and that is precisely the defect
gating exists to prevent. Containment is also `permission_config` with no path scoping and
a fail-open argument parser, so a promotion would be claiming more than has been shown.
