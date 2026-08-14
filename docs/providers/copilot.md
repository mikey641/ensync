# GitHub Copilot CLI

Status in Ensync: **`discovery_only`, and explicitly gated for chat**
(`host/providers.mjs` catalog; entry in `GATED_CHAT_PROVIDERS` in
`host/chat.mjs`). Account verification already works through
`host/copilot-auth.mjs`. **No chat runner was written**, deliberately — see
*Why this is gated* at the end.

Everything below was verified on 2026-08-10 from `--version`, `--help`,
`copilot help <topic>`, `copilot login --help`, and local config/state files.
**No prompt was ever sent to a model**, so no paid quota was spent. Unlike Cursor,
the Copilot CLI ships as a compiled single-file Node SEA binary (160 MB, Mach-O,
application code compressed inside the blob and absent from `strings`), and the
npm package `@github/copilot` is only a platform loader. So there is no readable
source to fall back on: anything not stated in `--help` could not be verified
without spending a turn.

## Binary path and version

- `/opt/homebrew/bin/copilot` → `/opt/homebrew/Caskroom/copilot-cli/1.0.78/copilot`
  (Homebrew cask), a Mach-O arm64 executable.
- `copilot --version` → `GitHub Copilot CLI 1.0.79.` (the binary self-updates in
  place, so it reports 1.0.79 from the 1.0.78 cask directory).
- Ensync resolves it from PATH as `copilot`, with `versionArgs: ['version']`.

## Non-interactive invocation

- `-p, --prompt <text>` — "Execute a prompt in non-interactive mode (exits after
  completion)". **The prompt is an argv value.**
- `--allow-all-tools` is documented as **required** for non-interactive mode
  ("Allow all tools to run automatically without confirmation; required for
  non-interactive mode"), also settable via `COPILOT_ALLOW_ALL=true`.
- `-s, --silent` — "Output only the agent response (no stats), useful for
  scripting with `-p`".
- `-i, --interactive <prompt>` starts the TUI and runs a prompt — not usable
  headless.
- `--acp` — "Start as Agent Client Protocol server". The CLI's own logs confirm a
  stdio JSON-RPC server mode ("Starting CLI in server mode (stdio)", "Rust
  JSON-RPC engine"). This is the only observed path on which a prompt would
  travel over stdin instead of argv.
- Canonical documented example:
  `copilot -p "Fix the bug in main.js" --allow-all-tools`

**Prompt on stdin: NOT VERIFIED.** `--help` documents no stdin prompt form, and
the application code is not readable. Third-party write-ups show
`cat error.log | copilot -p "What went wrong?" -s`, which implies piped stdin is
*additional context alongside* an argv prompt, not a replacement for it. Ensync
never puts a prompt in argv, so this is the blocking gap.

## Machine-readable output and the terminal completion event

- `--output-format <format>` accepts `text` (default) or `json`, described as
  "JSONL, one JSON object per line".
- `--stream <on|off>` toggles streaming.

**The object types and the terminal completion object are NOT VERIFIED.** Nothing
in `--help` or the help topics enumerates them, and confirming them requires
running a turn. Ensync refuses to treat a run as successful without a verifiable
completion event, so this alone blocks a runner.

Corroborating (but *not* equivalent) evidence exists on disk: each session writes
`~/.copilot/session-state/<uuid>/events.jsonl`, an internal transcript whose
envelope is `{ "type", "data", "id", "timestamp", "parentId" }` with types
observed including `session.start`, `session.permissions_changed`,
`session.model_change`, `system.message`, `user.message`,
`assistant.turn_start`, `abort`, `session.shutdown`. This is the **session log
format, not the `--output-format json` stdout format**, and the two must not be
assumed identical.

## Session resume

Well specified, and the one area with no ambiguity:

- `-r, --resume[=value]` — resume by session ID, task ID, ID prefix (7+ hex
  chars), or exact case-insensitive name.
- `--continue` — resume the most recent session.
- `--session-id <id>` — resume an existing session/task by ID, **or set the UUID
  for a new session** (so the caller can choose the id up front).
- `-n, --name <name>` — name a new session.
- Id format: UUID, e.g. `--session-id=0cb916db-26aa-40f2-86b5-1ba81b225fd2`.
- State lives in `~/.copilot/session-state/<uuid>/` plus a `session-store.db`.

## Model and effort selection

- `--model <model>` (or `COPILOT_MODEL`; `auto` lets Copilot choose).
  The `config` help topic lists the accepted values, including
  `claude-sonnet-5`, `claude-fable-5`, `claude-opus-5`, `claude-opus-4.8`,
  `claude-haiku-4.5`, `gpt-5.6-sol`, `gpt-5.5`, `gpt-5.3-codex`, `gemini-3.6-flash`,
  `grok-4.5`, `kimi-k3`, and others.
- `--effort, --reasoning-effort <level>` — enum:
  `none | minimal | low | medium | high | xhigh | max`. Ensync's four size tiers
  (`low`, `medium`, `high`, `max`) are all members, so the mapping is 1:1 with no
  invention required.
- `--context <tier>` — `default | long_context`.
- `--enable-reasoning-summaries`, `--agent <agent>`, `--max-ai-credits <credits>`.

## Permission / approval model

The richest and best-documented of any provider surveyed, and fully pinnable from
argv (`copilot help permissions`):

- **Tool visibility:** `--available-tools` (allowlist; hides everything else),
  `--excluded-tools` (denylist). These control what the model can *see*.
- **Tool permission:** `--allow-tool`, `--deny-tool`, `--allow-all-tools`.
  **Denial always wins, even over `--allow-all-tools`.**
- Pattern grammar `kind(argument)`:
  - `shell(command:*?)` — exact command, or prefix with `:*`; matching is on the
    command stem, so `shell(git:*)` matches `git push` but not `gitea`. Approval
    for `git`/`gh` is per first-level subcommand.
  - `write(path?)` — creates/modifies files (excluding shell redirection). A
    relative path matches by trailing components (`write(.env)` matches any
    `.env`); use an absolute path to scope to one location.
  - `<mcp-server-name>(tool-name?)`
  - `url(domain-or-url?)` — applies to shell and web-fetch; protocol-aware.
- **URL permission:** `--allow-url`, `--deny-url` (deny takes precedence),
  `--allow-all-urls`. Bare domains default to `https://`.
- **Blanket:** `--allow-all` / `--yolo` = `--allow-all-tools --allow-all-paths
  --allow-all-urls`. Ensync would never pass these.
- `--no-ask-user` disables the `ask_user` tool so the agent works autonomously
  without asking questions — the flag that would prevent a headless hang.
- Documented example of exactly the shape Ensync wants:
  `copilot --allow-tool='shell(git:*)' --deny-tool='shell(git push)'`

**Not verified:** whether an approval that is *not* pre-resolved by these flags
blocks forever in a `-p` run, and whether a URL confirmation can block when
`--allow-all-tools` is set but `--allow-all-urls` is not. `--allow-all-tools`
being "required for non-interactive mode" hints that unresolved prompts are the
hazard, but the failure mode was not observed.

## Containment

Genuinely pinnable, and the best of the surveyed providers on paper:

- **Path scoping is the default.** "By default, file access is restricted to
  paths within the current working directory and its subdirectories, plus the
  system temporary directory." So spawning with a contained cwd *is* the
  containment; Ensync would simply never pass `--allow-all-paths`.
- `--disallow-temp-dir` removes the automatic temp-directory grant.
- `--add-dir <directory>` widens the allowed set (Ensync would not pass it).
- `-C <directory>` changes the working directory before anything else.
- `--deny-tool` is a real denylist that outranks every allow rule — the
  path-scoped equivalent Droid lacks.
- **OS sandbox (experimental):** `copilot help sandbox` documents Microsoft
  Execution Containers (MXC) — Seatbelt/`sandbox-exec` on macOS, bubblewrap on
  Linux, ProcessContainer on Windows — with filesystem read/write/deny lists,
  network and local-network toggles, git/`gh` credential injection control,
  MCP/LSP subprocess containment, macOS keychain access, and a per-command bypass.
  It is **off by default**, gated behind `--experimental`, and configured through
  `settings.json` under `sandbox` rather than a documented one-shot argv flag —
  the interactive `/sandbox enable` is the documented switch. Honest read: a real
  OS sandbox exists but is not argv-pinnable per run today.
- `--secret-env-vars` strips named variables from shell/MCP environments and
  redacts them from output.

Had a runner been written, the recorded level would have been
`permission_config` (cwd scoping + deny rules), **not** `os_sandbox`, because the
sandbox cannot be pinned per run from argv.

## Auth and usage without a model turn

- `~/.copilot/config.json` records `lastLoggedInUser` / `loggedInUsers`
  (`{ host, login }`). On this machine: `mikey641` at `https://github.com` —
  i.e. Copilot **is** signed in.
- `host/copilot-auth.mjs` already probes auth properly: it drives the CLI's SDK
  server over LSP-style `Content-Length` framing and asks for auth status
  **without creating a session**, so it consumes nothing. It also strips
  `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` first so a PAT cannot
  masquerade as a subscription login.
- `copilot login --help` documents the credential precedence
  (`COPILOT_GITHUB_TOKEN` → `GH_TOKEN` → `GITHUB_TOKEN`), web vs `--device-code`
  flows, and storage in the system credential store (falling back to plaintext
  under `~/.copilot/`). Classic `ghp_` tokens are not supported.
- `subscriptionEnvironment` in `host/command.mjs` already strips
  `COPILOT_OFFLINE`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_BASE_URL`,
  `COPILOT_PROVIDER_TYPE`.

**Usage/quota is not readable headlessly.** `copilot help billing` shows AI
credits only through interactive surfaces (`/usage`, `/statusline quota`, the
footer, the `/exit` summary). There is no non-interactive usage command, so the
catalog keeps `usageKind: 'unavailable'`. `--max-ai-credits <credits>` (minimum
30) caps a session, but it is a soft cap: usage is known only after a response
returns.

## Why this is gated (and what would ungate it)

Recorded verbatim in `GATED_CHAT_PROVIDERS`, so the user sees a truthful reason
rather than a crash. Two independent blockers, both Phase 1 failures rather than
implementation laziness:

1. **Prompt delivery.** The only verified non-interactive prompt input is
   `-p/--prompt <text>`, which is argv. Ensync never puts a prompt in argv.
2. **No verifiable completion event.** `--output-format json` is documented as
   JSONL but its object types — critically, the terminal object that proves a
   turn finished — are undocumented and unreadable in a compiled binary. Ensync
   refuses to call a run successful without one.

Writing a runner on guessed field names would be exactly the kind of invention
Ensync's containment contract exists to prevent, so none was written.

**To ungate**, in order of preference:

1. Verify `copilot --acp` (Agent Client Protocol over stdio JSON-RPC). This is a
   published protocol and would carry the prompt on stdin, solving blocker 1, and
   define its own terminal events, solving blocker 2. It is also the closest
   analogue to the Droid stream-jsonrpc runner Ensync already ships, and
   `host/copilot-auth.mjs` proves the Host can already speak framed JSON-RPC to
   this binary.
2. Failing that, capture one real `-p --output-format json` run and record the
   event schema as a fixture — but that spends quota and still leaves the prompt
   in argv.

Everything else Copilot needs is already in place: permission pinning
(`--deny-tool` outranks all allows), default cwd path scoping, a 1:1 effort enum,
robust session resume, and a working non-consuming auth probe.
