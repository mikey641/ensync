# Redundant Skills Cleanup Design

## Goal

Remove repository skill artifacts that are no longer part of Ensync while making it explicit that Ensync's provider coordination safety does not depend on the upstream Superpowers plugin or skill pack.

## Skill inventory decision

The versioned `logo-generator` bundle under `.agents/skills/` is a stale brand-exploration dependency. Nothing in the application, Host, desktop package, or release pipeline loads it. Its `skills-lock.json` entry is the lockfile's only content. Remove both while retaining the generated `brand/` assets.

Keep `skills/ensync-auto-context/`. The Auto Context feature documentation names it as the reusable skill source, and its `agents/openai.yaml` supplies intentional discovery metadata. Its app-owned runtime contract is separate from the third-party skill bundle.

The user's runtime-global duplicate Sales/CRM installations are outside this protected conversation worktree and are not part of this repository cleanup.

## Agent coordination decision

Keep Ensync's embedded safe multi-agent prompt and the stable `[ENSYNC SAFE MULTI-AGENT v1]` marker. The prompt continues to require one lead agent, non-overlapping mutation scopes, current-worktree-only edits, integration review, and verification for local and SSH provider runners.

Remove the misleading Superpowers coupling from product code and provider metadata:

- rename `ENSYNC_SUPERPOWERS_POLICY` to `ENSYNC_AGENT_COORDINATION_POLICY`;
- rename the serialized policy from `ensync_superpowers_v1` to `ensync_agent_coordination_v1`;
- describe the prompt as Ensync's bundled agent-coordination contract;
- remove `nativePlugin: 'optional'`, because no plugin is loaded or required;
- remove instructions that name upstream Superpowers skills while retaining equivalent runtime-native delegation guidance.

The existing marker remains unchanged so retained, queued, and recovered prompts continue to wrap idempotently.

## Compatibility and data flow

The Host remains the source of provider catalog coordination metadata. The renderer continues to accept `agentCoordination`, now with only `policy` and `delivery`. This metadata is capability information rather than a persisted user preference, so the policy literal can change without a state migration.

All runnable provider prompts still pass through `withEnsyncMultiAgentInstructions`. Local and SSH execution must continue to receive the same contract, and discovery-only providers must remain non-runnable.

## Documentation

Update the durable agent-routing feature record and the Ollama provider note to use Ensync agent-coordination terminology. Keep `docs/superpowers/` as historical design and plan documentation; directory names are not installed skills and removing or relocating them would discard or break project history.

## Verification

Use test-first development for the policy rename: update the behavioral prompt and runner-contract expectations, confirm they fail against the old implementation, then make the smallest production changes that pass. Confirm local and SSH prompt delivery, idempotent wrapping, catalog parity, Auto Context prompt budgeting, TypeScript compatibility, lint, Host tests, desktop tests, and a clean diff. Verify that the stale logo skill and lockfile no longer exist and that the reusable Auto Context skill remains.

