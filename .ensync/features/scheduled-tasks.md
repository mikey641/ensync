---
name: Scheduled tasks
description: Host-owned recurring jobs with quota-aware routing and after-failure repair.
---

# Scheduled tasks

A scheduled task is one recurring, provider-neutral run that lives inside Ensync instead of a pinned provider call in a system crontab. Live-quota routing picks the automatic provider in the saved Settings order at each fire, so a provider whose subscription runs out is handed to the next automatic provider rather than stopping the job. This is the same `host/automatic-routing.mjs` selection a conversation uses.

## Task definition

The task is a user-only JSON file, one specific job rather than a general scheduler UI. On macOS the default path is `~/Library/Application Support/Ensync/scheduled-task-v1.json`; a detached Host pinned by `ENSYNC_HOST_STATE_FILE` looks beside that file. No file means no task, and every existing install stays unchanged.

```json
{
  "version": 1,
  "enabled": true,
  "task": {
    "name": "ensync-repair-watchdog",
    "schedule": { "intervalMinutes": 5 },
    "cwd": "/Users/you/dev/ensync",
    "tools": "full-access",
    "size": null,
    "prompt": "Run this repository's automated checks, confirm the current working state, and report concisely what is healthy, what failed, and what safe repair is still needed. Do not commit or push."
  }
}
```

The schedule accepts `intervalMinutes` (positive integer, aligned to wall-clock boundaries) or a five-field local-time `cron` expression. `tools` is `read-only`, `workspace-write`, or `full-access`; `size` is `small`, `medium`, `large`, or `xl` (default null = provider default). Omitting `prompt` uses a safe "run checks and report" default.

## Execution and fallback

Each fire asks the connector plan for the provider with remaining capacity, in the saved Automatic-fallback order, and walks the fallback sequence exactly as `ensync-agent run` does: a Host-verified quota or preflight failure with zero observed tool activity hands the same task to the next automatic provider. A non-quota failure stops the run there, because partial work may exist and replaying it elsewhere could repeat a side effect.

A tick that would overlap a still-running turn is skipped forward to the next boundary instead of stacking two turns on one directory. The next-run pointer and last outcome are journaled in `scheduled-task-state-v1.json` beside the config, so a Host restart resumes the cadence without replaying a provider prompt.

## Repair after a stop or error

After any terminal failure or stop, the job runs a **repair turn** with the next available provider. The repair prompt is a fresh inspection task, never a blind replay of the original prompt: it is told what failed and directed to inspect the working directory and report or apply the safest recovery. This preserves Ensync's no-replay-after-mutation rule while still acting on every stop/error. If no provider has capacity for the repair, the job records the repair failure and waits for the next tick.

## Lifetime and the always-on path

The native timer lives with the Host and only fires while that Host process is alive, the same lifetime as the auto-push and stranded-recovery intervals. When the desktop shell detaches a Host, the Host retires while idle, so a guaranteed 5-minute cadence with the app closed uses the system scheduler plus the routed CLI:

```sh
*/5 * * * * printf '%s' "$PROMPT" | /opt/homebrew/bin/ensync-agent run \
    --cwd /Users/you/dev/ensync --tools full-access --repair --timeout 1800 2>&1
```

The `--repair` flag adds the same after-failure repair hop through the next available provider. Both paths — the Host timer and the routed CLI — share `runConnectorPlanWithRepair`, so fallback and repair semantics cannot diverge.

## Safety contract

- The task never invents quota, plan, model, or reset values; routing reads the live provider status it already displays.
- The repair turn can edit the working directory for a defensible fix but is instructed never to commit or push, never to run destructive or irreversible commands without strong evidence, and never to claim a fix it cannot verify.
- Raw prompts never enter the journaled state, and the Host status route exposes only bounded task fields — name, schedule, cwd, tools, size — never the prompt.
