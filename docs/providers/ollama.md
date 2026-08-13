# Ollama — Ensync provider mapping

Verified against the installation on this machine on 2026-08-11. Ollama is a **local model
runtime**, not a subscription coding agent, and that difference decides the outcome of this
mapping. Claims are direct observations unless marked **UNVERIFIED**.

**No model was pulled.** `ollama list` is empty on this machine, so — per the standing
instruction — no `run` with a prompt was attempted. Everything below was established with
free commands and HTTP calls that do not download anything.

## Identity

| Field | Value |
| --- | --- |
| Executable | `/opt/homebrew/bin/ollama` |
| `--version` | `ollama version is 0.13.5` |
| Server | running — `pid 819`, `/opt/homebrew/opt/ollama/bin/ollama serve` |
| Default endpoint | `http://127.0.0.1:11434` (`OLLAMA_HOST`) |
| Installed models | **none** — `ollama list` returns only headers; `/api/tags` → `{"models":[]}` |

## The finding that governs everything else: no agentic capability

Ollama's whole CLI surface is `serve, create, show, run, stop, pull, push, signin, signout,
list, ps, cp, rm, help`. `ollama run MODEL [PROMPT]` is a **text completion** — prompt in,
tokens out.

Ollama has, by design:

- **no file read/write capability** — it never touches the project tree;
- **no command execution** — nothing to approve, nothing to sandbox;
- **no working-directory concept** — `cwd` is meaningless to the server, which is a
  separate long-lived daemon that Ensync did not spawn and does not own;
- **no permission or approval model** — there is no approval prompt, therefore also no
  headless-hang failure mode;
- **no session/conversation state** — the caller resends the full message array each turn.

`/api/chat` does accept a `tools` array (function-calling), but that only makes the model
*emit* tool-call JSON; **the caller must execute the tools**. Ollama itself remains
incapable of touching the filesystem. Building an agent on it means Ensync writing the
entire tool-execution and permission layer that `codex`, `claude`, and `droid` each ship.

## Transport: HTTP API, decisively — not the CLI

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/version` | GET | Server liveness → `{"version":"0.13.5"}` |
| `/api/tags` | GET | Installed-model inventory → `{"models":[]}` |
| `/api/ps` | GET | Loaded/running models → `{"models":[]}` |
| `/api/generate` | POST | Single-prompt completion |
| `/api/chat` | POST | Multi-turn message-array completion |
| `/api/show` | POST | Model metadata |

Verified method/status matrix (`GET` / `POST {}`): `version`, `tags`, `ps` → `200` / `405`;
`generate`, `embed` → `405` / `404`; `chat`, `show` → `405` / `400` with
`{"error":"model is required"}`.

**The CLI is disqualified as a transport, for two verified reasons:**

1. **`ollama run` auto-pulls a missing model.** This is the multi-GB-download hazard:

   ```
   $ ollama run __nope__ < /dev/null
   … pulling manifest ⠙ …
   Error: pull model manifest: file does not exist
   ```

   It began a registry pull for a model that was never requested for download. A real but
   absent model name would have started a multi-gigabyte download instead of failing.

2. **`ollama run` emits ANSI/TTY control sequences even when stdout is a pipe** (`[?2026h`,
   `[?25l`, `[1G`, spinner frames in the capture above), so its output is not
   machine-readable.

The HTTP API has neither problem. It never pulls implicitly:

```
$ curl http://127.0.0.1:11434/api/generate -d '{"model":"__does_not_exist__","prompt":"x","stream":false}'
HTTP 404  {"error":"model '__does_not_exist__' not found"}
```

Immediate, explicit, no download, no hang. Same for `/api/chat`. **If Ollama were ever
driven by Ensync, it must be over HTTP, never over `ollama run`.**

### Streaming contract

With `"stream": true` both completion endpoints return NDJSON, one JSON object per line,
terminated by an object carrying `"done": true` (with `done_reason`, e.g. `"stop"`, plus
`total_duration`/`eval_count` timings). `"stream": false` returns a single object with
`"done": true`.

**UNVERIFIED:** the exact field set of the streamed chunks and of the terminal object could
not be observed live, because no model is installed and pulling one was out of scope. The
`done` / `done_reason` contract above is Ollama's documented behaviour, not something this
mapping watched happen. Do not code against unobserved fields.

## Model selection and enumeration

- **Enumeration:** `ollama list` (CLI) or `GET /api/tags` (HTTP). Both currently report zero
  models. `host/ollama-runtime.mjs` already parses the CLI form for the discovery panel.
- **Loaded models:** `ollama ps` / `GET /api/ps`.
- **Selection:** the `model` field of the request body; the CLI takes it positionally.
- **Absent model:** HTTP → immediate `404` + `{"error":"model 'X' not found"}`.
  CLI → **starts a pull** (see above).
- There is no notion of a default model: an empty body yields `{"error":"model is required"}`.

## Session resume

**None.** There is no session id and no server-side conversation store. Continuity is the
caller's job: resend the whole `messages` array to `/api/chat` each turn. Ensync's
`sessionId` concept has no counterpart.

## Permission / approval model

**None, and none needed** — Ollama executes nothing. This is the one provider where the
headless-approval-hang risk is structurally absent, because there is no approval surface
at all. It is also why there is nothing to pin.

## Containment

**Not applicable, and that is a disqualification rather than a clean bill of health.**

Ensync's containment contract asks how a provider is prevented from writing outside the
protected worktree. For Ollama the honest answer is that the question does not apply: the
model process cannot write anywhere, so there is nothing to contain — but equally there is
no `cwd` to constrain, no sandbox flag, and no deny-list, because there is no agent.

Two further points recorded for candour:

- The server is a **shared, pre-existing daemon** (`pid 819`) that Ensync neither started
  nor owns. Ensync cannot make guarantees about a process outside its lifecycle, and
  `OLLAMA_HOST` may even point at a remote machine.
- Requests carry no per-run isolation: `OLLAMA_KEEP_ALIVE`, loaded-model state, and queueing
  are global to that daemon and shared with every other client on the box.

No containment level is recorded in `CHAT_PROVIDER_CONTAINMENT`, so Ensync refuses to run
it — which is the correct outcome, not an oversight.

## Auth / usage without a model turn

- **No subscription, no quota, no credits.** `signin`/`signout` exist only for pushing
  models to ollama.com, and are irrelevant to local inference.
- **Health check = server reachability + model inventory**, both free:
  `GET /api/version` (liveness) and `GET /api/tags` (inventory). `host/ollama-runtime.mjs`
  already reports this as `availability: 'partial'`, `kind: 'local_runtime'`, with
  `usedPercent: null` and the explicit note that local Ollama has no quota percentage.
- **Server down** is cleanly detectable: connecting to a closed port fails immediately with
  `ECONNREFUSED` (verified against port 59999) rather than hanging.

## Stated unknowns

- Live streaming chunk/terminal shapes (see above) — no model installed.
- Whether any installed model on this machine would support tool-calling well enough to
  drive an agent loop — unknowable with zero models, and model-dependent regardless.
- Real latency/throughput characteristics for inactivity-timeout tuning.

## Promotion decision

**Stays `discovery_only`, gated — and is a legitimately unsuitable candidate for a full
chat provider, not merely an unfinished one.**

This is the outcome the investigation was told to report if it found it, and it is what the
evidence shows. Ensync chat providers must carry out coding work inside a protected git
worktree: read and edit files, run builds and tests, and act on the bundled Ensync
agent-coordination contract that every prompt is wrapped in. Ollama cannot do any of
it — not because a flag is missing, but because it is an inference server, not an agent.

Wiring it in as a chat provider would be actively harmful rather than merely useless: every
Ensync prompt is prefixed with instructions to edit files and coordinate work, so a model
that cannot act would answer as though it had, producing confident reports of edits that
never happened, inside a worktree Ensync would then try to land. A truthful refusal is
strictly better than a plausible lie.

What **was** implemented instead is the honest-preflight surface, in
`host/ollama-runtime.mjs`: server reachability and model-inventory checks that fail fast
with actionable messages ("Ollama server is not reachable at …", "model 'X' is not
installed — run `ollama pull X`") rather than hanging or silently triggering a download.
That serves the existing discovery/status path, which is where Ollama genuinely belongs.

Reversing this decision is not a matter of finishing the runner; it would require Ensync to
own a full tool-execution, permission, and containment layer on top of raw inference —
a materially different project from adapting a CLI agent that already has one.
