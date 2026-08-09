# Ensync desktop

This package wraps the existing Ensync Host and built Vite interface in Electron for macOS and Windows. It is intentionally a distribution boundary: source UI and host behavior stay in the repository root.

## Runtime contract

- Electron enforces one running app instance while allowing multiple native windows. File → New Window or `Cmd/Ctrl+N` creates another `BrowserWindow`; a second process launch focuses the most recently focused surviving window.
- A detached process starts the bundled `host/server.mjs` on an ephemeral loopback port. It is never exposed on a LAN interface, and a user-only authenticated rendezvous record lets a later Ensync process reclaim the exact Host instance.
- Every window uses the same detached Host and privileged standard `ensync://app` origin. That origin stays identical when the private Host port changes, so browser-local workspace tabs, split layout, and display preferences survive native app relaunches. Windows load the same canonical device-local snapshot instead of using ephemeral per-window storage partitions.
- The custom protocol proxies only `ensync://app/api/*` to the loopback Host. It does not open a UI listener or expose the renderer to the Host port.
- App exit stops the custom protocol handler and releases the shell lease, but it does not stop active Host-owned provider jobs. The detached Host exits only after no shell or run remains; retained terminal results stay available through the checksummed job journal.
- Renderer Node integration is disabled; context isolation and sandboxing are enabled. A sandboxed preload exposes one fixed `chooseProjectFolder()` request—no general IPC or filesystem API—to each registered Ensync window, so the project switcher can open Finder on macOS or the native Windows directory dialog. The returned path still passes through Ensync Host inspection. HTTPS links open in the system browser.

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

Settings shows `app.getVersion()` and the exact native update phase. Ensync does not check in the background. **Check for updates** fetches `https://ensync.vercel.app/releases.json` with cache disabled only after a click. It offers a release only when the current packaged app is signed and the manifest has a newer matching platform version, a real HTTPS installer, a valid SHA-256, verified signing, and explicit macOS notarization.

**Download update** is a second action. Progress uses only received bytes and a real `Content-Length`; when the total is absent, no percentage is invented. After download, Ensync verifies the manifest checksum and requires the installer publisher to match the installed app: macOS compares the Developer ID team and Gatekeeper-assesses the signed/notarized DMG; Windows compares the valid Authenticode certificate subject. A mismatch deletes the temporary installer and never enables opening it.

**Open disk image / Open installer** is a third action. It asks the operating system to open the verified artifact but does not quit Ensync, restart it, run a silent install, or claim completion. Development mode, unsupported platforms, invalid or missing HTTPS feed configuration, unsigned installed builds, unsigned/unnotarized releases, failed checks, and invalid downloads are visibly unavailable or errored rather than treated as current.

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
npm --prefix desktop run package:win
```

The macOS command creates a universal DMG and ZIP. The Windows command creates an x64 NSIS installer and ZIP. Outputs and a build attestation are written under `desktop/release/`. Cross-platform package output is not claimed or substituted when the corresponding native build did not run.

For an explicit local macOS build that keeps one stable Dock target, quit any installed Ensync and run:

```sh
npm --prefix desktop run package:mac:local
```

This runs the full macOS package verification, validates the packaged bundle identifier, stages it beside `/Applications/Ensync.app`, and swaps it into that stable path. It refuses to overwrite a different app or a running installed Ensync. The release workflow never invokes this developer-only install command, and native updates remain review-first rather than silently installing or restarting the app.

## Signing and notarization secrets

Unsigned local builds work for testing, but their generated site manifest remains unavailable. Signing is activated only when these secrets are supplied to the release workflow:

| GitHub secret | Build environment | Purpose |
| --- | --- | --- |
| `MACOS_CSC_LINK` | `CSC_LINK` on macOS | Base64 certificate or secure certificate URL understood by electron-builder |
| `MACOS_CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` on macOS | macOS certificate password |
| `ENSYNC_APPLE_ID` | same name | Apple account used by notarytool |
| `ENSYNC_APPLE_APP_SPECIFIC_PASSWORD` | same name | App-specific Apple password |
| `ENSYNC_APPLE_TEAM_ID` | same name | Apple Developer team identifier |
| `WINDOWS_CSC_LINK` | `CSC_LINK` on Windows | Base64 Windows code-signing certificate or secure certificate URL |
| `WINDOWS_CSC_KEY_PASSWORD` | `CSC_KEY_PASSWORD` on Windows | Windows certificate password |
| `ENSYNC_WINDOWS_AZURE_PUBLISHER_NAME` | same name | Microsoft Trusted Signing certificate common name |
| `ENSYNC_WINDOWS_AZURE_ENDPOINT` | same name | Trusted Signing regional endpoint |
| `ENSYNC_WINDOWS_AZURE_CERTIFICATE_PROFILE_NAME` | same name | Trusted Signing certificate profile |
| `ENSYNC_WINDOWS_AZURE_CODE_SIGNING_ACCOUNT_NAME` | same name | Trusted Signing account name |
| `AZURE_TENANT_ID` | same name | Microsoft Entra tenant for Trusted Signing |
| `AZURE_CLIENT_ID` | same name | Trusted Signing service principal application ID |
| `AZURE_CLIENT_SECRET` | same name | Trusted Signing service principal secret |
| `VERCEL_TOKEN` | release publish job | Deploy the verified release manifest to the public site/update feed |
| `VERCEL_ORG_ID` | release publish job | Exact Vercel team/account containing the Ensync project |
| `VERCEL_PROJECT_ID` | release publish job | Exact Vercel `ensync` project identifier |

Windows may use either the PFX pair or all seven Microsoft Trusted Signing values; configuring both modes or only part of one mode fails before packaging. The packaging wrapper disables certificate auto-discovery unless an explicit signing mode is complete and forces code signing whenever production credentials are supplied. The notarization hooks do nothing when all three Apple notarization values are absent and fail the build if only some are present. The signed app is notarized before packaging; the signed DMG is then notarized and stapled after artifact creation. Build attestations derive `signed` from `codesign --verify` on both app and DMG or PowerShell `Get-AuthenticodeSignature`; they do not infer it from the existence of secrets. macOS notarization is separately checked with `stapler validate` on both app and DMG.

## Release workflow

Pushing a semantic version tag such as `v0.1.0` starts `.github/workflows/desktop-release.yml`. A preflight job first confirms that the repository is public (the manifest uses public GitHub release URLs), macOS signing/notarization is complete, one Windows signing mode is complete, and Vercel deployment credentials exist without printing their values. The remaining jobs:

1. build and test on native macOS and Windows runners;
2. upload only the signed/notarized DMG, signed NSIS EXE, ZIP archives, and verification attestations produced by those jobs;
3. compare every artifact's hash and size against its attestation;
4. require verified Windows signing plus verified macOS signing and notarization;
5. generate `SHA256SUMS.txt` and the shared schema-v1 `releases.json` only after all four production artifacts pass those checks;
6. create the GitHub release and upload those real files;
7. copy that exact generated manifest into `site/public/releases.json`, validate the site, and deploy the production Vercel site using the explicit Vercel release secrets.

If signing or macOS notarization cannot be verified, the publish job fails before creating a GitHub release. Native CI artifacts retain their short-lived test-build attestations for diagnosis, but no unsigned installer becomes a public release. If Vercel credentials or deployment fail after GitHub publication, installed apps and the site continue to see the previous production manifest and do not fabricate availability. Re-running the same tagged workflow repairs or replaces its verified release assets before retrying the feed deployment.

The manual flow follows Electron's requirement that macOS updates use signed apps and electron-builder's signed macOS/NSIS artifact guidance, while deliberately avoiding background `autoUpdater` behavior: [Electron updates](https://www.electronjs.org/docs/latest/tutorial/updates) and [electron-builder auto update](https://www.electron.build/docs/features/auto-update/).
