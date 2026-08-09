import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseLabel, resolveDownload, resolveWindowsStoreListing } from '../public/release-manifest.mjs';

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    latest: { version: '1.2.3', publishedAt: '2026-08-06T00:00:00Z', notesUrl: null },
    platforms: {
      macos: {
        status: 'available',
        reason: null,
        version: '1.2.3',
        url: 'https://downloads.example.test/ensync-1.2.3.dmg',
        sha256: 'a'.repeat(64),
        signed: true,
        notarized: true,
        architectures: ['Apple Silicon', 'Intel'],
        ...overrides,
      },
    },
  };
}

test('resolves a signed HTTPS artifact that matches the latest release', () => {
  const result = resolveDownload(manifest(), 'macos');
  assert.equal(result.available, true);
  assert.equal(result.version, '1.2.3');
  assert.equal(result.sha256, 'a'.repeat(64));
  assert.equal(releaseLabel(result), 'Version 1.2.3 · Apple Silicon + Intel');
});

test('keeps a platform unavailable when the manifest says unavailable', () => {
  const result = resolveDownload(manifest({ status: 'unavailable', reason: 'No signed build yet.' }), 'macos');
  assert.deepEqual(result.available, false);
  assert.equal(result.reason, 'No signed build yet.');
});

test('rejects unsigned, non-HTTPS, and checksum-less artifacts', () => {
  assert.match(resolveDownload(manifest({ signed: false }), 'macos').reason, /signed/);
  assert.match(resolveDownload(manifest({ url: 'http://downloads.example.test/app.dmg' }), 'macos').reason, /secure/);
  assert.match(resolveDownload(manifest({ sha256: null }), 'macos').reason, /SHA-256/);
});

test('rejects a macOS build that is not explicitly notarized', () => {
  const result = resolveDownload(manifest({ notarized: false }), 'macos');
  assert.equal(result.available, false);
  assert.match(result.reason, /notarized/);
});

test('rejects a platform build that does not match latest', () => {
  const result = resolveDownload(manifest({ version: '1.2.2' }), 'macos');
  assert.equal(result.available, false);
  assert.match(result.reason, /latest/);
});

test('fails closed for an absent or unsupported manifest', () => {
  assert.equal(resolveDownload(null, 'windows').available, false);
  assert.equal(resolveDownload({ schemaVersion: 2 }, 'windows').available, false);
});

test('accepts only exact Microsoft Store product listing URLs', () => {
  const available = resolveWindowsStoreListing({
    downloads: { windowsStoreUrl: 'https://apps.microsoft.com/detail/ensync/9ABC123?hl=en-US' },
  });
  assert.equal(available.available, true);
  assert.equal(available.url, 'https://apps.microsoft.com/detail/ensync/9ABC123?hl=en-US');

  assert.equal(resolveWindowsStoreListing({ downloads: { windowsStoreUrl: null } }).available, false);
  assert.equal(resolveWindowsStoreListing({ downloads: { windowsStoreUrl: 'https://example.com/detail/ensync' } }).available, false);
  assert.equal(resolveWindowsStoreListing({ downloads: { windowsStoreUrl: 'http://apps.microsoft.com/detail/ensync' } }).available, false);
  assert.equal(resolveWindowsStoreListing({ downloads: { windowsStoreUrl: 'https://apps.microsoft.com/store/apps' } }).available, false);
});
