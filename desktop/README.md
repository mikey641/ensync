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

The macOS command creates a universal DMG and ZIP. The Store command creates one x64 AppX whose manifest identity must exactly match Partner Center. Outputs and a build attestation are written under `desktop/release/`. The AppX attestation deliberately says certification is pending; the file remains private until Microsoft accepts it. Cross-platform package output is not claimed or substituted when the corresponding native build did not run.

## Release credentials and Store identity

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
| `ENSYNC_RELEASE_TOKEN` | release preflight/publish jobs | Least-privilege token with release-write access to the separate public binary repository |

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

Pushing a semantic version tag such as `v0.1.0` starts `.github/workflows/desktop-release.yml`. A preflight job first confirms that the separately configured binary repository exists and is public, its dedicated token exists, macOS signing/notarization is complete, all three exact Partner Center identity values exist, and Vercel deployment credentials exist without printing their values. The source repository remains private. The remaining jobs:

1. build and test on native macOS and Windows runners;
2. retain the AppX and its pending-certification attestation as a private, short-lived Actions artifact;
3. compare the DMG and ZIP hashes and sizes against the signed/notarized macOS attestation;
4. generate `SHA256SUMS.txt` and the schema-v1 manifest only after both public macOS artifacts pass;
5. create the release in the separate public binary repository with only those verified macOS files;
6. copy that exact generated manifest into `site/public/releases.json` for stable or `site/public/releases-beta.json` for prerelease tags, recover the opposite channel's current manifest from production when present, validate both feeds together, and deploy the production Vercel site.

If macOS signing or notarization cannot be verified, the publish job fails before creating a GitHub release. The AppX is never copied into public release assets. Upload it to Partner Center and use Private audience for the first beta submission; package flights are available for later beta updates after the initial submission is published. Publish a separately certified listing for stable. Only after Microsoft provides the real `https://apps.microsoft.com/detail/...` product URL may `site/public/site-config.json` enable the Windows button. If Vercel deployment fails, installed apps and the site continue to see the previous production configuration.

While Apple approval is pending, `.github/workflows/windows-store-package.yml` can be run manually with a semantic version. It creates the same private AppX without tagging or publishing a GitHub release. Download that Actions artifact and submit it in Partner Center; do not upload the attestation JSON as a Store package.

The direct macOS flow follows Electron's requirement that updates use signed apps while deliberately avoiding background `autoUpdater` behavior. Windows uses Store-managed updates instead: [Electron updates](https://www.electronjs.org/docs/latest/tutorial/updates) and [electron-builder AppX](https://www.electron.build/appx.html).
