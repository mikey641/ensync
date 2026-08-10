# Factory Droid /limits quota adapter

Ensync's provider panel shows exact subscription usage for Codex (app-server
`account/rateLimits/read`) and Claude (`claude --print` driving `/usage`), while
Factory Droid's entry says "Ensync still has no /limits quota adapter, so
remaining capacity is unknown." This design adds that adapter.

## Verified constraints (droid 0.191.1, 2026-08-10)

Every finding below was verified against the installed CLI on this machine, not
guessed from documentation.

1. **The data exists and is machine-shaped.** The TUI's `/limits` command calls
   `GET {appBaseUrl}/api/billing/limits`, which returns
   `limits.standard.{fiveHour,weekly,monthly}.usedPercent` plus
   `extraUsageBalanceCents`. Fetching it consumes no model quota.
2. **No exec surface.** `droid exec --input-format stream-jsonrpc` has no
   limits method, and `droid.list_commands` returns zero commands, so `/limits`
   sent as a user message would reach the model as prompt text and consume a
   turn. There is no `droid limits` subcommand.
3. **No daemon surface without a credential.** Every `droid daemon` method —
   including `daemon.list_commands` and `daemon.get_proxy_token` — is gated by
   `daemon.authenticate`, which requires a Factory access token or API key and
   validates it server-side (a bogus token returns "Internal error" and the
   connection stays unauthenticated). This holds even when the daemon is
   spawned with a parent IPC channel.
4. **The credential store stays sealed.** `~/.factory/auth.v2.loginkeychain` is
   encrypted (`iv:ciphertext`). Ensync's documented policy (droid-auth.mjs)
   is to never read, parse, or transmit it, and this design keeps that policy.
5. **The TUI panel is strictly parseable.** Driven in a 120-column PTY, the
   `/limits` panel renders one plain-text line per Standard window —
   `5-hour   38%   ↻ 3h 21min`, `Weekly   14%   ↻ 6 days`,
   `Monthly  4%   ↻ 29 days` — under a `◉ Standard` tab marker, plus
   `($0.00 remaining)` for Extra Usage. Repaints repeat identical values.

## Decision

Drive the real TUI `/limits` command in a disposable PTY and strictly parse the
panel, exactly mirroring the claude-usage contract: exact regexes, and null →
honest `unavailable` fallback on any deviation.

PTY allocation uses the OS-provided `expect(1)` (`/usr/bin/expect` ships with
macOS) rather than a native node-pty dependency. Where `expect` is missing
(Windows), the probe returns null and the existing `usageFor` fallback reason
explains that capacity is unknown.

Rejected alternatives: reading/decrypting the credential store (policy, and the
key is not on disk); daemon RPC (needs the same sealed token); sending
`/limits` through `droid exec` (consumes a model turn); full VT-emulation
scraping (unnecessary — strict line regexes on the ANSI-stripped stream are
sufficient because values repeat identically across repaints).

## Components

`host/droid-limits.mjs`:

- `droidLimitsExpectScript(executable)` — builds the expect script: spawn the
  TUI, set the PTY to 50×120, wait 8s for startup, send `/limits\r`, wait for
  the panel (`5-hour` + digit, 15s), drain 3s, exit. Returns null for
  executables containing Tcl-special characters rather than escaping them.
- `parseDroidLimitsCapture(stdout, checkedAt)` — strips residual escape
  sequences, then strict-parses. Requires the `◉ Standard` tab marker and all
  three window lines; every repeated occurrence of a window must report the
  same percentage or the whole parse returns null. Reset times are kept as
  verbatim relative labels (`3h 21min`) — never converted to absolute
  timestamps. Extra Usage balance is an optional detail row.
- `probeDroidLimits(executable, checkedAt)` — finds `expect`, runs the script
  via `runProcess` (cwd `homedir()`, `subscriptionEnvironment` + explicit
  `TERM`, 35s hard timeout), parses. Any failure → null.

`host/providers.mjs`: probe droid usage when `authentication.state ===
'authenticated'` (same gate as Codex/Claude), add it to the usage chain, and
update the droid `usageReason`/`catalogReason` strings to describe the adapter
and its fallback behavior.

## Failure handling

Untrusted-folder prompts, TUI redesigns, slow startup, missing expect, and
partial captures all converge to the same outcome: strict parse fails → usage
falls back to `unavailable` with the honest reason string. Wrong data cannot be
reported because a value is only accepted when every rendered occurrence in the
capture agrees.

The probe consumes no quota at any point: `/limits` performs a billing API GET,
no user message is ever sent to the agent, and `subscriptionEnvironment`
already strips `FACTORY_API_KEY` so the probe cannot observe API-key billing.

## Testing

`host/droid-limits.test.mjs`, node:test style like claude-usage.test.mjs:
fixtures cut from the real 0.191.1 capture; cross-frame disagreement → null;
missing window/tab-marker → null; Extra Usage optionality; expect-script
generation and Tcl-character refusal; probe orchestration with injected
runProcess/expect lookup; live E2E performed manually before landing.
