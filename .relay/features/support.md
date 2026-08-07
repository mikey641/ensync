---
name: Support and subscription repair
description: Honest local help desk, redacted diagnostics, and opt-in bug repair through subscription CLIs.
---

# Support and subscription repair

Ensync's in-product help desk is local-first. It creates a browser-local ticket and a reviewable JSON report. Automatic diagnostics are a whitelist of app/runtime version, coarse OS facts, provider install/auth/execution states, and optional project context counts/adapters. They exclude chat text, secrets, source and file contents, absolute paths, environment variables, and command output. User-written summary/description text is included exactly as entered and is explicitly labeled for review.

The app never claims a staffed queue, human response, SLA, or external ticket unless one exists. Current human help-desk and SLA state is unavailable. A GitHub integration is enabled only when `ENSYNC_GITHUB_ISSUES_URL` is an exact HTTPS `github.com/<owner>/<repo>/issues/new` URL; even then Ensync prepares an unsent reviewed draft and never submits it.

`Fix with my subscription` requires a reviewed report, a freshly re-inspected exact local project ID/path, explicit subscription and project-edit consent, and a connected supported subscription CLI with capacity. It currently uses only the structured Codex or Claude runner, sends no API-key billing environment, redacts common credentials again on the host, runs once without automatic fallback/retry, and returns real CLI response/model/session/duration/token telemetry. Completion is labeled `agent_run_completed` and `requires_user_review`, never “fixed.” The result becomes a dedicated review-required conversation tab.

The support service itself never commits, pushes, deploys, publishes, or changes an external ticket. The repair prompt forbids those actions. The current shared chat runner has no command-level interception hook, so a future hard restricted-tool policy is still required before Ensync may claim process-enforced blocking of every agent-issued Git or deployment command.

Host routes are `GET /api/support/status`, `POST /api/support/preview`, `POST /api/support/github-issue`, and `POST /api/support/repair`.
