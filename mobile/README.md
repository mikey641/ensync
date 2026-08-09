# Ensync Mobile

The iOS and Android clients submit end-to-end encrypted jobs through Ensync Sync. A paired Ensync Host decrypts and validates each request, then runs the selected subscription CLI in its protected conversation worktree. Sync never receives plaintext prompts, project paths, results, or provider credentials.

## Development

```bash
npm install
npm run dev
```

Use the account panel in Ensync Desktop to enable remote execution and create a one-time pairing code. The mobile app signs into the same account, claims that code, and can then submit jobs to that Host.

The Sync service must be reachable at an HTTPS URL. Native Capacitor loopback origins are accepted by the bundled service; additional browser origins must be listed in the service's comma-separated `ENSYNC_SYNC_ALLOWED_ORIGINS` setting. Account passwords, the derived payload key, bearer session, and device token remain in app memory. Only the stable device ID and selected Sync URL are persisted locally in this development build.

## Native projects

```bash
npm run sync
npm run open:ios
npm run open:android
```

iOS builds require Xcode on macOS. Android builds require Android Studio and a configured Android SDK. The current client supports same-account Host pairing, manually entered Host project paths, Codex/Claude job submission, encrypted event polling, stop, and steer. Host project discovery, attachments, OS-backed credential persistence, background push wake-up, App Store/Play Store signing, and production push notifications remain release work; local native projects are development builds.
