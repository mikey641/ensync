# Ensync desktop

This package wraps the existing Ensync Host and built Vite interface in Electron for macOS and Windows. It is intentionally a distribution boundary: source UI and host behavior stay in the repository root.

## Runtime contract

- Electron enforces one running app instance while allowing multiple native windows. File → New Window or `Cmd/Ctrl+N` creates another `BrowserWindow`; a second process launch focuses the most recently focused surviving window.
- A detached process starts the bundled `host/server.mjs` on an ephemeral loopback port. It is never exposed on a LAN interface, and a user-only authenticated rendezvous record lets a later Ensync process reclaim the exact Host instance.
- Every window uses the same detached Host and privileged standard `ensync://app` origin. That origin stays identical when the private Host port changes, so browser-local workspace tabs, split layout, and display preferences survive native app relaunches. Windows load the same canonical device-local snapshot instead of using ephemeral per-window storage partitions.
- The custom protocol proxies only `ensync://app/api/*` to the loopback Host. It does not open a UI listener or expose the renderer to the Host port.
- App exit stops the custom protocol handler and releases the shell lease, but it does not stop active Host-owned provider jobs. The detached Host exits only after no shell or run remains; retained terminal results stay available through the checksummed job journal.
- Renderer Node integration is disabled; context isolation and sandboxing are enabled. A sandboxed preload exposes fixed `chooseProjectFolder()` and `chooseChatFiles()` requests—no general IPC or filesystem API—to each registered Ensync window, so the project switcher and composer can open the native macOS or Windows chooser. Project and attachment paths still pass through Ensync Host inspection. HTTPS links open in the system browser.

The native menu reserves `Cmd/Ctrl+N` for New Window and `Cmd/Ctrl+Shift+W` for Close Window. It intentionally does not claim `Cmd/Ctrl+T`, `Cmd/Ctrl+W`, or any in-workspace `+`; those continue to create and close Ensync conversation tabs according to the saved placement setting. View → Reload / Force Reload and `Cmd/Ctrl+R` / `Cmd/Ctrl+Shift+R` are available because the renderer synchronously checkpoints active Host-job reconnect metadata before unloading. Manual and programmatic renderer reloads reconnect to the same Host-owned jobs instead of cancelling or replaying them. The desktop shell also uses an authenticated detached Host with renewable leases and a checksummed job journal, so a normal whole-app quit/reopen can reclaim a running job or its retained terminal result; only an actual Host or machine failure during provider execution requires reconciliation.

The protocol is registered as standard, secure, Fetch-capable, and CSP-enforced before Electron becomes ready. Do not replace it with a random-port page origin: Chromium keys `localStorage` by scheme, host, and port, so doing that makes the canonical `ensync-workspace-snapshot-v3` record (and legacy migration keys) appear empty on the next launch.

The shell gives each native window its own `render-process-gone` recovery guard and reloads that window at the same `ensync://app` URL at most twice in a 30-second window. A renderer must remain loaded for that full window before the counter resets. Further crashes show one error for that window and stop its automatic reloads without disposing recovery or controls in the other windows, while leaving the last synchronous workspace snapshot intact.

One operator-authorized Codex transcript import can be applied at process start without editing Chromium storage directly. Quit Ensync normally, then relaunch with all five values below; omit them during ordinary launches:

```sh
ENSYNC_CODEX_IMPORT_TRANSCRIPT='/absolute/path/to/rollout.jsonl' \
ENSYNC_CODEX_IMPORT_HISTORY='/absolute/path/to/history.jsonl' \
ENSYNC_CODEX_IMPORT_PROJECT='/absolute/path/to/project' \
ENSYNC_CODEX_IMPORT_TARGET='shell-issued-workspace-uuid' \
ENSYNC_CODEX_IMPORT_CONFIRM='IMPORT CODEX' \
npm start
```

The import reads fixed, bounded source prefixes, sanitizes only the visible user/assistant transcript, and targets only that UUID. It adds or updates one deterministic conversation, opens its tab, and uses the normal checksummed v3 transaction. Repeating a prefix cannot duplicate the chat/messages; a growing rollout adds only unseen source message IDs. The rollout and history files remain byte-for-byte untouched.

The packaged host still launches the user's installed coding CLIs. Provider subscriptions and credentials are not bundled in the app.

`src/preload.cjs`, `src/project-picker.mjs`, and `src/native-updates.mjs` are explicit package inputs. Keep the preload bridge narrow: a renderer may request only the fixed directory dialog and fixed update actions. The main process authorizes every request against the sending registered Ensync `BrowserWindow` and stable app URL. Folder cancellation changes no project state, and update actions share one truthful app-wide state across all native windows.

## Native updates

Settings shows `app.getVersion()`, the embedded build ID, full source revision, clean/dirty flag, build time, packaging channel, selected update channel, and exact native update phase. Stable uses `https://ensync.vercel.app/releases.json`; opt-in beta uses `https://ensync.vercel.app/releases-beta.json`. Ensync checks automatically in the background at startup and hourly and downloads a verified release automatically, then surfaces an explicit installer action. It offers a release only when the current packaged app is signed and the matching-channel manifest has a newer matching platform version, a real HTTPS installer, a valid SHA-256, verified signing, and explicit macOS notarization. Stable rejects prerelease versions, and changing channels clears any downloaded candidate.

**Download update** is a second action for direct releases. Progress uses only received bytes and a real `Content-Length`; when the total is absent, no percentage is invented. After download, Ensync verifies the manifest checksum and requires the installer publisher to match the installed app: macOS compares the Developer ID team and Gatekeeper-assesses the signed/notarized DMG. A mismatch deletes the temporary installer and never enables opening it.

**Open disk image** is a third action. It asks macOS to open the verified artifact but does not quit Ensync, restart it, run a silent install, or claim completion. Microsoft Store Windows installations skip this direct updater entirely: Settings reports **Managed by Store**, and Microsoft Store owns signing, installation, and updates. Development mode, unsupported platforms, invalid or missing HTTPS feed configuration, unsigned installed builds, unsigned/unnotarized releases, failed checks, and invalid downloads are visibly unavailable or errored rather than treated as current.

## Local setup

Use Node 20 or newer. Install the root and desktop dependencies separately:

```sh
npm ci
npm --prefix desktop ci
```

Start the native shell in development mode:

```sh
npm --prefix desktop start
```

Run the desktop tests and a real host/UI smoke check:

```sh
npm --prefix desktop test
npm --prefix desktop run build:ui
npm --prefix desktop run smoke
```

## Platform packages

Build macOS artifacts on macOS and Windows artifacts on Windows:

```sh
npm --prefix desktop run package:mac
npm --prefix desktop run package:win-store
```

The macOS command creates a universal DMG and ZIP. The Windows command creates an x64 NSIS installer and ZIP. Each command first records semantic version, exact Git commit, dirty flag, build time, and channel in ignored generated metadata; the same identity is embedded in the app and copied into the attestation under `desktop/release/`. Local builds default to `dev`. Cross-platform package output is not claimed or substituted when the corresponding native build did not run.

## Signing and notarization secrets

Unsigned local builds work for testing, but their generated site manifest remains unavailable. Signing is activated only when these secrets are supplied to the release workflow:

| GitHub secret | Build environment | Purpose |
| --- | --- | --- |
| `MACOS_CSC_LINK` | `CSC_LINK` on macOS | Base64 certificate or secure certificate URL understood by electron-builder |
| `MACOS_CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` on macOS | macOS certificate password |
| `ENSYNC_APPLE_ID` | same name | Apple account used by notarytool |
| `ENSYNC_APPLE_APP_SPECIFIC_PASSWORD` | same name | App-specific Apple password |
| `ENSYNC_APPLE_TEAM_ID` | same name | Apple Developer team identifier |
| `VERCEL_TOKEN` | release publish job | Deploy the verified release manifest to the public site/update feed |
| `VERCEL_ORG_ID` | release publish job | Exact Vercel team/account containing the Ensync project |
| `VERCEL_PROJECT_ID` | release publish job | Exact Vercel `ensync` project identifier |
| `ENSYNC_RELEASE_TOKEN` | release publish job | Least-privilege release access to the separate public binary repository |

Set the non-secret GitHub repository variable `ENSYNC_RELEASE_REPOSITORY` to the public binary repository in `owner/repository` form. It must differ from the private source repository.

Set these non-secret GitHub Actions repository variables:

| Repository variable | Source |
| --- | --- |
| `ENSYNC_RELEASE_REPOSITORY` | Public binary repository in `owner/repository` form |
| `ENSYNC_WINDOWS_STORE_IDENTITY_NAME` | Exact Partner Center **Package/Identity/Name** value |
| `ENSYNC_WINDOWS_STORE_PUBLISHER` | Exact Partner Center **Package/Identity/Publisher** value |
| `ENSYNC_WINDOWS_STORE_PUBLISHER_DISPLAY_NAME` | Exact Partner Center publisher display name |

The source repository may remain private; its workflow token is read-only, and the dedicated release token is used only for public macOS release assets. Store identity values are public manifest data, not credentials, but the workflow still refuses missing, malformed, or mismatched values.

The Windows Store package wrapper disables certificate auto-discovery, injects only the guarded Partner Center identity, and maps the product version plus GitHub run number to a monotonic four-part Store package version ending in `.0`. It verifies those exact fields from the produced `AppxManifest.xml`. Store signing is not claimed before Partner Center certification. The notarization hooks do nothing when all three Apple notarization values are absent and fail the build if only some are present. The signed app is notarized before packaging; the signed DMG is then notarized and stapled after artifact creation. macOS attestations derive `signed` from `codesign --verify`, and notarization from `stapler validate`; they do not infer either from secret presence.

## Release workflow

Pushing a stable tag such as `v0.1.0` or a beta tag such as `v0.2.0-beta.1` starts `.github/workflows/desktop-release.yml` as a full desktop release only after release infrastructure is intentionally configured. A preflight job confirms that the separate binary repository is public and different from the private source repository, macOS signing/notarization is complete, one Windows signing mode is complete, and Vercel deployment credentials exist without printing their values. The remaining jobs:

1. build and test on native macOS and Windows runners;
2. upload only the signed/notarized DMG, signed NSIS EXE, ZIP archives, and verification attestations produced by those jobs;
3. compare every artifact's hash and size against its attestation;
4. require verified Windows signing plus verified macOS signing and notarization;
5. generate `SHA256SUMS.txt` and the channel-specific schema-v1 manifest only after all four production artifacts pass those checks;
6. fetch both production feeds, retain prior same-channel releases for rollback, and preserve the untouched channel;
7. create or repair the release in the separate public binary repository and upload those real files;
8. validate both exact feeds and deploy the production Vercel site using the explicit Vercel release secrets.

If macOS signing or notarization cannot be verified, the publish job fails before creating a GitHub release. The AppX is never copied into public release assets. Upload it to Partner Center and use Private audience for the first beta submission; package flights are available for later beta updates after the initial submission is published. Publish a separately certified listing for stable. Only after Microsoft provides the real `https://apps.microsoft.com/detail/...` product URL may `site/public/site-config.json` enable the Windows button. If Vercel deployment fails, installed apps and the site continue to see the previous production configuration.

A manual **macOS-only** release runs the same workflow from the Actions tab with a channel and semantic version. It skips the Windows and Store jobs, generates the manifest with `--macos-only`, and records `platforms.windows` as `unavailable` because Windows is distributed through the certified Microsoft Store listing. The macOS-only preflight requires only Apple signing/notarization, Vercel, and the public binary repository; it enforces the same channel rules (beta requires a prerelease version such as `0.1.0-beta.1`, stable rejects prereleases).

The full inactive-to-beta-to-stable process and review-only rollback command are in `docs/release-runbook.md`. The manual flow follows Electron's requirement that macOS updates use signed apps and electron-builder's signed macOS/NSIS artifact guidance, while deliberately avoiding background `autoUpdater` behavior: [Electron updates](https://www.electronjs.org/docs/latest/tutorial/updates) and [electron-builder auto update](https://www.electron.build/docs/features/auto-update/).
