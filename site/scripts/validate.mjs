import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDownload } from '../public/release-manifest.mjs';

const siteRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const publicRoot = resolve(siteRoot, 'public');
const requiredFiles = [
  'index.html',
  '404.html',
  'app.js',
  'styles.css',
  'release-manifest.mjs',
  'releases.json',
  'releases-beta.json',
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

for (const [file, channel] of [['releases.json', 'stable'], ['releases-beta.json', 'beta']]) {
  try {
    const manifest = JSON.parse(fileContents.get(file));
    const manifestChannel = manifest.channel ?? 'stable';
    if (manifestChannel !== channel) {
      errors.push(`${file} declares ${manifestChannel} instead of ${channel}.`);
    }
    for (const platform of ['macos', 'windows']) {
      const result = resolveDownload(manifest, platform, channel);
      const declaredAvailable = manifest.platforms?.[platform]?.status === 'available';
      if (declaredAvailable && !result.available) {
        errors.push(`${file} ${platform} is declared available but cannot be safely resolved: ${result.reason}`);
      }
      if (!declaredAvailable && result.available) {
        errors.push(`${file} ${platform} resolved as available without an available manifest status.`);
      }
    }
  } catch (error) {
    errors.push(`Invalid ${file}: ${error.message}`);
  }
}

try {
  const config = JSON.parse(fileContents.get('site-config.json'));
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
} catch (error) {
  errors.push(`Invalid site-config.json: ${error.message}`);
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated ${requiredFiles.length + requiredBinaryFiles.length} public files and separate manifest-gated stable/beta downloads.`);
}
