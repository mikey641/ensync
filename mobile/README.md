# Ensync Mobile

The iOS and Android clients submit end-to-end encrypted jobs through Ensync Sync. A paired Ensync Host decrypts and validates each request, then runs the selected subscription CLI in its protected conversation worktree. Sync never receives plaintext prompts, project paths, results, or provider credentials.

## Development

```bash
npm install
npm run dev
```

Setup is one QR scan (see `.ensync/features/phone-sync.md`). Ensync Desktop shows a QR that opens `https://ensync.vercel.app/mobile/#link=<payload>`; the app claims the one-time link token, strips the fragment, and stores the session, refresh token, device token, account key, and Host in `localStorage` so it stays linked across reloads with no login form. It then mirrors the encrypted account workspace (projects and conversations) live through `GET /v1/workspace/wait`, and a message sent from the phone is appended to that conversation in the document and run on the Host in the same conversation worktree.

To try it locally without the desktop, run `npm run dev` and use the test harness in `test/phone-sync-harness.mjs` (it wraps the bundled Sync service with the link, refresh, and long-poll endpoints) to mint a `#link=` URL; `host/mobile-broker-client.test.mjs` shows the full flow.

The Sync service must be reachable at an HTTPS URL. Native Capacitor loopback origins are accepted by the bundled service; additional browser origins must be listed in the service's comma-separated `ENSYNC_SYNC_ALLOWED_ORIGINS` setting.

## Web app (PWA)

The same client is an installable web app. It works full-screen on iOS and Android home screens without the App Store or Play Store.

The production site publishes this client at <https://ensync.vercel.app/mobile/>. Open that URL on your phone, then choose **Add to Home Screen** (iOS) or accept the browser install prompt (Android).

Scan the QR in desktop **Settings → Connect your phone**. On iOS, a home-screen app keeps its own storage separate from Safari, so scan with the camera, finish linking in Safari, then add that page to the Home Screen.

To host it yourself:

```bash
npm install
npm run build
```

`vite.config.mjs` builds with relative asset URLs (`base: './'`) so the `dist/` directory works under any HTTPS path, not just the domain root. Serve `dist/` from any HTTPS static host, add the web origin to `ENSYNC_SYNC_ALLOWED_ORIGINS`, then choose **Add to Home Screen** from the browser. The bundled service worker (`public/sw.js`) caches only the app shell so the PWA opens offline while every Sync request stays network-first for live job state; encrypted job and event payloads are never cached. The manifest and `apple-touch-icon` let iOS and Android install it in standalone mode.

## Native projects

```bash
npm run sync
npm run open:ios
npm run open:android
```

iOS builds require Xcode on macOS. Android builds require Android Studio and a configured Android SDK. The current client supports QR linking, the synchronized project and conversation list, phone turns with live events, stop, and steer. QR deep links into the native app, attachments, OS-backed credential persistence, background push wake-up, App Store/Play Store signing, and production push notifications remain release work; local native projects are development builds.
