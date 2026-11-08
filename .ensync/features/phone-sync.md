---
name: Phone sync
description: QR-only phone linking and live two-way sync of projects and conversations between the desktop and the phone.
---

# Phone sync

## Product intent (from the user, 2026-11-08)

"Ensync" means sync. Scanning one QR code on the desktop must be the whole phone setup: no account form, no
password, no pairing code, no typing a folder path. After that, everything on the desktop appears on the phone and
vice versa: the same projects, the same conversations with their messages, and a message sent from the phone runs on
the Mac in that conversation and shows up in the desktop tab.

## What already exists (build on it, don't duplicate)

- Desktop already pushes an encrypted account workspace document (`prepareAccountWorkspace` in
  `src/lib/accountWorkspaceSync.mjs`: `{format, version, chats[], projects[]}`) to Ensync Sync `PUT /v1/workspace`,
  and merges remote changes message-by-message (`mergeAccountWorkspace`). Encryption: AES-256-GCM, account key =
  scrypt(password, salt, N=16384,r=8,p=1, 32 bytes), AAD `ensync-account-workspace-v1\n<username>`
  (`encryptWorkspace`/`decryptWorkspace` in `host/account-sync.mjs`).
- Brokered execution: phone submits an encrypted job envelope to `POST /v1/broker/jobs`; the desktop Host polls,
  claims and runs it through `ChatJobService` (`host/sync-broker-host.mjs`). The chat request accepts
  `provider, projectPath, prompt, workspaceKey, sessionId, model, deliveryTarget`.
- Desktop chats run in `workspaceKey = resolveConversationWorkspaceKey(chat)` (`src/lib/conversationWorkspaceKey.mjs`).
- The bundled Sync service is published by a Cloudflare quick tunnel; the phone PWA is hosted at
  `https://ensync.vercel.app/mobile/` (allowed origin of the bundled service).

## Protocol additions

### 1. QR link (replaces login + pairing code)

Desktop QR encodes `https://ensync.vercel.app/mobile/#link=<base64url(JSON)>`. The fragment never reaches any server.

```json
{ "v": 1, "sync": "<https sync url>", "token": "<one-time link token>", "username": "<account>",
  "key": "<base64url 32-byte account key>", "hostId": "<host device id>", "hostLabel": "studio" }
```

Sync service:
- `POST /v1/broker/links` (bearer of a signed-in session that owns `hostId`) body `{ hostId }` →
  `{ token, expiresAt }`. Single use, 10-minute expiry, stored hashed.
- `POST /v1/broker/links/claim` (no auth) body `{ token, deviceId, label }` → creates a `client` device for that
  account, pairs it with `hostId`, consumes the token, and returns
  `{ username, session: { token, expiresAt }, refreshToken, device: {...}, host: {...} }`.
- `POST /v1/sessions/refresh` (no auth) body `{ refreshToken, deviceId }` → `{ session: { token, expiresAt } }`.
  Refresh tokens are long-lived (180 days, sliding), stored hashed, bound to the device, and die when the device or
  pairing is revoked. This is what keeps the phone signed in forever without a password.

### 2. Live updates (both directions, near-instant)

- `GET /v1/workspace/wait?after=<revision>&timeout=25` (bearer): long-poll; returns immediately with the same body as
  `GET /v1/workspace` when `revision > after`, else after the timeout with `{ revision, changed: false }`.
- Desktop: push the workspace debounced (~1.5 s) whenever chats/projects change, and run a background long-poll
  loop (replacing the 30 s interval while signed in) that pulls/merges as soon as the revision moves.
- Phone: same long-poll loop; it pulls → merges → pushes with `baseRevision` using the same merge semantics.

### 3. Turns sent from the phone

1. Phone appends `{ id, role: 'user', content, createdAt, origin: 'phone' }` (use the real message shape from
   `portableMessage`) to the chat in the workspace document and pushes it (conflict → re-merge → retry).
2. Phone submits a broker job whose request is
   `{ provider, projectPath: project.path, prompt, workspaceKey: <same as desktop for this chat>, sessionId:
   <chat continuation session for that provider, if any>, model, conversationId: chat.id, messageId: <user msg id> }`.
   `conversationId`/`messageId` are new optional request fields the Host must accept (validated, not passed to the CLI).
3. Host: when a brokered job with a `conversationId` finishes, the Host itself (it holds the account key) appends the
   assistant reply (and updated continuation session id) to that chat in the workspace document and pushes it. This
   keeps the result durable even if the phone is closed. The desktop renderer receives it through its long-poll.
4. Phone shows live job events while the job runs, then the persisted assistant message once it lands in the doc.
5. New chat from the phone: phone creates the chat object (new stable id, projectId, provider, title from the
   prompt) in the doc, then step 2.

### 4. Desktop UX

- Settings → "Connect your phone" shows the QR immediately. One host endpoint (`POST /api/account-sync/phone-link`)
  does everything: if no Sync account exists, create one silently (generated username + strong random password kept
  in the Host's encrypted secret store, never shown); sign in; register this computer as Host and start remote
  access; ensure the tunnel is published; create a link token; return `{ url, expiresAt }`. The QR refreshes
  itself before expiry. Pairing codes and the login form move under an "Advanced" disclosure.
- Remote access (Host polling) is on by default and stays on across restarts once a phone is linked.
- Linked phones are listed with a "Disconnect" (revoke) button.

### 5. Phone UX

- No login screen. Without a stored link: one screen saying "Scan the QR in Ensync on your computer".
- Projects screen (workspace `projects` ∪ host `capabilities.recentProjects`, ordered by latest chat activity) →
  project's conversations (newest first, "New chat") → conversation view (messages with bidi/RTL-aware text, basic
  markdown/code, composer pinned to the bottom, provider picker defaulting to the chat's provider, Stop/Steer while
  running). Native back navigation via the History API; safe-area insets; dark mode.

## Known limit

A Cloudflare quick-tunnel URL changes when Ensync restarts, so a linked phone loses its Sync address. Until a stable
URL exists, the phone must detect this and show "Your computer's address changed: scan the QR again" instead of a
generic error. A stable named-tunnel URL (own domain) removes the problem.
