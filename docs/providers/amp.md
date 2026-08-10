# Amp (Sourcegraph / ampcode.com) — Ensync provider map

Verified 2026-08-11 against the installed CLI. **The binary does not run on this machine**
(see below), so almost nothing could be observed live. What *is* recorded here came from
the binary's own embedded option table and error strings — Amp ships as a Bun
single-file executable whose bundled JavaScript is present in plaintext inside the Mach-O
image — plus the CLI's own log file at `~/.cache/amp/logs/cli.log`, which captured a real
earlier invocation. **No prompt was ever sent to a model.** Every claim below is labelled
by how it was obtained.

## Binary and version

- `/Users/mikeyhasson/.local/bin/amp` → `/Users/mikeyhasson/.amp/bin/amp`, a 71 MB
  Mach-O arm64 **Bun single-file executable** (JavaScriptCore threads in a sample;
  internal path `/$bunfs/root/amp-darwin-arm64`).
- **`amp --version` could not be observed.** It hangs indefinitely.
- Version from the CLI's own log of an earlier run:
  `0.0.1786006377-g6eaed7`, `buildTimestamp 2026-08-06T08:59:06.387Z`.

### The startup hang (blocking, reproduced)

Every invocation attempted here — `--version` and `--help`, with stdin from `/dev/null`,
with stdout to a file, under a pty via `script`, inside the Bash sandbox and with the
sandbox disabled, and with a freshly created empty `TMPDIR` — produced **zero bytes of
output and zero log lines** and had to be killed. `sample` shows the main thread parked
in `openat` during module initialisation, reached through the bundle's native-addon load
path (the image contains `/$bunfs/root/keyring.darwin-arm64-*.node`, which links
`Security.framework`, and `globalThis.__AMP_KEYRING_ENTRY_CLASS__ = …Entry` runs at top
level). No amp process was running concurrently, so this is not lock contention with
another agent.

This is recorded as an observed fact about this machine, not as a defect claim against
Amp: the same binary demonstrably *did* start earlier the same day (the log below), so
something about the current environment wedges it. Either way, **Ensync cannot verify Amp
here.**

## Non-interactive invocation

*(Source: the option table embedded in the binary, read verbatim.)*

- One-shot flag: **`-x, --execute [message]`** — *"Use execute mode, optionally with user
  message. In execute mode, agent will execute provided prompt (either as argument, or
  **via stdin**). Only last assistant message is printed. Enabled automatically when
  redirecting stdout."*
- **Prompt on stdin is a documented, first-class path** — the flag's own help text says
  so, and execute mode turns itself on when stdout is not a TTY. This is the single most
  Ensync-compatible property Amp has.
- Related: `-ox, --orb-execute` (run the turn on an Amp-server "orb" instead of locally),
  `--project [project]`, `--plugin-ready-timeout [seconds]`,
  `--no-archive-after-execute`, `-l, --label <label>`, `--visibility <private|unlisted|workspace|group>`,
  `--thread <thread>` (thread URL or ID, defaults to `AMP_THREAD_ID`).

## Machine-readable output

*(Source: embedded option table.)*

- `--stream-json` — *"When used with --execute, output in **Claude Code-compatible stream
  JSON format** instead of plain text."*
- `--stream-json-thinking` — adds thinking blocks; implies `--stream-json`.
- `--stream-json-input` — *"Read JSON Lines user messages from stdin. Requires both
  --execute and --stream-json."*
- `--stats` (hidden) — *"When used with --execute, output JSON with both result and token
  usage data (for /evals)."*
- `--stream-jsonl` — unrelated: streams a JSON line whenever the **thread list** changes;
  its schema is marked EXPERIMENTAL.

### Terminal event proving a completed turn

**Unverified.** "Claude Code-compatible stream JSON" strongly implies the familiar
`{"type":"result",…}` terminal object, and Ensync already parses that shape for other
providers — but no Amp stream has ever been observed on this machine, so the terminal
frame is an inference from a help string, not a verified fact. Ensync does not call a run
successful on an inferred event name.

## Session resume

*(Source: embedded option table.)*

- Amp's unit of continuity is a **thread**: `--thread <thread>` takes a thread URL or ID
  (`T-12345678-0000-0000-0000-000000000000` appears as the documented example format in a
  bundled tool description), defaulting to the `AMP_THREAD_ID` environment variable.
- `threads continue` / `--last` continue the most recent thread for the current mode.
- Not verified live.

## Model and effort selection

*(Source: embedded option table.)*

- `-m, --mode <low|medium|high|ultra>` — *"Set the agent mode … controls the model,
  system prompt, and tool selection"*. This is the closest analogue to Ensync's Model-size
  tiers, though it changes more than effort (it also swaps the system prompt and the tool
  set), so it is not a pure effort dial.
- `--model` (hidden) — *"Override the model. Use `provider:model` for all modes, or
  `mode=provider:model,mode=provider:model` for mode-specific overrides"*.
- `--fast` — run new threads in Fast mode, *"billed at a premium"*; alias for
  `--features fast`. A Host runner must never send this implicitly.
- No model IDs verified (`amp` cannot run here, and the account is not signed in).

## Permission / approval model

*(Source: embedded option table and the binary's own error strings.)*

- `--dangerously-allow-all` — hidden switch, described as *"Disable all command
  confirmation prompts (agent will execute all commands without asking)"*.
- Permissions are otherwise configured in settings (`amp.permissions`,
  documented at `https://ampcode.com/manual#permissions`), with a **command allowlist**
  and a `guardedFiles.allowlist`.
- **In execute mode Amp fails fast rather than blocking.** Four error strings recovered
  verbatim from the binary:
  - `Error: The <tool> tool tried to run a command that isn't allowlisted. Rerun with --dangerously-allow-all to bypass, or add to the command allowlist in permissions (…)`
  - `Error: The <tool> tool is not allowed to run in execute mode. Rerun with --dangerously-allow-all to bypass.`
  - `… requires user approval (<reason>), but **no interactive UI is available**. Rerun with --dangerously-allow-all to bypass, or configure permissions (…)`
  - `… no interactive UI is available to approve. Add the path to guardedFiles.allowlist or rerun with --dangerously-allow-all to bypass.`

  The phrase *"no interactive UI is available"* is written for exactly the headless case,
  which is good evidence Amp errors instead of hanging on approval — **but it is a string
  in a binary, not an observed run.**
- The non-interactive pinning options are therefore: `--dangerously-allow-all` (which
  removes all containment and is not something Ensync would pin), or a settings file
  supplied with `--settings-file <path>` (default `~/.config/amp/settings.json`, override
  env `AMP_SETTINGS_FILE`) carrying an `amp.permissions` allowlist. The **schema of that
  permissions block was not verified** — only its existence and its documentation URL.

## Containment

Honest level: **unrecorded, because nothing could be verified.**

- `--settings-file <path>` is a genuine per-run override point, which is more than several
  other providers offer — a Host could write a scoped permissions file per run without
  touching the user's global settings. That is promising but untested.
- A workspace root is inferred from cwd (the log below shows Amp resolving
  `workspaceRootPath` from the process working directory and looking for
  `<root>/.amp/settings.json`). Workspace-local settings are therefore read out of the
  project directory, which for an Ensync protected worktree holding a third-party
  repository is untrusted input — a runner would need to establish whether
  `--settings-file` suppresses that or merely layers over it. Unverified.
- No OS sandbox flag is present in the option table.
- Because no level could be verified, **there is no `CHAT_PROVIDER_CONTAINMENT` record for
  `amp`** — deliberately, as with Ollama, Jules, and Oz. The absent record keeps the
  provider unrunnable rather than letting it claim a level it has not earned.

## Auth and usage without a model turn

- **This machine is not signed in.** Evidence, all local:
  - `~/.config/amp/` exists and is **empty** — no `settings.json`.
  - `~/.local/share/amp/` contains only `device-id.json` — no API key
    (the log records `using file-based secrets storage`, `dataDir
    /Users/mikeyhasson/.local/share/amp`, then `API key lookup before login … found:false`).
- **An unauthenticated invocation launches a browser login and blocks for five minutes.**
  This is the single most important operational finding, and it is *observed*, from
  `~/.cache/amp/logs/cli.log` for an earlier `amp tools list --json` run:

  ```
  "Initializing CLI context"  argv:["bun","/$bunfs/root/amp-darwin-arm64","tools","list","--json"]
                              hasAmpURL:false hasAmpAPIKey:false hasSettingsFile:false
  "API key lookup before login"  found:false  deferAuth:false
  "Finding available port" → "Generated callback port" 35789
  "Opened external URL"  https://ampcode.com/auth/cli-login?authToken=…&callbackPort=35789
  "Starting local HTTP server to receive API key from browser"
  "Listening for auth callback"           22:35:11Z
  ERROR "Login failed" … "Login timed out"  22:40:11Z      ← exactly 5 minutes later
  ```

  A *read-only listing command* opened a browser tab and then blocked for 300 s. Any
  Ensync run of an unauthenticated Amp would do the same. A Host runner must refuse to
  launch Amp unless an API key is present (`AMP_API_KEY`, or the file-based secret store),
  rather than relying on a timeout to clean up after it.
- Non-interactive auth: `AMP_API_KEY` (the binary's `{apiKey:"AMP_API_KEY"}` mapping, plus
  an env allowlist containing `AMP_URL`, `AMP_THREAD_ID`, `AMP_WORKSPACE_ID`,
  `AMP_EXECUTOR`, `AMP_USER_EMAIL`, and others).
- Usage/quota: not verified. No usage subcommand was reachable.

## Unknowns, stated plainly

1. **Why the binary hangs at startup here**, and therefore whether *any* of the above
   behaves as its embedded strings say. This is the dominant unknown.
2. The exact terminal frame of `--execute --stream-json`.
3. The schema of the `amp.permissions` settings block, and whether `--settings-file`
   replaces or merely layers over a workspace-local `.amp/settings.json` read out of the
   project directory.
4. Whether `--execute` with stdin has a first-chunk deadline (Auggie has a 100 ms one).
5. Model IDs, thread ID format, quota surface — all require a signed-in, running CLI.

## Ensync decision

**No runner module. Catalog stays `discovery_only`; gated with the exact outstanding
requirement.**

Amp is, on paper, the *best* fit of the three providers mapped in this pass — documented
stdin prompt delivery, a Claude-Code-compatible stream-JSON mode, a per-run settings-file
override, and error strings written specifically for the no-interactive-UI case. None of
that can be built on today, because:

1. The binary produces no output at all on this machine, so not one claim above has been
   observed live.
2. It is not signed in, and an unauthenticated invocation opens a browser and blocks for
   five minutes — a failure mode strictly worse than the droid hang, because it also
   takes over the user's screen.

Both are recoverable: sign in to Amp, get `amp --version` to answer, and this provider
becomes a strong promotion candidate.
