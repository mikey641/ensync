const sha256Pattern = /^[a-f0-9]{64}$/i;

function unavailable(reason) {
  return {
    available: false,
    reason,
    version: null,
    url: null,
    sha256: null,
    architectures: [],
  };
}

function isSecureUrl(value) {
  if (typeof value !== 'string') return false;

  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function resolveDownload(manifest, platform, expectedChannel = 'stable') {
  if (!manifest || manifest.schemaVersion !== 1) {
    return unavailable('The release manifest is missing or unsupported.');
  }
  const manifestChannel = manifest.channel ?? 'stable';
  if (!['stable', 'beta'].includes(expectedChannel) || manifestChannel !== expectedChannel) {
    return unavailable('The release manifest does not match the selected channel.');
  }

  const release = manifest.platforms?.[platform];
  if (!release) {
    return unavailable('This platform is not listed in the release manifest.');
  }

  if (release.status !== 'available') {
    return unavailable(
      typeof release.reason === 'string' && release.reason.trim()
        ? release.reason.trim()
        : 'No verified build is available for this platform.',
    );
  }

  const latestVersion = manifest.latest?.version;
  if (typeof latestVersion !== 'string' || !latestVersion.trim()) {
    return unavailable('The latest release does not have a verified version.');
  }
  if (expectedChannel === 'stable' && latestVersion.includes('-')) {
    return unavailable('The stable feed cannot publish a prerelease version.');
  }
  if (expectedChannel === 'beta' && !latestVersion.includes('-')) {
    return unavailable('The beta feed must publish an explicit prerelease version.');
  }

  if (release.version !== latestVersion) {
    return unavailable('This build does not match the latest verified release.');
  }

  if (release.signed !== true) {
    return unavailable('The latest build has not been marked as signed.');
  }

  if (platform === 'macos' && release.notarized !== true) {
    return unavailable('The latest macOS build has not been marked as notarized.');
  }

  if (!isSecureUrl(release.url)) {
    return unavailable('The latest build does not have a secure download URL.');
  }

  if (typeof release.sha256 !== 'string' || !sha256Pattern.test(release.sha256)) {
    return unavailable('The latest build does not have a valid SHA-256 checksum.');
  }

  return {
    available: true,
    reason: null,
    version: latestVersion,
    url: release.url,
    sha256: release.sha256.toLowerCase(),
    architectures: Array.isArray(release.architectures)
      ? release.architectures.filter((item) => typeof item === 'string' && item.trim())
      : [],
  };
}

export function releaseLabel(download) {
  if (!download.available) return 'Not available yet';
  const architectures = download.architectures.join(' + ');
  return architectures ? `Version ${download.version} · ${architectures}` : `Version ${download.version}`;
}

export function windowsStoreProductId(listing) {
  if (!listing?.url) return null;
  try {
    const url = new URL(listing.url);
    if (url.origin !== 'https://apps.microsoft.com' || url.username || url.password) return null;
    const match = url.pathname.match(/^\/detail\/([^/]+)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function resolveWindowsStoreListing(config) {
  const value = config?.downloads?.windowsStoreUrl;
  if (value === null || value === undefined || value === '') {
    return unavailable('The Windows Store package is in a private-audience beta and has no public listing URL yet.');
  }
  if (typeof value !== 'string') {
    return unavailable('The Microsoft Store listing URL is invalid.');
  }

  try {
    const url = new URL(value);
    const detailPath = url.pathname.match(/^\/detail\/(.+)$/i)?.[1];
    if (
      url.origin !== 'https://apps.microsoft.com'
      || url.username
      || url.password
      || !detailPath
      || !detailPath.split('/').every(Boolean)
    ) {
      return unavailable('The Microsoft Store listing URL is invalid.');
    }
    return {
      available: true,
      reason: null,
      version: null,
      url: url.href,
      sha256: null,
      architectures: [],
    };
  } catch {
    return unavailable('The Microsoft Store listing URL is invalid.');
  }
}
