# Ensync desktop release runbook

This runbook prepares the path from local development to beta and stable desktop updates. It does not authorize publishing. Do not create a remote, add credentials, tag, sign, upload, or deploy until the product owner explicitly starts a release.

## Current state

- Source remains private and under active development.
- `site/public/releases.json` and `site/public/releases-beta.json` are separate, fail-closed feeds with no available build.
- Local packages are development artifacts. Without explicit platform credentials they remain unsigned, and native updates stay disabled.
- The public binary repository, signing identities, release credential, and Vercel credentials are intentionally unconfigured.

## Development fix loop

1. Record the installed semantic version, 16-character build ID, full source commit, clean/dirty flag, build time, operating system, and selected update channel shown in Settings.
2. Reproduce the problem in the protected development worktree.
3. Add a regression test when the behavior can be automated.
4. Fix the issue and run the focused tests.
5. Run `npm run release:verify` before considering a beta.
6. Build a local native test artifact on its matching operating system. Packaging embeds `desktop/build/generated/build-info.json` in the app and copies the same provenance into the native attestation.
7. Confirm that conversations, device preferences, native workspaces, recovery state, and the Host job journal still open correctly.

## One-time production setup (only after explicit authorization)

1. Keep the source repository private.
2. Create a separate public GitHub repository containing release binaries only. Set repository variable `ENSYNC_RELEASE_REPOSITORY` to `owner/repository`.
3. Create a least-privilege fine-grained token that can manage releases only in that public repository and store it as `ENSYNC_RELEASE_GITHUB_TOKEN`.
4. Configure Apple Developer ID signing/notarization and exactly one Windows signing path: PFX or Microsoft Trusted Signing.
5. Configure the exact Vercel `ensync` project credentials.
6. Run the release preflight in CI. It verifies that the binary repository is public and different from the private source repository before either native build starts.

## Beta

1. Choose a prerelease version such as `1.2.0-beta.1`; beta always requires an explicit prerelease suffix.
2. Run the full verification and the explicit storage compatibility gate: `npm run test:release-compatibility`.
3. Review the source revision and require a clean source attestation on both native runners.
4. Only after authorization, tag the private source revision. The workflow derives the `beta` channel from the tag, builds on native macOS and Windows runners, and publishes assets only to the separate public binary repository.
5. The workflow fetches both current production feeds, replaces only `releases-beta.json`, retains prior beta metadata for rollback, and preserves `releases.json` byte-for-byte.
6. Install the beta manually, confirm the build identity in Settings, and test state migration plus a normal quit/reopen before considering stable.

## Stable

1. Use a plain semantic version such as `1.2.0`; stable rejects prerelease versions.
2. Repeat native builds, signing, notarization, attestations, checksums, and compatibility verification. Stable is a separately verified release, not a relabelled beta artifact.
3. The workflow replaces only `releases.json` and preserves the production beta feed.
4. Confirm both the website download and the in-app Check → Download → Open path. Ensync never silently installs, quits, or restarts.

## Rollback preparation

Rollback never rebuilds an installer or mutates local user data. It repoints one channel feed to a retained release whose original HTTPS URLs, SHA-256 values, build IDs, signatures, and notarization metadata are still present.

Prepare a reviewed rollback manifest locally:

```bash
node desktop/scripts/stage-release-feed.mjs \
  --current /path/to/current/releases.json \
  --channel stable \
  --rollback-version 1.2.3 \
  --output /path/to/review/releases.json
```

Use `releases-beta.json` and `--channel beta` for beta. Before any deployment, download both target installers from the retained URLs, verify their SHA-256 values and native signatures/notarization again, run `npm --prefix site test` with both preserved feeds, and review the manifest diff. Deployment remains a separate explicitly authorized action.

## Release stop conditions

Stop before publishing when any source tree is dirty, native provenance differs across platforms, a signature/notarization or checksum cannot be independently verified, the binary repository is not public and separate, the untouched channel cannot be preserved, a compatibility/recovery test fails, or rollback would strand locally stored state.
