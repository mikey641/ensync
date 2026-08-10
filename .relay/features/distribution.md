---
name: Product distribution
description: Desktop packaging, signed release manifest, and public Vercel download site.
---

# Product distribution

The public Ensync product site lives in `site/` and is deployed from that directory to the Vercel project `ensync`. Its public production URL is `https://ensync.vercel.app`. The site includes landing, product documentation, support, privacy/billing, and responsive light/dark pages.

The landing page uses a conversation-first, ChatGPT-inspired interaction rhythm without OpenAI branding: a persistent product sidebar, familiar chat composer, prompt suggestions, conversational feature sections, and an Ensync tabs/split-panes preview. The interactive hero is explicitly a no-execution product preview. Copy emphasizes provider-neutral continuity, supported subscription routing, tabs outside an editor, and safe pre-mutation fallback without claiming that discovery-only providers can run. `site/public/og.png` is the matching social card, and the homepage owns absolute Open Graph/X metadata for the canonical production URL.

Downloads fail closed through separate verified channels. The macOS button uses `site/public/releases.json` and is enabled only when the latest version exists, its platform record matches, its real HTTPS artifact and SHA-256 are present, and signing plus notarization were actually verified. The Windows button uses `site/public/site-config.json` and accepts only an exact `https://apps.microsoft.com/detail/...` listing after Partner Center certification. It must never expose an uncertified AppX, private package-flight URL, placeholder, or unsigned local artifact.

The production manifest is the direct macOS update feed. Those updates are manual and three-stage: Check, Download, then Open DMG. The app shows `app.getVersion()` and exact phases; it performs no background checks. A packaged app must first verify its own native signature. A candidate must be newer and pass the same manifest gates as the site. Download progress uses actual received bytes and shows a percentage only with a real total. The completed artifact must match SHA-256 and the installed Developer ID, then pass Gatekeeper assessment. Only then may an explicit action open it. A Windows Store install is detected through Electron's Store context and instead exposes a non-interactive `managed` update state; it never queries Ensync feeds or enables channel/install controls because Microsoft Store owns updates. Development, unsupported, unsigned, unconfigured, stale, invalid, and unverifiable states fail closed.

The native wrapper lives in `desktop/`. Electron starts or reuses one bundled Ensync Host daemon on an ephemeral loopback port but serves every native window from the stable, privileged standard `ensync://app` origin. The daemon uses a user-only atomic rendezvous descriptor, random bearer token, renewable main-process owner leases, and a checksummed bounded job journal. Electron quit/update releases its shell lease without killing active provider jobs; once all jobs are terminal and every lease is gone, the daemon persists final state and exits after a short grace period. A later shell reclaims the same daemon or starts a new one over the journal, returning terminal results idempotently and reconciling orphaned non-terminal work without replay. `Cmd/Ctrl+N` and File → New Window create a clean independently usable `BrowserWindow` in the same app process; they share only the Host and device-wide preferences, not conversations or workspace layout. The canonical window retains the historical unsuffixed v3 snapshot, while each new window receives an opaque main-generated UUID through authorized preload IPC before renderer hydration and uses UUID-namespaced v3 storage. The shell transactionally restores identities open at application quit, always constructs canonical first, and crash reload keeps the assigned identity. Manually closed isolated identities are not restored, but their bytes remain archived; random non-reused UUIDs keep future windows clean without destructive cleanup. Mixed native versions fail closed instead of sharing canonical storage. Each window owns its crash-recovery budget and can invoke the narrowly authorized project picker and updater. A process-scoped `ENSYNC_WORKSPACE_RECOVERY_FILE` path optionally enables one fixed canonical-only recovery IPC: it returns only a bounded v3 envelope, which the renderer checksum-verifies and non-destructively merges before App hydration with a persistent idempotence marker. The application menu deliberately leaves `Cmd/Ctrl+T`, in-workspace `+`, and `Cmd/Ctrl+W` to the renderer, while `Cmd/Ctrl+Shift+W` closes only the focused native window. The custom protocol proxies only `/api` to that private Host, replaces renderer-supplied authorization and owner headers with main-process credentials, opens no second listener, keeps renderer Node access disabled, and retains CSP enforcement. The sandboxed preload exposes only fixed identity, recovery-candidate, directory-picker, and updater IPC calls plus one synchronous `webUtils.getPathForFile` wrapper that accepts an actual renderer `File` dropped by the user. It does not expose Electron, general IPC, raw storage keys, arbitrary path lookup, or filesystem reads. Production packaging targets a universal macOS DMG/ZIP and Windows x64 AppX. Windows packaging injects exact Partner Center identity values, reserves the final Store version component as zero, and verifies the produced AppxManifest; native builds must run on their matching operating system.

The one intentional cross-window data exception is the native shell's neutral Recent Projects registry. It contains only bounded local project name/path/host records and is exposed through fixed per-window-authorized get/migrate/remember IPC plus a broadcast update. Active focus and all conversational workspace state remain private to the originating window namespace.

The tag-triggered desktop release workflow preflights a public release repository, complete macOS signing/notarization, exact Windows Store package identity, and Vercel deployment credentials. It builds both platforms but keeps the AppX and its `pending` Store-certification attestation as a private, short-lived Actions artifact. Public generation accepts only the verified signed/notarized macOS DMG/ZIP, checks their sizes and SHA-256 values against the native attestation, and can never copy `.appx` into the public binary repository. A separate manual Store workflow can build the same private AppX while Apple approval is pending. The first Windows beta submission uses Partner Center's Private audience because package flights are available only after an initial submission has been published; later beta updates may use a package flight. Stable uses a separately certified public listing. Only the real public Store listing URL may enable the site button. The AppX build applies its guarded monotonic Store version through electron-builder's pre-pack manifest hook and re-verifies the packaged manifest afterward. Native workflows invoke the Host and desktop suites through Node test-file enumerators rather than shell globs so Windows and POSIX runners execute the identical file sets. Dirty-checkout snapshot and initial worktree creation explicitly disable Git's automatic line-ending conversion for the transport commands, preserving the user's exact tracked bytes even when Windows has global `core.autocrlf` enabled; the same rule applies to local and SSH isolation. Protected workspace leases keep immutable owner records and refresh file timestamps so concurrent observers never encounter a partial record or Windows sharing violation. A failed site deployment leaves the previous configuration in place. The first private beta AppX is built and identity-attested; Microsoft Store certification remains pending, so the public manifest and Store download button remain unavailable.

## Release lifecycle

Active product development stays separate from public distribution. Preparing this lifecycle does not authorize creating remotes, adding credentials, tagging, signing, publishing, or deploying.

1. Development builds are local test artifacts. Every packaged build carries its exact semantic version, source commit, dirty-worktree flag, build time, and `dev` channel identity so a report can identify the bytes under test. Unsigned development builds continue to fail closed for native updates.
2. Beta is explicit opt-in. macOS prerelease tags update only the beta feed. The first Windows beta submission uses Private audience; after that submission is published, later prereleases may use a private Partner Center package flight. Neither may replace stable.
3. Stable is the default channel. A stable macOS tag may update only the stable feed after signing, notarization, checksums, and attestation pass. Windows stable requires separate Microsoft Store certification and listing publication. Stable releases never contain prerelease versions.
4. Each channel retains prior verified manifest metadata and release artifacts. Rollback changes only that channel's manifest pointer to an already-published, still-verifiable installer; it does not rebuild artifacts, mutate user data, or silently install anything.
5. Fixes move through one repeatable loop: identify the exact build, reproduce, add a regression test where possible, fix, run full verification, publish to beta after credentials are intentionally activated, confirm the installed beta, then promote through a separately verified stable release.

The source repository remains private. Public DMG/ZIP assets live in a separately configured public GitHub releases repository, accessed by a dedicated least-privilege release credential. AppX files remain private Actions artifacts until submitted to Partner Center and never enter that repository. A source-repository tag identifies the source revision; release manifests and native attestations record that revision without exposing source contents. The workflow must verify the configured binary repository is public before it creates a release.

Stable and beta use separate feed files at the same production origin. Deploying one channel must preserve the other channel's last verified feed. Existing stable clients remain compatible with the additive manifest fields. The updater checks that a feed's declared channel matches the user's selected channel, rejects prerelease versions on stable, and clears any downloaded candidate when the channel changes.

Conversation, preference, workspace, and Host-journal formats remain backward-readable across an update. Every format change requires migration and recovery tests before beta. A release is not promoted while a prior supported build cannot open the migrated state or while rollback would strand the user's locally stored data.

## Release lifecycle

Active product development stays separate from public distribution. Preparing this lifecycle does not authorize creating remotes, adding credentials, tagging, signing, publishing, or deploying.

1. Development builds are local test artifacts. Every packaged build carries its exact semantic version, source commit, dirty-worktree flag, build time, and `dev` channel identity so a report can identify the bytes under test. Unsigned development builds continue to fail closed for native updates.
2. Beta is an explicit opt-in update channel with its own HTTPS manifest. Prerelease tags may update only the beta feed and must never replace the stable site download or stable update feed.
3. Stable is the default channel. A stable tag may update only the stable feed after both native builds, signatures, notarization, checksums, and attestations pass. Stable releases never contain prerelease versions.
4. Each channel retains prior verified manifest metadata and release artifacts. Rollback changes only that channel's manifest pointer to an already-published, still-verifiable installer; it does not rebuild artifacts, mutate user data, or silently install anything.
5. Fixes move through one repeatable loop: identify the exact build, reproduce, add a regression test where possible, fix, run full verification, publish to beta after credentials are intentionally activated, confirm the installed beta, then promote through a separately verified stable release.

The source repository is intended to remain private. Public DMG/EXE/ZIP assets live in a separately configured public GitHub releases repository, accessed by a dedicated least-privilege release credential. A source-repository tag identifies the source revision; release manifests and native attestations record that revision without exposing source contents. The workflow must verify the configured binary repository is public before it creates a release.

Stable and beta use separate feed files at the same production origin. Deploying one channel must preserve the other channel's last verified feed. Existing stable clients remain compatible with the additive manifest fields. The updater checks that a feed's declared channel matches the user's selected channel, rejects prerelease versions on stable, and clears any downloaded candidate when the channel changes.

Conversation, preference, workspace, and Host-journal formats remain backward-readable across an update. Every format change requires migration and recovery tests before beta. A release is not promoted while a prior supported build cannot open the migrated state or while rollback would strand the user's locally stored data.

## Release lifecycle

Active product development stays separate from public distribution. Preparing this lifecycle does not authorize creating remotes, adding credentials, tagging, signing, publishing, or deploying.

1. Development builds are local test artifacts. Every packaged build carries its exact semantic version, source commit, dirty-worktree flag, build time, and `dev` channel identity so a report can identify the bytes under test. Unsigned development builds continue to fail closed for native updates.
2. Beta is an explicit opt-in update channel with its own HTTPS manifest. Prerelease tags may update only the beta feed and must never replace the stable site download or stable update feed.
3. Stable is the default channel. A stable tag may update only the stable feed after both native builds, signatures, notarization, checksums, and attestations pass. Stable releases never contain prerelease versions.
4. Each channel retains prior verified manifest metadata and release artifacts. Rollback changes only that channel's manifest pointer to an already-published, still-verifiable installer; it does not rebuild artifacts, mutate user data, or silently install anything.
5. Fixes move through one repeatable loop: identify the exact build, reproduce, add a regression test where possible, fix, run full verification, publish to beta after credentials are intentionally activated, confirm the installed beta, then promote through a separately verified stable release.

The source repository is intended to remain private. Public DMG/EXE/ZIP assets live in a separately configured public GitHub releases repository, accessed by a dedicated least-privilege release credential. A source-repository tag identifies the source revision; release manifests and native attestations record that revision without exposing source contents. The workflow must verify the configured binary repository is public before it creates a release.

Stable and beta use separate feed files at the same production origin. Deploying one channel must preserve the other channel's last verified feed. Existing stable clients remain compatible with the additive manifest fields. The updater checks that a feed's declared channel matches the user's selected channel, rejects prerelease versions on stable, and clears any downloaded candidate when the channel changes.

Conversation, preference, workspace, and Host-journal formats remain backward-readable across an update. Every format change requires migration and recovery tests before beta. A release is not promoted while a prior supported build cannot open the migrated state or while rollback would strand the user's locally stored data.

## Release lifecycle

Active product development stays separate from public distribution. Preparing this lifecycle does not authorize creating remotes, adding credentials, tagging, signing, publishing, or deploying.

1. Development builds are local test artifacts. Every packaged build carries its exact semantic version, source commit, dirty-worktree flag, build time, and `dev` channel identity so a report can identify the bytes under test. Unsigned development builds continue to fail closed for native updates.
2. Beta is an explicit opt-in update channel with its own HTTPS manifest. Prerelease tags may update only the beta feed and must never replace the stable site download or stable update feed.
3. Stable is the default channel. A stable tag may update only the stable feed after both native builds, signatures, notarization, checksums, and attestations pass. Stable releases never contain prerelease versions.
4. Each channel retains prior verified manifest metadata and release artifacts. Rollback changes only that channel's manifest pointer to an already-published, still-verifiable installer; it does not rebuild artifacts, mutate user data, or silently install anything.
5. Fixes move through one repeatable loop: identify the exact build, reproduce, add a regression test where possible, fix, run full verification, publish to beta after credentials are intentionally activated, confirm the installed beta, then promote through a separately verified stable release.

The source repository is intended to remain private. Public DMG/EXE/ZIP assets live in a separately configured public GitHub releases repository, accessed by a dedicated least-privilege release credential. A source-repository tag identifies the source revision; release manifests and native attestations record that revision without exposing source contents. The workflow must verify the configured binary repository is public before it creates a release.

Stable and beta use separate feed files at the same production origin. Deploying one channel must preserve the other channel's last verified feed. Existing stable clients remain compatible with the additive manifest fields. The updater checks that a feed's declared channel matches the user's selected channel, rejects prerelease versions on stable, and clears any downloaded candidate when the channel changes.

Conversation, preference, workspace, and Host-journal formats remain backward-readable across an update. Every format change requires migration and recovery tests before beta. A release is not promoted while a prior supported build cannot open the migrated state or while rollback would strand the user's locally stored data.

## Release lifecycle

Active product development stays separate from public distribution. Preparing this lifecycle does not authorize creating remotes, adding credentials, tagging, signing, publishing, or deploying.

1. Development builds are local test artifacts. Every packaged build carries its exact semantic version, source commit, dirty-worktree flag, build time, and `dev` channel identity so a report can identify the bytes under test. Unsigned development builds continue to fail closed for native updates.
2. Beta is an explicit opt-in update channel with its own HTTPS manifest. Prerelease tags may update only the beta feed and must never replace the stable site download or stable update feed.
3. Stable is the default channel. A stable tag may update only the stable feed after both native builds, signatures, notarization, checksums, and attestations pass. Stable releases never contain prerelease versions.
4. Each channel retains prior verified manifest metadata and release artifacts. Rollback changes only that channel's manifest pointer to an already-published, still-verifiable installer; it does not rebuild artifacts, mutate user data, or silently install anything.
5. Fixes move through one repeatable loop: identify the exact build, reproduce, add a regression test where possible, fix, run full verification, publish to beta after credentials are intentionally activated, confirm the installed beta, then promote through a separately verified stable release.

The source repository is intended to remain private. Public DMG/EXE/ZIP assets live in a separately configured public GitHub releases repository, accessed by a dedicated least-privilege release credential. A source-repository tag identifies the source revision; release manifests and native attestations record that revision without exposing source contents. The workflow must verify the configured binary repository is public before it creates a release.

Stable and beta use separate feed files at the same production origin. Deploying one channel must preserve the other channel's last verified feed. Existing stable clients remain compatible with the additive manifest fields. The updater checks that a feed's declared channel matches the user's selected channel, rejects prerelease versions on stable, and clears any downloaded candidate when the channel changes.

Conversation, preference, workspace, and Host-journal formats remain backward-readable across an update. Every format change requires migration and recovery tests before beta. A release is not promoted while a prior supported build cannot open the migrated state or while rollback would strand the user's locally stored data.

## Release lifecycle

Active product development stays separate from public distribution. Preparing this lifecycle does not authorize creating remotes, adding credentials, tagging, signing, publishing, or deploying.

1. Development builds are local test artifacts. Every packaged build carries its exact semantic version, source commit, dirty-worktree flag, build time, and `dev` channel identity so a report can identify the bytes under test. Unsigned development builds continue to fail closed for native updates.
2. Beta is an explicit opt-in update channel with its own HTTPS manifest. Prerelease tags may update only the beta feed and must never replace the stable site download or stable update feed.
3. Stable is the default channel. A stable tag may update only the stable feed after both native builds, signatures, notarization, checksums, and attestations pass. Stable releases never contain prerelease versions.
4. Each channel retains prior verified manifest metadata and release artifacts. Rollback changes only that channel's manifest pointer to an already-published, still-verifiable installer; it does not rebuild artifacts, mutate user data, or silently install anything.
5. Fixes move through one repeatable loop: identify the exact build, reproduce, add a regression test where possible, fix, run full verification, publish to beta after credentials are intentionally activated, confirm the installed beta, then promote through a separately verified stable release.

The source repository is intended to remain private. Public DMG/EXE/ZIP assets live in a separately configured public GitHub releases repository, accessed by a dedicated least-privilege release credential. A source-repository tag identifies the source revision; release manifests and native attestations record that revision without exposing source contents. The workflow must verify the configured binary repository is public before it creates a release.

Stable and beta use separate feed files at the same production origin. Deploying one channel must preserve the other channel's last verified feed. Existing stable clients remain compatible with the additive manifest fields. The updater checks that a feed's declared channel matches the user's selected channel, rejects prerelease versions on stable, and clears any downloaded candidate when the channel changes.

Conversation, preference, workspace, and Host-journal formats remain backward-readable across an update. Every format change requires migration and recovery tests before beta. A release is not promoted while a prior supported build cannot open the migrated state or while rollback would strand the user's locally stored data.

## Release lifecycle

Active product development stays separate from public distribution. Preparing this lifecycle does not authorize creating remotes, adding credentials, tagging, signing, publishing, or deploying.

1. Development builds are local test artifacts. Every packaged build carries its exact semantic version, source commit, dirty-worktree flag, build time, and `dev` channel identity so a report can identify the bytes under test. Unsigned development builds continue to fail closed for native updates.
2. Beta is an explicit opt-in update channel with its own HTTPS manifest. Prerelease tags may update only the beta feed and must never replace the stable site download or stable update feed.
3. Stable is the default channel. A stable tag may update only the stable feed after both native builds, signatures, notarization, checksums, and attestations pass. Stable releases never contain prerelease versions.
4. Each channel retains prior verified manifest metadata and release artifacts. Rollback changes only that channel's manifest pointer to an already-published, still-verifiable installer; it does not rebuild artifacts, mutate user data, or silently install anything.
5. Fixes move through one repeatable loop: identify the exact build, reproduce, add a regression test where possible, fix, run full verification, publish to beta after credentials are intentionally activated, confirm the installed beta, then promote through a separately verified stable release.

The source repository is intended to remain private. Public DMG/EXE/ZIP assets live in a separately configured public GitHub releases repository, accessed by a dedicated least-privilege release credential. A source-repository tag identifies the source revision; release manifests and native attestations record that revision without exposing source contents. The workflow must verify the configured binary repository is public before it creates a release.

Stable and beta use separate feed files at the same production origin. Deploying one channel must preserve the other channel's last verified feed. Existing stable clients remain compatible with the additive manifest fields. The updater checks that a feed's declared channel matches the user's selected channel, rejects prerelease versions on stable, and clears any downloaded candidate when the channel changes.

Conversation, preference, workspace, and Host-journal formats remain backward-readable across an update. Every format change requires migration and recovery tests before beta. A release is not promoted while a prior supported build cannot open the migrated state or while rollback would strand the user's locally stored data.

Desktop CI is also manually runnable through `workflow_dispatch`. Its native Windows job is configured to run the shared test/runtime smoke suite, build unsigned x64 NSIS/ZIP evidence, launch the unpacked packaged executable under a temporary isolated Windows profile, require both an `ensync://app` DevTools page target and the matching authenticated detached-Host health response, and retain the installer, ZIP, and unsigned attestation as short-lived workflow artifacts. It force-cleans only the spawned smoke process trees. This verifies packaged startup when the job actually passes; configuration alone is not evidence of a run, and it does not prove signing, installation/uninstallation, or real subscription-CLI login and execution.

## Release lifecycle

Active product development stays separate from public distribution. Preparing this lifecycle does not authorize creating remotes, adding credentials, tagging, signing, publishing, or deploying.

1. Development builds are local test artifacts. Every packaged build carries its exact semantic version, source commit, dirty-worktree flag, build time, and `dev` channel identity so a report can identify the bytes under test. Unsigned development builds continue to fail closed for native updates.
2. Beta is an explicit opt-in update channel with its own HTTPS manifest. Prerelease tags may update only the beta feed and must never replace the stable site download or stable update feed.
3. Stable is the default channel. A stable tag may update only the stable feed after both native builds, signatures, notarization, checksums, and attestations pass. Stable releases never contain prerelease versions.
4. Each channel retains prior verified manifest metadata and release artifacts. Rollback changes only that channel's manifest pointer to an already-published, still-verifiable installer; it does not rebuild artifacts, mutate user data, or silently install anything.
5. Fixes move through one repeatable loop: identify the exact build, reproduce, add a regression test where possible, fix, run full verification, publish to beta after credentials are intentionally activated, confirm the installed beta, then promote through a separately verified stable release.

The source repository is intended to remain private. Public DMG/EXE/ZIP assets live in a separately configured public GitHub releases repository, accessed by a dedicated least-privilege release credential. A source-repository tag identifies the source revision; release manifests and native attestations record that revision without exposing source contents. The workflow must verify the configured binary repository is public before it creates a release.

Stable and beta use separate feed files at the same production origin. Deploying one channel must preserve the other channel's last verified feed. Existing stable clients remain compatible with the additive manifest fields. The updater checks that a feed's declared channel matches the user's selected channel, rejects prerelease versions on stable, and clears any downloaded candidate when the channel changes.

Conversation, preference, workspace, and Host-journal formats remain backward-readable across an update. Every format change requires migration and recovery tests before beta. A release is not promoted while a prior supported build cannot open the migrated state or while rollback would strand the user's locally stored data.

## Release lifecycle

Active product development stays separate from public distribution. Preparing this lifecycle does not authorize creating remotes, adding credentials, tagging, signing, publishing, or deploying.

1. Development builds are local test artifacts. Every packaged build carries its exact semantic version, source commit, dirty-worktree flag, build time, and `dev` channel identity so a report can identify the bytes under test. Unsigned development builds continue to fail closed for native updates.
2. Beta is an explicit opt-in update channel with its own HTTPS manifest. Prerelease tags may update only the beta feed and must never replace the stable site download or stable update feed.
3. Stable is the default channel. A stable tag may update only the stable feed after both native builds, signatures, notarization, checksums, and attestations pass. Stable releases never contain prerelease versions.
4. Each channel retains prior verified manifest metadata and release artifacts. Rollback changes only that channel's manifest pointer to an already-published, still-verifiable installer; it does not rebuild artifacts, mutate user data, or silently install anything.
5. Fixes move through one repeatable loop: identify the exact build, reproduce, add a regression test where possible, fix, run full verification, publish to beta after credentials are intentionally activated, confirm the installed beta, then promote through a separately verified stable release.

The source repository is intended to remain private. Public DMG/EXE/ZIP assets live in a separately configured public GitHub releases repository, accessed by a dedicated least-privilege release credential. A source-repository tag identifies the source revision; release manifests and native attestations record that revision without exposing source contents. The workflow must verify the configured binary repository is public before it creates a release.

Stable and beta use separate feed files at the same production origin. Deploying one channel must preserve the other channel's last verified feed. Existing stable clients remain compatible with the additive manifest fields. The updater checks that a feed's declared channel matches the user's selected channel, rejects prerelease versions on stable, and clears any downloaded candidate when the channel changes.

Conversation, preference, workspace, and Host-journal formats remain backward-readable across an update. Every format change requires migration and recovery tests before beta. A release is not promoted while a prior supported build cannot open the migrated state or while rollback would strand the user's locally stored data.

Vercel SSO deployment protection is disabled for the public product site. Site validation is `cd site && npm test`; deployment is `npx vercel --cwd site --prod --yes` after review. Vercel's local `.vercel` and `.env.local` state is ignored and must never be committed.

The public privacy policy at `/privacy/` covers account identifiers, encrypted workspace sync, server- and device-hosted execution, selected AI providers and infrastructure processors, security, retention, user controls, deletion requests, and international processing. The public privacy and support contact is `mikey641@gmail.com`; changing that address requires reviewing the policy and both public pages together. Site validation fails if the policy reverts to a non-legal architecture disclaimer or loses its required disclosures/contact.
