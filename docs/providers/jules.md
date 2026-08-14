# Jules (Google) — Ensync provider map

Verified 2026-08-11 against the installed CLI. Every fact below came from `--help`,
`help <subcommand>`, `jules version`, and local config files. **No task was ever sent
to Jules**, because `jules new` starts a real cloud session and spends the account's
Google AI plan quota. Anything that would have required starting a session is recorded
as an unknown rather than guessed.

## Binary and version

- Path: `/opt/homebrew/bin/jules`
- `jules --version` → `Error: unknown flag: --version`. The version subcommand is
  `jules version`:
  ```
  Version: v0.1.42
  Commit:  4bd6b25084aa1af52d6d3979cda31f3a3d99fc04
  Date:    2025-12-16T20:26:09Z
  OAuth Client ID: 716860248198-t1s5lv1n1msgfoe3dt7vekro8b1fpd9g.apps.googleusercontent.com
  ```
- Cobra-based Go CLI. Global flags are only `-h/--help` and `--theme dark|light`.

## This CLI is a thin client for a cloud service — read this first

`jules --help` describes itself as "A CLI for Jules, the asynchronous coding agent from
Google." It is **not** a local coding agent, and this single fact invalidates most of
the Ensync runner contract:

- `jules new` / `jules remote new` assign a task to a **Jules session running in a
  Google-operated VM**, against a **GitHub repository** (`--repo owner/name`, defaulting
  to the repository of the current working directory). Nothing runs on this machine.
- Results come back later, out of band, through `jules remote pull --session <id>`
  (fetch the patch) or `jules teleport <id>` (clone the repo, check out the session's
  starting branch, and apply the patch).
- `jules remote list --session` enumerates sessions; there is no wait/await verb.

The consequence: Ensync's whole containment model — a protected worktree, a constrained
`cwd`, and a subprocess whose file writes are bounded — does not describe what Jules
does. Jules executes in Google's infrastructure on the *remote* GitHub repository, and
the only local write happens later, when a person or a separate command applies a patch.

## Non-interactive invocation

- Subcommands: `login`, `logout`, `new`, `remote {list,new,pull}`, `teleport`,
  `version`, `completion`, `help`.
- **Prompt on stdin is supported and documented.** `jules new --help` shows
  `# Pipe input as the session description` with `cat TODO.md | jules new`, and
  `jules remote new --help` documents `--session` as "Create a Jules session based on
  your task, you may use pipe like `cat task.md | jules remote new --repo <repo>`".
  So the one Ensync-friendly property Jules does have is stdin prompt delivery.
- Argv form: `jules new "write unit tests"`.
- `--parallel 1..5` creates several sessions for the same task.
- Bare `jules` launches a TUI, so a headless runner must always name a subcommand.

## Machine-readable output

**None.** There is no `--json`, `--output-format`, NDJSON, or stream flag on any
subcommand (`jules --help`, `jules new --help`, `jules remote {list,new,pull} --help`,
`jules teleport --help` all checked). Output is human-formatted text intended for a
terminal, and `--theme dark|light` confirms the output is styled for display.

**Terminal event proving a completed turn: does not exist.** There are two reasons,
and only the first could be fixed by adding a flag:

1. No structured event stream is emitted at all.
2. More fundamentally, `jules new` is *asynchronous by design*. It returns once the
   session has been **assigned**, not once work is finished. A completed turn is not
   an event on the process's stdout; it is a state change on a remote session that a
   caller would have to poll for with `jules remote list --session`.

Ensync will not call a run successful without verifiable completion, and Jules exposes
no such signal to the process Ensync would spawn.

## Session resume

- Sessions are addressed by a numeric ID (`jules remote pull --session 123456`,
  `jules teleport 123456`). The IDs shown in the CLI's own examples are short decimal
  numbers, not UUIDs.
- There is **no resume/continue flag** that adds a follow-up turn to an existing
  session from the CLI. `remote pull` and `teleport` retrieve results; they do not
  continue a conversation.
- Unknown: whether the session ID format is stable/bounded, and whether Ensync's
  `SESSION_ID_PATTERN` (a UUID regex in `host/chat.mjs`) could ever match it. From the
  examples it plainly would not.

## Model and effort selection

**No flags exist.** No `--model`, no `--effort`, no `--reasoning`. The model is chosen
by the Jules service. Ensync's Model-size selector has nothing to map onto.

## Permission / approval model

There is no local permission surface, because there are no local tool calls to approve.
Jules runs commands and edits files inside Google's VM under Google's own policy, which
this CLI neither exposes nor lets a caller pin.

- No `--yes`, `--auto-approve`, `--yolo`, `--approval-mode`, or equivalent on any
  subcommand.
- The one place a local approval could plausibly appear is `jules remote pull --apply`
  and `jules teleport`, which write a patch into a local repository. **Unknown:**
  whether either prompts before overwriting local changes. This was not tested, because
  testing it requires a real completed session, which requires spending quota.
- Bare `jules` is a full-screen TUI, and `login` opens a browser (`--no-launch-browser`
  switches to manual code entry). Both are interactive surfaces a headless run must
  avoid entirely.

Hang risk in a headless run: **unquantified**. `jules new` reads stdin, which means a
headless invocation that gives it no stdin and no argv task could block on input rather
than exit. That is the same class of failure as the old droid "Working" hang.

## Containment

**Not applicable, and therefore not recordable at any level Ensync accepts.**

- CWD cannot be constrained in any meaningful sense: `cwd` is used only to infer which
  GitHub repository the session targets. The agent's file writes happen in a Google VM
  against the remote repository.
- No sandbox flag, no deny list, no allowlist, no path scoping — none of these concepts
  exist in the CLI's surface.
- A protected Ensync worktree gives no protection here. Jules works from the repository
  as GitHub has it, not from the local worktree's contents, so uncommitted work in the
  protected worktree is invisible to it and the branch Jules produces is created
  remotely.
- Blast radius is a **remote GitHub repository**, which is broader than anything
  Ensync's local containment vocabulary describes.

This is why `CHAT_PROVIDER_CONTAINMENT` has no `jules` entry and must not get a
cosmetic one: recording a level would assert a guarantee that does not exist.

## Auth and usage without a model turn

- Login: `jules login` (Google OAuth, browser; `--no-launch-browser` for device-code
  style manual entry). `jules logout` clears it.
- **Stored credential (readable, no model turn):** `~/.jules/cache/oauth_creds.json`.
  Its presence is a sound signal of login state. A local log also exists at
  `~/.jules/cache/cli.log`.
- The OAuth client ID is printed by `jules version`, which is a free, safe probe.
- **Quota/usage: no local read exists.** There is no `jules usage`, `jules limits`, or
  equivalent. Jules is billed against a Google AI plan; the CLI does not report
  remaining capacity. `jules remote list --session` would show sessions but is a
  network call whose cost and rate-limit behaviour were not measured.

## Unknowns, stated plainly

- Whether `jules remote pull --apply` / `jules teleport` prompt before clobbering local
  changes. Not tested (needs a completed session ⇒ quota).
- Exit codes for any subcommand. Not systematically probed.
- Whether `jules new` blocks forever on an empty stdin in a headless run. Not tested,
  because the safe half of that test (giving it a task) is exactly the unsafe half.
- Whether sessions can be polled for completion cheaply, and what `jules remote list`
  prints in a machine-parseable way. Not tested.
- Whether the service enforces any sandbox on the remote VM that Ensync could describe
  to a user. Not documented in the CLI.

## Ensync decision

**Stays `discovery_only`; gated with an exact reason.** No runner module was written,
because Phase 1 verified there is nothing to run under Ensync's contract: no
machine-readable output, no terminal completion event, no local execution, and no
containment surface. The existing catalog reason in `host/providers.mjs` already says
this correctly ("Jules uses Google AI plan cloud sessions rather than the local worktree
subprocess contract"), and this document is the evidence behind it.
