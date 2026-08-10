# Junie (JetBrains) — Ensync provider map

Verified 2026-08-11 against the installed CLI. Facts came from `--help`, `--version`,
local config/state files, **the CLI's own bundled documentation** (JetBrains ships the
full docs as an agent skill inside the release jar, mirrored on disk at
`~/.junie/versions/2548.5/skills/junie-cli-docs/`), and constant-pool strings extracted
from the release jar's classes. **No task was ever sent to a model.** Where a claim
could only be settled by running a turn, it is marked unknown.

## Binary and version

- Launcher: `/Users/mikeyhasson/.local/bin/junie` — a bash shim (`JUNIE_MANAGED_SHIM`)
  that applies pending updates and execs the selected version.
- Real binary: `~/.local/share/junie/versions/<version>/Applications/junie.app/Contents/MacOS/junie`
  (a jpackage'd JVM app; code lives in `Contents/app/junie-release-<version>.jar`).
  `~/.local/share/junie/current` symlinks the active version.
- `junie --version` → `Junie version: 26.8.3 (2548.5)`
- Note for a Host runner: the shim can perform an **update** before exec. `--skip-update-check`
  exists precisely for CI/automation and should always be passed.

## Non-interactive invocation

- Argv forms: `junie "Fix the bug in the login function"` (positional) or
  `junie --task="Fix the bug"`.
- **Prompt on stdin is supported.** The CLI has an explicit stdin input path, proven by
  its own error strings in `cli/JunieCli.class`:
  - `The --task option is not supported when reading input from stdin`
  - `Positional arguments are not supported when reading input from stdin`
  - `The --merge-conflicts option is not available when reading input from stdin`

  So stdin and `--task`/positional are mutually exclusive, which is exactly the shape
  Ensync wants: pipe the prompt, pass no task argv.
- `--input-format=<text|json>` selects how that stdin payload is parsed. The JSON shape
  is `CliInput` (`standalone/api/CliInput`), whose fields include `sessionId`,
  `codeReview`, `debug`, `merge`, `rebase`, `orchestrated`; a parse failure reports
  `Cannot parse input JSON: ...`.
- Env alternatives to argv also exist: `EJ_TASK`, `EJ_PROJECT`, `EJ_FOLDER_AGENT_CACHES`.
- `-p, --project=<dir>` sets the project directory (default: cwd).
- **Partially unverified:** the exact trigger that puts the CLI into stdin mode. The
  class references both `available` (consistent with `System.in.available()`) and
  `java.io.Console` (consistent with a TTY check), so it appears to auto-detect a piped
  stdin, likely in combination with `--input-format`. This was not confirmed by running
  it, and a runner must therefore pass `--input-format` explicitly rather than rely on
  auto-detection.
- **Release-build gaps:** this build rejects several documented flags outright —
  `The --review / --demo / --gateway / --prepare-pr-structure option is not available in
  this version. Please use the Nightly build.` Do not wire any of them.

## Machine-readable output

- `--output-format=<text|json|json-stream>`; `--json-output-file=<path>` redirects the
  JSON output to a file instead of stdout.
- `json` emits a single final `CliOutput` object. Verified field names:
  `taskName`, `result`, `changes` (a list of `org.jetbrains.a2ux.api.FileChange`),
  `errors` (list of strings), `llmUsage`.
- `llmUsage` is `LlmUsageOutput` with verified fields: `calls`, `inputTokens`,
  `outputTokens`, `cacheInputTokens`, `cacheCreateTokens`, `cost`. This maps cleanly
  onto Ensync's usage record.
- `json-stream` emits `CliStreamEvent` lines. Verified field names: `name`, `message`,
  `details`, `output`, `result`, `changes`, `llmUsage`, `sessionId`, `timestamp`, plus a
  leading discriminator field.

### Terminal event proving a completed turn

**Not yet pinned down — this is the main documentation gap for Junie.**

- For `--output-format=json`, the terminal artifact is the single `CliOutput` object
  with its `result` and `errors` fields. That is a usable completion proof, but the
  success/failure discriminator (what `errors` looks like on success, and whether
  `result` is ever null on a completed run) was **not** verified, because verifying it
  requires a real turn.
- For `json-stream`, the underlying event union is `org.jetbrains.a2ux.api.AgentEvent`.
  The concrete event classes were enumerated from the jar and include
  `AgentStartedEvent`, `AgentStateUpdatedEvent`, `AgentFailureEvent`,
  `ResultBlockUpdatedEvent`, `StreamingAgentMessageCompletedEvent`,
  `StreamingAgentMessageAbortedEvent`, `AgentPatchCreatedEvent`, and
  `ContextWindowReportEvent`. `ResultBlockUpdatedEvent` and `AgentFailureEvent` are the
  obvious terminal candidates, but the **serialized `type` discriminator values were not
  recovered** (kotlinx `@SerialName` values did not survive the constant-pool
  extraction), so Ensync cannot yet match on an exact terminal string.

Because Ensync will not call a run successful without verifiable completion, a Junie
runner must use `--output-format=json` (single terminal object) rather than
`json-stream`, until the stream discriminators are captured from a real run.

## Session resume

- `--session-id=<text>` — ID of a previously executed session to follow up.
- `--resume` — resume the last session, or the one named by `--session-id`.
- ID format observed on disk: `session-260811-012218-18h8`
  (`~/.junie/sessions/session-260811-012218-18h8/transcript.md`) — i.e.
  `session-YYMMDD-HHMMSS-<4 chars>`. **Not a UUID**, so Ensync's `SESSION_ID_PATTERN`
  would need widening before resume could be wired.
- `sessionId` also appears in both `CliInput` (stdin JSON) and `CliStreamEvent`.
- Junie retains full context for the last 10 sessions.

## Model and effort selection

- `--model=<text>` — model for the primary agent.
- `--effort=<text>` — **documented values `low`, `medium`, `high`.** Ensync's Model-size
  tiers are `low|medium|high|max`; the first three map 1:1, and `max` has no Junie
  equivalent on the CLI. (The interactive docs mention `XHigh`/`Max` for some models,
  but the CLI flag's own help enumerates only three, so only three may be sent.)
  `JUNIE_EFFORT` is the env equivalent.
- `--provider=<openai|anthropic|google|xai|openrouter|copilot|litellm>` selects a BYOK
  provider. **Ensync must never set this**: BYOK bills the user's own API key directly
  instead of their JetBrains subscription. Leaving it unset uses the Junie/JetBrains
  provider, which is the subscription path.
- `--agent-mode=<classic|chat>` for new sessions.

## Permission / approval model

Junie has the **richest and most Ensync-shaped** permission model of the three CLIs —
and simultaneously the one unresolved hang risk.

Documented behaviour (`Junie-CLI.md`, `Action-Allowlist-Junie-CLI.md`):

- "For running potentially sensitive actions, such as executing most of the terminal
  commands, editing files outside the project, or invoking MCP tools, Junie CLI will ask
  for approval from the user."
- **Brave mode** has three levels: `Off` (ask for every sensitive action not on the
  allowlist), `Auto` (classify terminal commands with a safety check, auto-approve the
  ones judged safe, still ask for risky/unrecognised ones and for other sensitive
  actions), `On` (execute all sensitive actions without approval).
- Current user setting on this machine: `~/.junie/settings.json` → `"braveMode": "AUTO"`.
- The `--brave` flag is documented as **"(interactive only)"**.

**The unresolved risk.** `--brave` being interactive-only means there is no verified
argv switch that pins approval behaviour for a headless run, and the `json-stream` event
union contains genuine approval-request events: `ApprovableBlockUpdatedEvent`,
`AskRequestUpdatedEvent`, `AskAsyncRequestUpdatedEvent`, `ChoiceRequestUpdatedEvent`,
`GoalPlanApprovalRequestUpdatedEvent`. Those types existing in the CLI's own event
vocabulary means a run **can** reach a state where it is waiting on a person.

Whether a headless run suppresses them (auto-approving, as CI would need) or blocks
forever on one is **unknown**, and it is unknown for a specific reason: settling it
requires a run that triggers a sensitive action, which means spending a real model turn.
This is precisely the failure mode that made droid hang on "Working", so it is not a
gap Ensync may assume away.

Mitigation that does exist, but is global: `~/.junie/allowlist.json` (see next section)
has a top-level `"defaultBehavior"` which the docs illustrate as `"ask"`; setting it to
allow, or adding `allow` rules, removes the ask. No flag relocates that file per run.

## Containment

**Level: `permission_config`, path-scoped — the strongest of the three — but the file is
global, so it is not pinnable per run.**

`~/.junie/allowlist.json` is a genuine path-scoped policy, materially better than
droid's risk-tier autonomy level. Documented shape:

```json
{
  "defaultBehavior": "ask",
  "allowReadonlyCommands": true,
  "rules": {
    "fileEditing":        { "rules": [{ "prefix": "src/main/kotlin/", "action": "allow" }] },
    "executables":        { "rules": [{ "prefix": "git", "action": "allow" },
                                      { "pattern": "npm [iur]*", "action": "ask" }] },
    "mcpTools":           { "rules": [{ "prefix": "github-server:", "action": "allow" }] },
    "readOutsideProject": { "rules": [{ "pattern": "/etc/**", "action": "ask" }] }
  }
}
```

- Four rule categories: `fileEditing` (edits outside the project dir, and build scripts
  inside or outside), `executables` (terminal commands), `mcpTools`, and
  `readOutsideProject` (reads outside the project dir).
- Each rule is `prefix` (literal) or `pattern` (glob: `*`, `**`, `?`, `[abc]`, `[!abc]`)
  plus `action` = `allow` | `ask`. First match wins, top to bottom.
- `fileEditing` prefixes are **relative to the project directory** unless they start with
  `/`. That is real path scoping of the kind Ensync's protected worktree wants.
- The field names are corroborated by the compiled classes: `AllowListConfig` carries
  `defaultBehavior`-equivalent `AllowListDecision`, `allowReadonlyCommands`, and
  `rules`; `AllowListChecker` exposes exactly two well-known instances, `ALLOW_ALL` and
  `ASK_ALL`.

CWD constraint: `-p/--project=<dir>` sets the project root, and the allowlist's
`fileEditing` / `readOutsideProject` categories are defined *relative to that root* —
so unlike Kimi and Jules, Junie does have a first-class notion of "inside the project".

The gaps Ensync must record rather than paper over:

1. **No per-run allowlist path.** The docs give one location, `~/.junie/allowlist.json`.
   No CLI flag redirects it. `--config-location` loads extra `config.json` files, but
   the documented `config.json` field list (`model`, `provider`, `brave`, `flags`,
   `mcp-locations`, `skill-locations`, `command-locations`, `agent-locations`,
   `model-locations`, `auto-update`, `guidelines-location`, `time-limit`, `byok`,
   `proxies`, `hooks`) **does not include an allowlist**. So the same objection as Kimi
   applies: Ensync would have to rewrite a user-global file.
   - `config.json` *does* include `brave`, so `--config-location <host-managed.json>`
     with `{"brave": ...}` is a plausible per-run lever. **Unverified**: whether `brave`
     from a config file is honoured in a non-interactive run given that the `--brave`
     *flag* is interactive-only. Do not rely on it until tested.
2. **Project trust.** Interactive runs prompt for a trust decision; per the docs,
   "Non-interactive JSON, ACP, and Gateway launches are always trusted: they cannot ask
   you for a decision, so they load project configuration without a prompt." That is
   good for not hanging, but it means a headless run **will** load
   `<project>/.junie/config.json`, MCP servers, hooks, skills, and custom agents from the
   repository being worked on. For an Ensync protected worktree containing a
   third-party repo, that is untrusted-input execution and must be reasoned about
   before promotion. (`hooks` from the default *project* config are ignored "for
   safety", but MCP servers and skills are not.)
3. `--config-default-locations false` can switch off both default `config.json`
   locations, which is the obvious mitigation for (2). Unverified in a real run.

## Auth and usage without a model turn

- Interactive login via JetBrains Account (browser), or `JUNIE_API_KEY`, or BYOK keys.
  Non-interactive: `junie --auth="$JUNIE_API_KEY" "task"` is the documented CI form.
- **Readable state, no model turn:**
  - `~/.junie/settings.json` — `sessionCount`, `braveMode`, `effortPerModel`,
    `subagentsMode`.
  - `~/.junie/.secure_storage_available` — whether native secure storage is usable.
  - `~/.junie/sessions/<session-id>/transcript.md` — prior session transcripts.
  - `~/.junie/trust/` — project-trust markers (default location per the docs).
  - `~/.junie/logs/` — extensive local logs.
- Credentials themselves are in macOS Keychain (or an `authentication-key` file fallback
  inside the trust directory), so login state is **not** simply a readable JSON file the
  way it is for Jules and Kimi.
- `--gateway-status` is documented as "Print status of the running Junie gateway (pid,
  host, port, work directory) and exit". Run here, it emitted terminal control sequences
  and exited without printing a status block (no gateway was running). It did **not**
  start a model turn.
- **Quota/usage:** the `/usage` slash command shows cost and remaining balance, but it is
  interactive-only. Per-run usage does come back in `CliOutput.llmUsage`
  (`calls`, `inputTokens`, `outputTokens`, `cacheInputTokens`, `cacheCreateTokens`,
  `cost`) — but only *after* a run. There is no pre-run capacity probe.

## Unknowns, stated plainly

- Whether a headless run can block on an approval request, or auto-approves. **This is
  the blocking unknown.**
- The exact `type` discriminator strings for `json-stream` events, hence the exact
  terminal event.
- The success/failure discriminator inside the `--output-format=json` `CliOutput`.
- The precise condition that switches the CLI into stdin-reading mode.
- Whether `config.json`'s `brave` field is honoured non-interactively.
- Exit codes for headless runs.
- Whether `--config-default-locations false` fully prevents loading project-supplied MCP
  servers and skills from an untrusted worktree.

## Ensync decision

**Stays `discovery_only`; gated with an exact reason.** A runner module
(`host/junie-exec.mjs`) is implemented and unit-tested against the verified argument
construction, stdin prompt delivery, `CliOutput` parsing, usage mapping, timeout,
cancellation, and failure paths. It is **not** promoted, because the one thing Ensync
most needs to know — whether an approval request can hang a headless run — is exactly
the thing that cannot be established without spending a model turn.

Junie is nonetheless the **best promotion candidate of the three**: it takes the prompt
on stdin, emits a machine-readable terminal object with real usage numbers, supports
model and effort selection, and has genuine path-scoped containment relative to a
project root. Closing the approval-behaviour question (and pinning the allowlist per run)
is the whole remaining distance.
