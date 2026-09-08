# Deploy a shared Ensync Sync service

The desktop app auto-runs a loopback copy of this service for one computer.
A phone or a second computer needs a copy of the same service on a host both
devices can reach over **HTTPS**. This page is the operator quick-start.

## What the service needs

- Node 22+ (or the included Docker image).
- A writable, persistent data file (`ENSYNC_SYNC_DATA_FILE`).
- `ENSYNC_SYNC_HOST=0.0.0.0` so it accepts connections from other devices.
- The hosted phone app's origin in the allowlist:

  ```text
  ENSYNC_SYNC_ALLOWED_ORIGINS=https://ensync.vercel.app
  ```

  Add a comma-separated origin for any other hosted PWA you run yourself, for
  example `https://ensync.vercel.app,https://sync.example.com`.

## Option A — Docker (any HTTPS-capable host)

```bash
docker build -f sync-service/Dockerfile -t ensync-sync .
docker run -d --name ensync-sync \
  -p 127.0.0.1:8080:8080 \
  -v ensync-sync-data:/data \
  -e ENSYNC_SYNC_ALLOWED_ORIGINS=https://ensync.vercel.app \
  --restart unless-stopped \
  ensync-sync
```

Put an HTTPS reverse proxy in front of port 8080 (Caddy provides certificates
automatically), or run the same image on a managed platform that terminates
HTTPS for you.

## Option B — a managed container host

Any Docker host that provides a public HTTPS URL plus a persistent volume works:

- **Fly.io** — `fly launch --dockerfile sync-service/Dockerfile`, attach a
  volume mounted at `/data`, and set the environment variables below. The app
  gets `https://<name>.fly.dev` automatically.
- **Render** — create a Docker web service from this repository, set
  `Dockerfile Path` to `sync-service/Dockerfile`, add a disk mounted at
  `/data`, and set the environment variables below.
- **Railway** — add the repo as a service, point the Dockerfile at
  `sync-service/Dockerfile`, attach a volume at `/data`, and set the
  environment variables below.

## Option C — phone access from the always-on Mac ($0, in-app)

The desktop app can publish the loopback service (default port `43122`) for your
phone without any `cloudflared` install or terminal steps. There are two in-app
paths:

### One click (default)

In **Settings → Account & chat sync**, choose **Enable phone access**. Ensync
downloads the official `cloudflared` binary and starts a free Cloudflare
**quick tunnel**; a few seconds later the panel shows a live
`https://<name>.trycloudflare.com` URL and the **Connect your phone** QR uses
it automatically. It reconnects itself after an app relaunch.

> The quick-tunnel URL is temporary: it changes whenever phone access is
> stopped or the computer restarts, so re-scan the QR after that.

### Permanent link (advanced: your own Cloudflare domain)

From the same panel, choose **Use my own domain for a stable link**:

1. Enter the Cloudflare **domain** already on your account, for example
   `example.com`.
2. Enter the **subdomain** to publish, for example `phone.example.com`.
3. Paste a Cloudflare **API token** scoped to:
   - `Zone → Zone → Read` (to resolve the zone),
   - `Zone → DNS → Edit` (to create the `CNAME` route),
   - `Account → Cloudflare Tunnel → Edit` (to create the tunnel and token).
4. Choose **Enable stable phone access**.

Ensync names the tunnel `ensync-*`, points it at `http://127.0.0.1:43122`, and
stores the token encrypted with Electron `safeStorage`. After setup the panel
shows the stable `https://phone.example.com` URL and the app auto-reconnects it
on relaunch.

> **Caveat:** the Mac must stay awake and running Ensync for the phone to reach
> it. If you want phone access while the Mac is off, use Option A or B on an
> always-on host instead.

## Environment variables

| Variable | Value | Notes |
| --- | --- | --- |
| `ENSYNC_SYNC_HOST` | `0.0.0.0` | Required for any non-loopback deployment. |
| `ENSYNC_SYNC_PORT` | platform's `PORT` or `8080` | The image defaults to `8080`. |
| `ENSYNC_SYNC_DATA_FILE` | `/data/ensync-sync.json` | Must live on a persistent volume. |
| `ENSYNC_SYNC_ALLOWED_ORIGINS` | `https://ensync.vercel.app` | Browser origin(s) allowed to call the API. |

After deployment, confirm with:

```bash
curl -sS https://<your-service>.example/v1/status
# {"service":"ensync-sync","version":1}
```

## Point Ensync at it

On each computer or device, set the Host's Sync URL to the deployed HTTPS URL.
In the desktop app this is the **Settings → Account & chat sync → Sync service
URL** field (no environment variable needed); a shared service can also be set
with:

```text
ENSYNC_SYNC_SERVICE_URL=https://<your-service>.example
```

After saving the desktop field, fully quit and reopen Ensync so the retained
Host starts against the new URL. The **Connect your phone** QR/link appears once
the Host reports an HTTPS service URL. That link opens the phone PWA with
`?sync=<url>` so the Sync URL fills in automatically and only the account name
and password are typed.

> The service stores scrypt password verifiers and AES-256-GCM encrypted
> conversation envelopes. It never receives plaintext prompts, paths, results,
> attachment contents, or provider credentials.
