# Cursor Agent

Status in Ensync: **`supported`** (`host/providers.mjs` catalog, `chatExecution: 'supported'`).
Runner: `host/cursor-agent.mjs`. Dispatch: the `request.provider === 'cursor'` block in `host/chat.mjs`.

Everything below was verified on 2026-08-10 against the installed CLI, by reading
its own bundled JavaScript sources (the CLI is a Node bundle, so its behaviour is
readable rather than guessed). **No live turn was ever run**: Ensync's probe rules
forbid spending the account's paid quota, and this machine reports the CLI as
signed out in any case. Where a fact is source-derived rather than observed, it
says so.

## Binary path and version

- Launcher: `/Users/mikeyhasson/.local/bin/cursor-agent` → symlink to
  `/Users/mikeyhasson/.local/share/cursor-agent/versions/2026.08.04-aaa8809/cursor-agent`.
- That file is a Bash wrapper that `exec`s a bundled Node against `index.js`.
- `cursor-agent --version` → `2026.08.04-aaa8809`.
- Ensync resolves it from PATH as `agent`, with `cursor-agent` as an alias
  (`host/providers.mjs`, `commandAliases`).

## Non-interactive invocation

Headless mode turns on when **any** of these is true (verified in the CLI's main
entry): `--print`/`-p` is passed, stdout is not a TTY, or stdin is not a TTY. A
process spawned by the Host satisfies the last two automatically; Ensync passes
`--print` anyway so the mode is stated rather than inferred.

**The prompt travels on stdin.** `./src/commands/build-prompt.ts` joins the argv
prompt array first and only reads stdin when that join is empty *and* stdin is not
a TTY:

```js
let o = e.join(" ");
if (t && 0 === o.length && n) { /* read all of stdin, trim, use as prompt */ }
```

so passing no positional prompt makes stdin the prompt source. This is what lets
Cursor satisfy Ensync's rule that a prompt never appears in argv. The CLI reads
stdin to `end`, so **stdin must be closed after writing** or the turn never
starts.

Ensync's pinned argv (`cursorAgentArguments`):

```
--print --output-format stream-json --sandbox enabled --force --workspace <projectPath>
[--resume=<chatId>] [--model <model>]
```

Flags that only exist in headless mode and are rejected outside it:
`--output-format`, `--stream-partial-output`, `--show-thinking`, `--printenv`,
`--single-turn`, `--conversation-history-file`.

## Machine-readable output and the terminal completion event

`--output-format` accepts `text` | `json` | `stream-json`. Ensync uses
`stream-json`: newline-delimited JSON, one object per line on stdout. Verified
object types emitted by `./src/headless.ts`:

| `type` | Notes |
|---|---|
| `system` / `subtype: "init"` | `session_id`, `model`, `cwd`, `apiKeySource`, `permissionMode` |
| `user` | echo of the prompt |
| `assistant` | `message.content[]` text blocks |
| `thinking` | `subtype: "delta" \| "completed"` |
| `tool_call` | `subtype: "started" \| "completed"`, `call_id`, `tool_call`, `model_call_id` |
| `interaction_query` | `subtype: "request" \| "response"`, `query_type` |
| `retry`, `connection` | `subtype` + detail |
| `system` / `subtype: "task_notification"` | background task status |
| **`result`** | **the terminal event** |

**The completed-turn proof is exactly one line:**

```json
{"type":"result","subtype":"success","is_error":false,"duration_ms":…,"duration_api_ms":…,
 "result":"<final answer>","session_id":"…","request_id":"…","usage":{…}}
```

This is the only event Ensync accepts as completion. It matters that the failure
paths are *silent on stdout*: on an exception the CLI prints the error to stderr
and exits 1; on SIGINT it prints `Operation cancelled` to stderr and exits with
its SIGINT code. Neither writes a `result` line. So "no `result` line" is an
unambiguous failure signal, and `host/cursor-agent.mjs` treats it as
`cursor_agent_disconnected` rather than inventing a success.

`usage` carries `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens` (converted from protobuf BigInt to Number before serialising).

## Session resume

- `--resume [chatId]` — optional-value flag; Ensync always uses the `--resume=<id>`
  spelling so it cannot swallow a following flag.
- `--resume=-1` resumes the latest chat; `--resume=-N` the Nth most recent.
- `--continue` resumes the previous session.
- `create-chat` creates an empty chat and prints its id; `ls` / `resume` are the
  interactive pickers.
- Id format: UUID (the `session_id` in the event stream is the same value).

## Model and effort selection

- `--model <model>` (e.g. `gpt-5`, `sonnet-4-thinking`). `--list-models` and the
  `models` subcommand enumerate what the account can use.
- Effort/reasoning is **not** a separate flag. It is expressed as bracketed
  per-model parameters, e.g.
  `'claude-opus-4-8[context=1m,effort=high,fast=false]'`.
- Ensync deliberately does **not** synthesise those brackets: which models accept
  which parameters is model-dependent and was not verified, and a rejected model
  string would fail the run. `request.effort` is carried through to the result as
  `requestedEffort` and otherwise left unapplied.

## Permission / approval model — the anti-hang property

This is the part that decides whether a headless run can hang, and the answer is
that **it cannot**. `./src/headless.ts` chooses the decision provider up front:

```js
pn = at && un.headlessAutoApprove            // at = isHeadless
yn = at ? (pn ? new AlwaysApprove : new AlwaysDeny) : new AutorunAware(…)
```

and the two headless classes are total functions with no I/O:

```js
class AlwaysApprove { requestApproval() { return Promise.resolve({ approved: true }) } }
class AlwaysDeny    { requestApproval() { return Promise.resolve({ approved: false }) } }
```

Every *interaction query* is likewise answered from a fixed table
(`./src/utils/interaction-responses.ts`): `askQuestionInteractionQuery` is
rejected with a reason ("Questions skipped…"), `switchModeRequestQuery` is
approved, `mcpAuthRequestQuery` / `connectScmRequestQuery` are rejected as
unsupported in CLI mode, and web search/fetch are approved only under
run-everything. **There is no headless code path that waits on a human**, which
is precisely the failure that used to hang Droid runs at "Working".

`headlessAutoApprove` is true only when run-everything is wanted
(`--force`/`--yolo`, or a persisted `approvalMode: "unrestricted"`) *and* team
policy permits it. If `--force` is passed while an administrator has disabled it,
the CLI exits 1 with "Your team administrator has disabled the 'Run Everything'
option" — Ensync maps that to `provider_permission_declined`.

**The consequence Ensync must be honest about:** approval in headless is
all-or-nothing. Without `--force` every operation is denied, so the agent cannot
edit a file or run a command and the run is useless. With `--force` nothing is
denied, and the persisted `permissions.deny` list in `~/.cursor/cli-config.json`
is **never consulted on the headless path**. Ensync pins `--force`, so there is
no permission-layer containment at all.

Related flags: `--auto-review` (server classifier picks per-command; conflicts
with `--force`), `--approve-mcps`, `--mode plan|ask` (read-only modes),
`--trust`.

## Containment

Because the approval layer contributes nothing under `--force`, containment is
the OS sandbox plus the workspace root:

- **`--sandbox enabled|disabled`** overrides both the persisted `sandbox.mode` and
  the server-side default. Resolution order verified as
  `sandboxOverride ?? config.sandbox.mode ?? serverDefault`.
- The sandbox setting is passed into the **tool/executor** construction
  independently of the decision provider, so it still applies under
  `AlwaysApprove`. Enforcement is real: the local-exec bundle shells out to
  `/usr/bin/sandbox-exec` (macOS Seatbelt); Linux uses a bubblewrap-style backend.
- **Fail-closed, which is what Ensync depends on:** in headless mode, if the
  sandbox is enabled but unsupported on the host, the CLI exits 1 with "Sandbox
  mode is enabled but not available on this system" instead of silently running
  unsandboxed. `host/cursor-agent.mjs` maps that to
  `provider_containment_unverified`.
- **Workspace scope:** `--workspace <path>` sets the root (Ensync passes the
  contained project path and also spawns with it as cwd); `--add-dir` would add
  more roots and Ensync never passes it; `-w/--worktree` would relocate work into
  `~/.cursor/worktrees/…` and Ensync never passes it, because the Host owns
  worktree placement.
- Persisted config lives at `~/.cursor/cli-config.json`
  (`permissions.allow/deny`, `approvalMode`, `sandbox.mode`,
  `sandbox.networkAccess`) and `~/.cursor/permissions.json`
  (`terminalAllowlist`, `autoRun.allow_instructions` / `block_instructions`).
  Ensync does not write either file.

Recorded in `CHAT_PROVIDER_CONTAINMENT` as `{ level: 'os_sandbox', sandboxMode: 'enabled' }`
with the all-or-nothing approval gap written out in full.

## Auth and usage without a model turn

- `cursor-agent status --format json` (alias `whoami`) — no model turn. On this
  machine it returns:
  ```json
  {"status":"unauthenticated","isAuthenticated":false,"hasAccessToken":false,
   "hasRefreshToken":false,"message":"Not logged in"}
  ```
  Ensync parses this in `parseCursorAuthentication` (`host/providers.mjs`), which
  reports `authenticated` with method `Cursor login`, or `not_authenticated`.
- `cursor-agent about --format json` — version, system, and account information.
- `cursor-agent models` — the account's model list.
- `login` / `logout` manage credentials; `CURSOR_API_KEY` / `--api-key` are the
  token path, and `subscriptionEnvironment` in `host/command.mjs` **strips
  `CURSOR_API_KEY`** so an Ensync run can only use the stored subscription login.
- A headless run with no credentials exits 1 with "Error: Authentication
  required…" → `provider_not_authenticated` (safe to retry).

**No quota/usage command exists.** `status` exposes no usage percentage, model
allowance, or reset time, so the catalog keeps `usageKind: 'unavailable'` rather
than inventing a number.

## Unknowns

- **No live end-to-end run has ever been observed.** Every claim above is read
  from the CLI's own sources or from non-consuming status commands. The stream
  parser is therefore unproven against real traffic.
- The CLI is signed out on this machine, so even the auth-gated path could not be
  exercised. Ensync's own `provider_not_authenticated` gate in `chat.mjs` fires
  before a run starts, so this surfaces as a clean 409 rather than a crash.
- Exact `tool_call.tool_call` payload shape is inferred from protobuf-es oneof
  serialisation (`{ tool: { case, value } }`); the runner tolerates a plain
  `{ tool: { <name>: … } }` shape too, and degrades to no tool label rather than
  throwing.
- Whether `--sandbox enabled`'s default filesystem policy permits everything a
  build needs (package caches, toolchains) was not measured. If it proves too
  tight in practice, the failure is a failed command inside the run, not a hang.
- Result subtypes other than `success` were not found in the sources; the runner
  treats any non-`success` subtype as `cli_failed` defensively.
- `--single-turn` and `--conversation-history-file` are undocumented in `--help`
  but accepted in headless mode; Ensync does not use them.
