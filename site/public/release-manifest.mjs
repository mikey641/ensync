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

export function resolveDownload(manifest, platform) {
  if (!manifest || manifest.schemaVersion !== 1) {
    return unavailable('The release manifest is missing or unsupported.');
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
