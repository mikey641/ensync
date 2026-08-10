---
name: Provider questions
description: How Claude Code and Factory Droid pause a turn to ask the person a question or for permission, and how the reply gets back.
---

# Provider questions

A provider run can stop mid-turn and ask the person something — a questionnaire,
or, on Factory Droid, permission to make a tool call. Ensync surfaces it in the
conversation, holds the run open while they decide, and sends their exact words
(or their chosen outcome) back to the CLI. Ensync never answers on their behalf:
the only two outcomes are the person's reply or an explicit "not answered" /
"not allowed".

Supported for local runs on **Claude Code** and **Factory Droid**. Codex has no
equivalent client-side questionnaire, and its interactive requests stay declined.
SSH runs are refused explicitly (`question_unavailable`) because the remote
bridge buffers provider output one way with no channel back.

## Shared shape

`host/provider-questions.mjs` owns the provider-neutral model and the registry
the runners block on:

```
question         { type, provider, questionId, questions[], at }
questions[]      { index, kind, header, question, multiSelect, options[] }
options[]        { label, description | null, value | null }
question_resolved{ type, provider, questionId, cancelled, answers[], at }
```

`kind` is `question` or `permission`. A permission decision is the same shape
with the typing removed: `value` carries the provider's own outcome, an answer
must name one of the offered values, and the card shows no text box because a
typed sentence could never be sent as an approval.

An answer names the question **by index** and never re-sends question text, so a
renderer cannot reword what the provider asked. `ProviderQuestionRegistry`
refuses a partial, empty, or unknown-index answer and keeps the question open;
`closeAll()` resolves anything still pending as cancelled when a run ends, so no
runner can hang on a dead process. Question text is redacted on the way out
(`redactedRunEvent` in `host/chat.mjs`) because it is provider-authored; the
person's own answer is not, exactly like a prompt.

Questions are only offered for a run bound to a retained chat job — that job ID
is what routes the answer back. A run without one (`/api/chat/run`, the
auto-land conflict and land-check repair sub-agents) keeps the old
decline-safely behaviour untouched.

## Factory Droid

`droid.ask_user` is a server-to-client JSON-RPC request over
`droid exec --input-format stream-jsonrpc`. Schema pinned from the published
`@factory/droid-sdk` 0.7.0 type surface:

```
params  { toolCallId, questions: [{ index, topic, question, options: string[], multiSelect? }] }
result  { cancelled?, answers: [{ index, question, answer }] }
```

`DroidExecSession` answers with that exact result, echoing the question text the
CLI sent.

### Permission requests

`droid.request_permission` is the second server-to-client request, and it is
what a `git push` at the pinned `medium` autonomy level runs into. Captured live
from droid 0.191.1:

```
params  { toolUses: [{ toolUse: { type, id, name, input },
                       confirmationType,
                       details: <discriminated union on type> }],
          options: [{ value: ToolConfirmationOutcome, label, selectedColor? }],
          associatedSessionIds? }
result  { selectedOption: ToolConfirmationOutcome, comment?, editedSpecContent? }
```

The whole request is **one decision**, because Droid's result is a single
`selectedOption` covering every tool use it listed. `normalizeDroidPermission`
turns it into one permission question describing what is actually being
permitted — the exec `fullCommand` (not Droid's shortened `command`), the file
path, the MCP server and tool — and deliberately leaves out patch bodies and
file contents: a decision card is not a diff viewer.

**Ensync offers `proceed_once` and nothing else.** That is an allow-list in
`DROID_OFFERED_OUTCOMES`, and widening it is a one-line change made on purpose:

- `proceed_always*` (live label: "Yes, and always allow high impact commands
  (all commands)") persists an allow rule in the shared Factory config, so one
  click here would pre-approve later runs — including the unattended ones that
  have no question channel at all.
- `proceed_auto_run*` and `proceed_new_session*` raise autonomy for the rest of
  the session, quietly falsifying the level `#assertContainmentPinned` verified
  before the prompt was sent.
- `proceed_edit` is rejected by Droid's own result schema without
  `editedSpecContent`, which Ensync has no surface to collect.

Declining is not listed as an option either: it is the card's own "Don't allow",
which resolves to `cancel` — the same outcome Ensync sent for every permission
request before this surface existed. A request with no offerable outcome, no
readable tool use, or no retained job falls back to exactly that decline, so the
failure mode of anything unexpected is "not approved".

Verified end to end against droid 0.191.1 through `DroidExecRunner`: the CLI
asked to run `git push origin main`, the approval went back as
`{selectedOption: "proceed_once"}`, the push landed in the remote, and the turn
finished with a real final response instead of the "finished without a
verifiable final agent response" that a declined push used to produce.

One observed payload quirk: `details.riskLevelReason` is model-authored prose
and has been seen arriving with its spaces collapsed into one long word. The
command itself was exact in every capture, which is why it leads the card and
why `impactLevel` (Droid's own enum) is shown next to it.

Claude Code's permission channel stays deny-all for everything except
`AskUserQuestion` (see below), and Codex has no client-side approval request at
all, so this surface is Droid-only.

## Claude Code

The `AskUserQuestion` tool only reaches a client in `--print` mode when the Host
passes `--permission-prompt-tool stdio` **and** `--input-format stream-json`
(the same pair the official Agent SDK uses for `canUseTool`). Verified live
against claude 2.1.226:

- The CLI writes `{"type":"control_request","request":{"subtype":"can_use_tool",
  "tool_name":"AskUserQuestion","input":{"questions":[…]},"requires_user_interaction":true}}`
  and reads `control_response` frames from a stdin that stays open.
- Attaching to this channel does **not** change what Claude may do. A run that
  executed Bash and Read produced no control request at all: the CLI consults
  the prompt tool only for a call that would otherwise have to ask a human.
  Ensync therefore denies every non-`AskUserQuestion` request, which reproduces
  exactly what headless Claude already did on its own.
- The CLI does not exit while stream-json stdin is open, and exits 0 once it is
  closed. The channel closes stdin on the terminal `result` frame, so run
  parsing, timeouts, truncation, and cancellation are unchanged.
- `--resume` still works with these flags (measured: two chained turns, both
  exit 0 on the same session ID).

**Line splitting is load-bearing.** `outputForwarder` in `host/chat.mjs` must
release a *complete* line as soon as it has one and hold back only a line still
missing its newline. It previously kept the last complete line of every chunk
until the next chunk arrived, which is invisible for display output (`flush()`
catches it after exit) but strands the terminal `result` frame — the frame that
ends the stream, so no next chunk ever comes. The run then sat with stdin open
until the inactivity watchdog killed it (measured: exit 143, `timedOut: true`,
after a turn that had otherwise completed correctly). Two tests in
`host/provider-questions.test.mjs` fail if that splitting regresses.

**Known Claude limitation.** Headless Claude has no channel that returns a
*successful* AskUserQuestion result. Answering `{behavior:"allow"}` runs the tool
with no dialog attached and it reports "The user did not answer the questions",
and `updatedInput` is schema-checked against the tool's own input, so it cannot
carry answers. The one verified way to deliver the person's words is the denial
message, which reaches the model verbatim as the tool result — measured end to
end: Claude read the answer and continued the turn with it. The cost is that the
tool result is flagged `is_error` and the call appears in `permission_denials`.
That is a Claude headless limitation, not an Ensync choice, and it is never
shown to the person as a failure. Revisit if Claude ships a result-returning
client channel.

## Blocking and timeouts

A pending question or permission holds the inactivity watchdog in both runners
(`DroidExecSession#holdInactivity`, and `onSession().holdInactivity` from
`runProcess`): a person thinking is not a hung CLI. The hold is counted, not a
flag, so answering one of two open requests does not restart the watchdog while
the other is still waiting. The absolute hard timeout still applies, and
cancelling the run resolves everything pending as cancelled — which, for a
permission, is `cancel`.

## Surfaces

- `POST /api/chat/jobs/:jobId/answer` → `{ questionId, answers?, cancelled? }`,
  where a permission answer is `{ index, value }` naming an offered outcome.
  `ChatJobService.answer` refuses finished runs and non-local targets before it
  reaches a runner.
- `ChatJobSnapshot.pendingQuestions` reports what a live run is blocked on, for
  clients that do not replay the event buffer.
- The renderer derives pending questions from the replayed event buffer
  (`src/lib/providerQuestions.mjs`), so a window that reconnects mid-turn still
  sees the open question, and renders `ProviderQuestionCard` above the composer.
  Send stays disabled until every question has an answer; "Don't answer" sends an
  explicit cancellation. A permission renders in the same card with the text box
  removed and the actions relabelled "Send decision" / "Don't allow".

`host/provider-questions.test.mjs` is the executable Host/renderer contract for
all of the above, including both wire formats driven against fake CLIs.
