# `ensync-agent` — Ensync routing for bots outside the app

A watchdog, chat bot, or cron job that calls `claude -p ...` or `codex exec ...` directly has
pinned one subscription and one model. `ensync-agent` replaces that call with a routed one: it asks
Ensync which provider has capacity right now, in the priority set in **Settings → Automatic
fallback**, runs the turn there, and applies Ensync's own fallback rules if it fails.

Change the ranking in Ensync, or add a provider to the automatic allowlist, and every bot using this
command follows on its next run. There is nothing to redeploy and no provider list to keep in sync,
because the connector answers from `host/automatic-routing.mjs` — the same module the app resolves
Auto with.

## Install

```sh
ln -sf "/Applications/Ensync.app/Contents/Resources/bin/ensync-agent.mjs" /opt/homebrew/bin/ensync-agent
# or, from a checkout:
ln -sf "$PWD/bin/ensync-agent.mjs" /opt/homebrew/bin/ensync-agent
```

`/opt/homebrew/bin` is on the minimal `PATH` launchd agents get, which `$HOME/bin` is not.

## Use

```sh
ensync-agent plan --cwd ~/homeassistant --tools full-access     # what would run, and why
printf '%s' "$PROMPT" | ensync-agent run --cwd ~/homeassistant --tools full-access --size medium
```

The agent's final answer goes to stdout. Everything else — which provider was chosen, any fallback
— goes to stderr, so `$(...)` capture stays clean. Exit codes: `0` done, `2` usage error, `3` no
provider had capacity, `4` the run failed on every provider Ensync offered.

| Option | Meaning |
| --- | --- |
| `--cwd DIR` | Working directory for the agent. Not an Ensync worktree: the connector runs where the bot lives and does not create branches, leases, or protected workspaces. |
| `--tools LEVEL` | `read-only`, `workspace-write` (default), or `full-access`. |
| `--size TIER` | `small`/`medium`/`large`/`xl` — Ensync's Model size, mapped to each provider's own reasoning effort. Providers keep their own default model. |
| `--timeout SECONDS` | Hard ceiling for one run. An inactivity watchdog applies regardless. |
| `--no-fallback` | Stay on the first provider; report its failure instead of routing on. |
| `--json` | Print the full result (provider, model, attempts, fallback reason) instead of just the answer. |
| `--refresh` | Re-probe subscriptions instead of using the Host's cached status. |
| `--local` | Ignore a running Host and probe providers in this process. |

### What each tool level means per provider

| Level | Codex | Claude Code | Factory Droid |
| --- | --- | --- | --- |
| `read-only` | `--sandbox read-only` | `--allowed-tools Read,Grep,Glob` | not offered |
| `workspace-write` | `--sandbox workspace-write` | allowlist incl. `Edit`, `Write`, `Bash` | pinned `medium` autonomy |
| `full-access` | `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-skip-permissions` | not offered |

Droid's containment is a per-session autonomy level and Ensync's verified runner pins exactly one
(`medium`), so the connector reports Droid as skipped at the other two levels rather than inventing
a session shape Ensync has not verified. Claude Code's print mode has no path sandbox: an allowed
`Bash` tool is unconstrained. That is the same fail-open gap Ensync records for its own Claude runs.

Use `full-access` deliberately. A job that has to run `docker`, `curl`, or `launchctl` needs it —
Codex's `workspace-write` sandbox blocks network and writes outside the working directory, so the
same task fails there for reasons that have nothing to do with the model.

## Fallback safety

The connector reuses Ensync's result parsers and `safeToRetry` proofs. It moves to the next provider
only after a verified quota failure whose complete structured stream shows zero tool, command, or
file activity, or a preflight failure before execution. Any other failure stops the run and reports
that provider's error, because partial work may exist and replaying it elsewhere could repeat a
side effect — a second `docker restart`, a second push.

## When Ensync is not running

The ranking is mirrored to a user-only file whenever it changes in the app, so a bot at 3am still
routes by the person's priority with no window open. If no Host answers, `ensync-agent` probes
providers in-process with the same status service instead of refusing the run; only the Host's warm
status cache is lost. Provider executables are resolved the way Ensync resolves them, including
`~/.local/bin`, so a launchd agent's minimal `PATH` does not hide a CLI.

## Example: the Home Assistant repair watchdog

`~/bin/ha-entity-watchdog.sh` builds `$PROMPT`, then runs one headless repair. Replace the pinned
Claude call:

```sh
CLAUDE_OUT=$(perl -e 'alarm shift; exec @ARGV' "$CLAUDE_TIMEOUT" \
    claude -p "$PROMPT" --model sonnet \
    --allowedTools "Bash,Read,Grep,Glob" --max-turns 100 2>&1)
CLAUDE_RC=$?
```

with the routed one:

```sh
CLAUDE_OUT=$(printf '%s' "$PROMPT" | /opt/homebrew/bin/ensync-agent run \
    --cwd "$HOME/homeassistant" --tools full-access --size medium \
    --timeout "$CLAUDE_TIMEOUT" 2>&1)
CLAUDE_RC=$?
```

Nothing else in the script changes: it still greps the output for its `VERDICT:` line, and the
`ensync-agent:` lines it now also captures record which subscription actually did the repair. The
external `alarm` wrapper is no longer needed because `--timeout` bounds the run from inside, where
the provider process can be stopped cleanly.
