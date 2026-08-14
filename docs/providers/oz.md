# Warp Oz — Ensync provider map

Verified 2026-08-11 against the installed CLI. Facts came from `--version`, `--help` on
every relevant subcommand, the **settings JSON Schema Warp ships inside the cask**
(`resources/settings_schema.json`), and constant strings extracted from the release
binary. **No prompt was ever sent to a model** — in particular `oz agent run` was never
executed, because that command *is* a model turn. Where a claim could only be settled by
running a turn, it is marked unknown.

## Binary and version

- `/opt/homebrew/bin/oz` → `/opt/homebrew/Caskroom/oz/0.2026.07.29.09.05.stable_02/oz-stable`
  (a 306 MB Mach-O arm64 binary — the full Warp terminal executable; `oz` is a symlink
  name that selects the Oz argument parser).
- `oz --version` → `Oz v0.2026.07.29.09.05.stable_02`, exit 0, offline.
- Cask resources of interest:
  - `resources/settings_schema.json` — the complete Warp settings schema, including the
    agent permission model documented below.
  - `resources/bundled/skills/`, `resources/bundled/mcp_skills/`.
- Local config: `~/.warp/` exists and is **empty** (Warp has never been configured on
  this machine).

## Non-interactive invocation

- One-shot command: `oz agent run` (alias `oz agent r`) — "Run a new Oz agent".
  `oz agent run-cloud` (alias `ra`) dispatches the same work to a Warp-hosted runner.
- Required input group (from the usage line):
  `oz agent run [OPTIONS] <--prompt <PROMPT>|--saved-prompt <SAVED_PROMPT>|--task-id <TASK_ID>|--skill <SKILL>>`
- **There is no stdin prompt path.** `-p, --prompt <PROMPT>` takes the prompt as an
  argv value. `--saved-prompt <id>` refers to a prompt already stored server-side,
  `--task-id <id>` resumes a server task, `--skill <name>` uses a skill file as the base
  prompt. None of them reads standard input, and nothing in the binary's strings shows a
  `-` / `@file` convention for `--prompt`. **Ensync never puts a prompt in argv, so this
  alone disqualifies the CLI as it stands.**
- `-f, --file <PATH>` — "Path to a YAML or JSON configuration file" (env
  `WARP_AGENT_CONFIG_FILE`). The binary carries an `AgentConfig` struct with fields
  `base_prompt`, `base_model_id`, `mcp_servers`, `profile_id`, `environment_id`,
  `runner_id`, `worker_host`, `skill_spec`, `computer_use_enabled`, `harness`,
  `harness_auth_secrets`, `additional_source_repos`, `reasoning_level`. `base_prompt`
  looks like the field that could carry a prompt off argv — **but this was not verified**:
  `-f` does not appear in the required input group, so whether it can satisfy it alone is
  unknown, and confirming it would require actually starting a run.
- Other run flags: `-n/--name`, `-C/--cwd <CWD>`, `-e/--environment <ID>`,
  `--conversation <ID>`, `--profile <ID>`, `--mcp <SPEC>`, `--strict-mcp-startup`,
  `--mcp-startup-timeout <DURATION>`, `--no-snapshot`, `--snapshot-upload-timeout`,
  `--snapshot-script-timeout`, `--share [<RECIPIENTS>]`.

## Machine-readable output

- Global flag on every subcommand: `--output-format <json|ndjson|pretty|text>`
  (default `pretty`, env `WARP_OUTPUT_FORMAT`).
- `oz run conversation` / `oz run message` / `oz run get` retrieve run transcripts and
  status after the fact.

### Terminal event proving a completed turn

**Unverified — no terminal event is known.** `--output-format ndjson` is documented as
"newline-delimited JSON", but the event union it emits is not published, is not readable
from the stripped 306 MB binary in any form Ensync would trust, and cannot be observed
without spending a real model turn. Ensync will not call a run successful by guessing an
event name.

The only status vocabulary recovered from the binary is the **server-side run status**
enum, seen alongside `parent_run_id`/`status_messages`/`session_link`:
`QUEUED`, `PENDING`, `CLAIMED`, `INPROGRESS`, `SUCCEEDED`, `FAILED`, `BLOCKED`,
`CANCELLED`, `UNKNOWN`. That is a lifecycle for a *cloud* task record retrievable via
`oz run get`, not a proof that the streamed local turn finished, and it has not been
observed in any output stream.

## Session resume

- `--conversation <ID>` — "Continue an existing cloud conversation by ID".
- `--task-id <TASK_ID>` — run against an existing task.
- `oz run list` / `oz run get <id>` / `oz run conversation` enumerate and read runs.
- **ID format unverified.** No run has ever been created from this machine, and
  `oz run list` cannot be called while logged out.

## Model and effort selection

- `--model <MODEL_ID>` — "Override the base model used by this command." For the default
  Oz harness, IDs come from `oz model list`; for third-party harnesses (`--harness claude`
  or `--harness codex`) the value is passed straight through to that harness.
- `oz model list` requires login (it answered *"You are not logged in"* here), so **no
  concrete model ID is verified**.
- Effort: the `AgentConfig` struct carries a `reasoning_level` field, but **no
  `--reasoning`/`--effort` flag appears in `oz agent run --help`**, so from argv there is
  no effort selector. Whether `-f`'s config file exposes `reasoning_level` per run is
  unverified.
- Note: `--harness` is referenced in the `--model` help text but is **not itself a listed
  flag** on `oz agent run`; it appears to be a config-file/agent-definition field.

## Permission / approval model

Warp's agent permissions are **execution profiles**, and the schema is fully documented
in the shipped `resources/settings_schema.json`. `$defs/ExecutionProfileFile`:

| field | type | default |
| --- | --- | --- |
| `execute_commands` | `agent_decides` \| `always_allow` \| `always_ask` | **`always_ask`** |
| `apply_code_diffs` | same enum | `agent_decides` |
| `read_files` | same enum | `agent_decides` |
| `mcp_permissions` | same enum | `agent_decides` |
| `ask_user_question` | `never` \| `ask_except_in_auto_approve` \| `always_ask` | `always_ask` |
| `run_agents` | `never_allow` \| `always_allow` \| `always_ask` | `always_ask` |
| `write_to_pty` | `always_allow` \| `always_ask` \| `ask_on_first_write` | `always_ask` |
| `computer_use` | `never` \| `always_ask` \| `always_allow` | `never` |
| `command_allowlist` | regex strings | `[]` |
| `command_denylist` | regex strings | `bash`, `sh`, `zsh`, `fish`, `pwsh`, `curl`, `wget`, `eval`, `exec`, `source`, `dig`, `nslookup`, `host`, `ssh`, `scp`, `rsync`, `telnet`, `rm` (each as `x(\s.*)?`) |
| `directory_allowlist` | paths | `[]` |
| `mcp_allowlist` / `mcp_denylist` | server IDs | `[]` |
| `web_search_enabled` | bool | `true` |
| `context_window_limit` | uint32 \| null | `null` |

There is also a legacy per-app surface under `agents.profiles`:
`agent_mode_coding_permissions` (`always_ask_before_reading` \| `always_allow_reading` \|
`allow_reading_specific_files`, default **`always_ask_before_reading`**),
`agent_mode_coding_file_read_allowlist`, `agent_mode_command_execution_allowlist`
(defaults to `cat`, `echo`, `find`, `grep`, `ls`, `which`),
`agent_mode_command_execution_denylist`, `agent_mode_execute_readonly_commands`
(default `false`).

**The blocking facts for a headless Ensync run:**

1. **No flag on `oz agent run` pins any of this.** There is no `--yes`, no
   `--auto-approve`, no `--allow`/`--deny`, no `--permission-mode`. The only lever is
   `--profile <ID>`, which *selects* a pre-existing profile.
2. **Profiles cannot be created from the CLI.** `oz agent profile` has exactly one
   subcommand: `list`. The binary even carries the string *"Attempted to edit CLI default
   profile, which is not yet supported."* Profiles are authored in the Warp GUI/TUI and
   synced through Warp Cloud (`x-warp-surfaces: ["gui","tui"]` on every permission field).
   `~/.warp` is empty here, so no profile exists to select.
3. **Defaults are ask-heavy.** With the shipped defaults, `execute_commands` is
   `always_ask` and every shell interpreter is on the denylist. A useful coding run
   *will* hit an approval.
4. **What an approval does in a headless run is unknown.** The binary carries an
   `auto_approve` concept and three UI strings — *"The Agent will not ask questions and
   will continue with its best judgment."*, *"The Agent may ask a question and will pause
   for your response even when auto-approve is on."*, *"The Agent may ask a question and
   pause for your response, but will continue automatically when auto-approve is on."* —
   plus a protobuf `warp.multi_agent.v1.AskUserQuestion` message and a
   `TransferShellCommandControlToUser` tool call. Whether `oz agent run` on a pipe denies
   these, skips them, or **blocks forever** is exactly the droid-style failure Ensync
   must not ship, and settling it requires spending a real model turn. It is recorded as
   unknown, not assumed.

## Containment

Honest level: **none that Ensync can pin per run.**

- `-C, --cwd <CWD>` sets the agent's working directory. That is cwd scoping only, the
  same advisory level as every other CLI here — a shell command can leave it.
- `directory_allowlist` in an execution profile is genuinely path-scoped ("Directories
  that may be read without approval") — but it is read-only scoping, it lives in a profile
  Ensync cannot create, and it is not reachable from argv.
- `command_allowlist` / `command_denylist` are anchored regexes over command text, again
  only inside a profile.
- There is **no OS sandbox** for a local run. (`oz agent run-cloud` and
  `-e/--environment` move execution into a Warp-hosted container, which is a real
  boundary — but then the work no longer happens in Ensync's protected worktree at all,
  which is the same disqualifier recorded for Jules.)
- `--no-snapshot` is worth noting for a different reason: by default a run **uploads an
  end-of-run workspace snapshot** to Warp. Any Host runner would have to pass
  `--no-snapshot` to keep a customer's protected worktree from being uploaded.

Because no containment level can be pinned from the command line, there is **no
`CHAT_PROVIDER_CONTAINMENT` record for `oz`** — deliberately, in the same way Ollama and
Jules have none. An absent record keeps the provider unrunnable rather than letting it
claim a level it has not earned.

## Auth and usage without a model turn

- `oz whoami` → *"You are not logged in - please log in with `oz login` to continue."*
  Exits cleanly, offline, no model turn. `--output-format json` is accepted but the
  logged-out reply is the same plain sentence, so **there is no verified machine-readable
  auth shape**. **This machine is not logged in.**
- `oz login` is a browser flow; `--api-key <API_KEY>` / `WARP_API_KEY` is the
  non-interactive alternative; `oz api-key` manages keys; `oz federate` issues federated
  identity tokens.
- Usage/quota: no `oz usage`/`oz quota` subcommand exists. The binary carries
  `AIRequestQuotaInfo` ("AI usage quota information across billing cycles") as an
  internal settings type, with no CLI surface. Warp plan credits live in the web
  dashboard.
- `oz dump-debug-info` prints local debug information (not run here; it may include
  account identifiers).

## Unknowns, stated plainly

1. Whether `-f/--file` can carry the prompt (`AgentConfig.base_prompt`) and satisfy the
   required input group — the single fact that would let the prompt leave argv.
2. The `--output-format ndjson` event union, and therefore any terminal event.
3. What a headless `oz agent run` does when a permission or `AskUserQuestion` is raised:
   deny, skip, or hang.
4. Whether `--profile <ID>` accepts a locally-defined profile at all, given profiles are
   cloud-synced and `~/.warp` is empty.
5. Valid `--model` IDs, `--conversation`/`--task-id` formats, and the local-vs-cloud
   split of `oz agent run` when `-e/--environment` is omitted.

## Ensync decision

**No runner module. Catalog stays `discovery_only`; gated with the exact outstanding
requirement.**

Three independent blockers, any one of which is sufficient:

1. The prompt can only be delivered in argv (`--prompt`), which Ensync does not do — the
   same disqualifier already recorded for Copilot and Kimi.
2. No terminal event has been verified, so a run could never be confirmed complete.
3. Containment cannot be pinned from the command line at all, and the shipped defaults
   are approval-heavy while the headless approval behaviour is unknown — the precise
   shape of the droid hang.

Writing a runner against any of these would mean inventing protocol Ensync has not seen.
