import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDownload, resolveWindowsStoreListing } from '../public/release-manifest.mjs';

const siteRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const publicRoot = resolve(siteRoot, 'public');
const requiredFiles = [
  'index.html',
  '404.html',
  'app.js',
  'styles.css',
  'release-manifest.mjs',
  'releases.json',
  'site-config.json',
  'provider-catalog.json',
  'docs/index.html',
  'support/index.html',
  'privacy/index.html',
];
const requiredBinaryFiles = ['og.png'];

const errors = [];
const fileContents = new Map();

for (const file of requiredFiles) {
  try {
    fileContents.set(file, await readFile(resolve(publicRoot, file), 'utf8'));
  } catch {
    errors.push(`Missing required public file: ${file}`);
  }
}

for (const file of requiredBinaryFiles) {
  if (!existsSync(resolve(publicRoot, file))) errors.push(`Missing required public file: ${file}`);
}

for (const [file, contents] of fileContents) {
  if (!file.endsWith('.html')) continue;
  if (/href=["']#["']/.test(contents)) errors.push(`${file} contains a placeholder href="#".`);
  if (!contents.includes('name="viewport"')) errors.push(`${file} is missing a viewport meta tag.`);
}

try {
  const siteProviderCatalog = JSON.parse(fileContents.get('provider-catalog.json'));
  if (!Array.isArray(siteProviderCatalog) || siteProviderCatalog.length === 0) {
    errors.push('provider-catalog.json must contain at least one provider.');
  } else {
    const publicProviderPages = ['index.html', 'docs/index.html'];
    for (const provider of siteProviderCatalog) {
      if (!provider || typeof provider.id !== 'string' || typeof provider.name !== 'string' || typeof provider.documentationUrl !== 'string') {
        errors.push('provider-catalog.json contains an invalid provider record.');
        continue;
      }
      for (const page of publicProviderPages) {
        if (!fileContents.get(page)?.includes(provider.name)) {
          errors.push(`${page} is missing runtime provider ${provider.name}.`);
        }
      }
      if (!fileContents.get('docs/index.html')?.includes(provider.documentationUrl)) {
        errors.push(`docs/index.html is missing the official install/documentation URL for ${provider.name}.`);
      }
    }

    const runtimeCatalogPath = resolve(siteRoot, '../host/providers.mjs');
    if (existsSync(runtimeCatalogPath)) {
      const { getProviderCatalog } = await import(pathToFileURL(runtimeCatalogPath).href);
      const runtimeProviderCatalog = getProviderCatalog().map(({ id, name, documentationUrl }) => ({ id, name, documentationUrl }));
      if (JSON.stringify(siteProviderCatalog) !== JSON.stringify(runtimeProviderCatalog)) {
        errors.push('provider-catalog.json does not match the Ensync Host runtime catalog.');
      }
    }
  }
} catch (error) {
  errors.push(`Invalid provider-catalog.json: ${error.message}`);
}

try {
  const manifest = JSON.parse(fileContents.get('releases.json'));
  for (const platform of ['macos', 'windows']) {
    const result = resolveDownload(manifest, platform);
    const declaredAvailable = manifest.platforms?.[platform]?.status === 'available';
    if (declaredAvailable && !result.available) {
      errors.push(`${platform} is declared available but cannot be safely resolved: ${result.reason}`);
    }
    if (!declaredAvailable && result.available) {
      errors.push(`${platform} resolved as available without an available manifest status.`);
    }
  }
} catch (error) {
  errors.push(`Invalid releases.json: ${error.message}`);
}

try {
  const config = JSON.parse(fileContents.get('site-config.json'));
  const supportEmail = config.support?.email;
  if (supportEmail !== null && (typeof supportEmail !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(supportEmail))) {
    errors.push('support.email must be null or a valid email address.');
  }

  const urlValues = [
    ['support.issueTrackerUrl', config.support?.issueTrackerUrl],
    ['support.statusPageUrl', config.support?.statusPageUrl],
    ['sourceRepositoryUrl', config.sourceRepositoryUrl],
  ];

  for (const [name, value] of urlValues) {
    if (value !== null && (typeof value !== 'string' || !value.startsWith('https://'))) {
      errors.push(`${name} must be null or a verified HTTPS URL.`);
    }
  }

  const storeUrl = config.downloads?.windowsStoreUrl;
  if (storeUrl !== null && !resolveWindowsStoreListing(config).available) {
    errors.push('downloads.windowsStoreUrl must be null or an exact https://apps.microsoft.com/detail/... listing URL.');
  }

  const privacyPage = fileContents.get('privacy/index.html') ?? '';
  if (privacyPage.includes('not a published legal privacy policy')) {
    errors.push('privacy/index.html still disclaims being a legal privacy policy.');
  }
  if (!privacyPage.includes('Privacy Policy') || !privacyPage.includes('Information Ensync processes') || !privacyPage.includes('Retention and deletion')) {
    errors.push('privacy/index.html is missing required privacy-policy disclosures.');
  }
  if (supportEmail && (!privacyPage.includes(supportEmail) || !fileContents.get('support/index.html')?.includes(supportEmail))) {
    errors.push('The configured support email must appear on the privacy and support pages.');
  }
} catch (error) {
  errors.push(`Invalid site-config.json: ${error.message}`);
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${requiredFiles.length + requiredBinaryFiles.length} public files, manifest-gated macOS downloads, and the Microsoft Store Windows link.`);
}
