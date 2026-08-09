# Ensync product site

This is the standalone, static Ensync product, documentation, help, privacy, and download site. It is intentionally separate from the desktop prototype and can be deployed with Vercel using `site/` as the project root.

The current public production deployment is [https://ensync.vercel.app](https://ensync.vercel.app) in the Vercel project `ensync`. The site is public; macOS remains disabled until its signed artifact satisfies the manifest gate, and Windows remains disabled until the certified Microsoft Store listing is configured.

## Local validation and preview

Requires Node.js 20 or newer. There are no runtime or build dependencies.

```bash
cd site
npm test
npm run preview
```

Open `http://127.0.0.1:4174`. Set `ENSYNC_SITE_PORT` to use a different local port.

## Truthful downloads

The macOS button reads `public/releases.json`. It stays disabled unless all of these are true:

- `latest.version` is set;
- the platform status is `available`;
- the platform version exactly matches `latest.version`;
- `signed` is `true` after the build has actually been code-signed/notarized as required for the platform;
- macOS `notarized` is explicitly `true` after the downloadable DMG and contained app both pass notarization/stapling verification;
- `url` is a real HTTPS artifact URL;
- `sha256` is the artifact's real 64-character SHA-256 checksum.

The Windows button is independent of GitHub release artifacts. It reads `downloads.windowsStoreUrl` from `public/site-config.json` and accepts only an exact `https://apps.microsoft.com/detail/...` product listing. Keep it `null` until Partner Center certification succeeds and the real public listing opens. Store signing, installation, and updates remain Microsoft's responsibility; an uncertified AppX or private package-flight URL must never be linked from the public site.

The repository intentionally starts with both platforms unavailable. `releases.json` is the stable macOS download/update feed and `releases-beta.json` is the opt-in macOS beta feed; publishing either channel must preserve the other file. Do not add placeholder artifacts or mark a build signed before verification. After editing a manifest or Store URL, run `npm test`; validation fails closed for incomplete releases, incorrect channels, or non-Microsoft Store listing URLs.

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

Keep macOS `unavailable` if its signed artifact is not ready. The macOS desktop app uses this exact production URL as its manual update feed. Microsoft Store Windows installations instead detect Store context and disable the direct installer updater.

## Support configuration

`public/site-config.json` contains the public Microsoft Store listing plus support destinations. Its links remain visibly unavailable until they are configured with verified destinations. The help page's report button only copies or downloads a template; it never claims to create a ticket. The configured email is the public support and privacy contact; changing it requires updating and reviewing the privacy policy.

The privacy page is the public Ensync policy used for Store distribution. Keep its account, workspace, execution, provider-disclosure, security, retention, access, deletion, and contact statements aligned with the shipped product before every release. Email contact does not imply a staffed ticket queue or response SLA.

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

The signed desktop tag workflow performs the production deployment automatically only after the macOS attestation and release generation pass. Its Windows Store package remains a private Actions artifact pending Partner Center certification. The workflow requires `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`; missing credentials fail deployment and leave the previously deployed manifest unchanged.
