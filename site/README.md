# Ensync product site

This is the standalone, static Ensync product, documentation, help, privacy, and download site. It is intentionally separate from the desktop prototype and can be deployed with Vercel using `site/` as the project root.

The current public production deployment is [https://ensync.vercel.app](https://ensync.vercel.app) in the Vercel project `ensync`. The site is public; its download buttons still remain disabled until signed artifacts satisfy the manifest gate below.

## Local validation and preview

Requires Node.js 20 or newer. There are no runtime or build dependencies.

```bash
cd site
npm test
npm run preview
```

Open `http://127.0.0.1:4174`. Set `ENSYNC_SITE_PORT` to use a different local port.

## Truthful downloads

The macOS and Windows website buttons read the stable `public/releases.json`. Opt-in desktop beta checks use the separate `public/releases-beta.json`; the website never silently switches to beta. A platform download stays disabled unless all of these are true:

- `latest.version` is set;
- the platform status is `available`;
- the platform version exactly matches `latest.version`;
- `signed` is `true` after the build has actually been code-signed/notarized as required for the platform;
- macOS `notarized` is explicitly `true` after the downloadable DMG and contained app both pass notarization/stapling verification;
- `url` is a real HTTPS artifact URL;
- `sha256` is the artifact's real 64-character SHA-256 checksum.

The repository intentionally starts with both platforms unavailable in both channels. Do not add placeholder files or mark a build signed before verification. After editing either manifest, run `npm test`; validation fails closed when an available entry is incomplete or a feed declares the wrong channel/version type.

Example shape for a real platform entry:

```json
{
  "status": "available",
  "reason": null,
  "version": "1.0.0",
  "url": "https://verified-release-host.example/Ensync-1.0.0.dmg",
  "sha256": "REAL_64_CHARACTER_SHA256_CHECKSUM",
  "signed": true,
  "notarized": true,
  "architectures": ["Apple Silicon", "Intel"]
}
```

Keep a platform `unavailable` if its signed artifact is not ready; macOS and Windows are resolved independently. Stable and beta deployments preserve one another. Each populated feed retains prior verified platform records so a reviewed rollback can repoint the channel without rebuilding artifacts or changing local user data.

## Support configuration

`public/site-config.json` contains public support destinations. Its links remain visibly unavailable until a verified HTTPS issue tracker/status page and a working support mailbox are configured. The help page's report button only copies or downloads a template; it never claims to create a ticket.

Before enabling ticket intake, publish a reviewed privacy policy covering the help-desk processor, retention, access, deletion, and incident response. The current privacy page explicitly identifies itself as a product architecture summary rather than a legal policy.

## Vercel deployment

From the repository root, validate and create a preview deployment:

```bash
cd site && npm test
npx vercel --cwd site
```

After reviewing the preview, deploy the exact same `site/` project to production:

```bash
npx vercel --cwd site --prod
```

The included `vercel.json` runs validation, serves `public/`, disables stale caching for the release manifest, and adds basic security headers. Do not deploy from the repository root unless the Vercel project's Root Directory is configured as `site`.

The signed desktop tag workflow performs the production deployment automatically only after both native attestations and release generation pass. It requires `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`; missing credentials fail deployment and leave the previously deployed manifest unchanged.
