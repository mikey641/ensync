import { releaseLabel, resolveDownload } from '/release-manifest.mjs';

const root = document.documentElement;
const themeButton = document.querySelector('[data-theme-toggle]');
const mobileMenuButton = document.querySelector('[data-menu-toggle]');
const mobileMenuCloseButton = document.querySelector('[data-menu-close]');
const navigation = document.querySelector('[data-navigation]');

function preferredTheme() {
  const saved = localStorage.getItem('ensync-site-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  root.dataset.theme = theme;
  if (themeButton) {
    themeButton.setAttribute('aria-label', `Use ${theme === 'dark' ? 'light' : 'dark'} theme`);
    themeButton.setAttribute('aria-pressed', String(theme === 'dark'));
    const label = themeButton.querySelector('[data-theme-label]');
    if (label) label.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }
}

applyTheme(preferredTheme());

themeButton?.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('ensync-site-theme', next);
  applyTheme(next);
});

mobileMenuButton?.addEventListener('click', () => {
  const open = navigation?.classList.toggle('is-open') ?? false;
  mobileMenuButton.setAttribute('aria-expanded', String(open));
});

function closeMobileNavigation() {
  navigation?.classList.remove('is-open');
  mobileMenuButton?.setAttribute('aria-expanded', 'false');
}

mobileMenuCloseButton?.addEventListener('click', closeMobileNavigation);
navigation?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMobileNavigation));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && navigation?.classList.contains('is-open')) closeMobileNavigation();
});

const demoInput = document.querySelector('[data-demo-input]');
const demoResponse = document.querySelector('[data-demo-response]');
const demoForm = document.querySelector('[data-demo-form]');

const demoScenarios = {
  login: {
    prompt: 'Continue with another supported subscription without making me rebuild the context.',
    lead: 'Connected once.',
    detail: 'Ensync uses each vendor’s official CLI login and keeps the selected project and conversation attached to the task.',
  },
  model: {
    prompt: 'Use the right supported agent and its native default model for this task.',
    lead: 'Auto is provider-neutral.',
    detail: 'Your saved priority and verified availability choose the supported runner. Unreported model details stay explicit.',
  },
  flow: {
    prompt: 'Keep this workflow moving when the active provider reaches a verified limit.',
    lead: 'Safe handoff ready.',
    detail: 'Ensync can continue before mutation; timeouts, malformed output, tool activity, or unknown work stop for review.',
  },
  tabs: {
    prompt: 'Open this coding conversation as a durable tab beside my other work.',
    lead: 'Conversation opened.',
    detail: 'The tab keeps its own draft, provider choice, execution state, project context, and recovery history.',
  },
};

function setDemoResponse(lead, detail) {
  const paragraph = demoResponse?.querySelector('p');
  if (!paragraph) return;
  const strong = document.createElement('strong');
  strong.textContent = lead;
  paragraph.replaceChildren(strong, document.createTextNode(` ${detail}`));
}

function runDemo() {
  if (!(demoInput instanceof HTMLTextAreaElement) || !demoInput.value.trim()) return;
  const normalized = demoInput.value.toLowerCase();
  const scenario = normalized.includes('tab') || normalized.includes('conversation')
    ? demoScenarios.tabs
    : normalized.includes('model') || normalized.includes('agent')
      ? demoScenarios.model
      : normalized.includes('login') || normalized.includes('subscription')
        ? demoScenarios.login
        : demoScenarios.flow;
  setDemoResponse(scenario.lead, scenario.detail);
}

document.querySelectorAll('[data-demo-prompt]').forEach((button) => {
  button.addEventListener('click', () => {
    const scenario = demoScenarios[button.dataset.demoPrompt];
    if (!(demoInput instanceof HTMLTextAreaElement) || !scenario) return;
    demoInput.value = scenario.prompt;
    setDemoResponse(scenario.lead, scenario.detail);
    demoInput.focus();
    demoInput.setSelectionRange(demoInput.value.length, demoInput.value.length);
  });
});

demoForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  runDemo();
});

demoInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    runDemo();
  }
});

document.querySelectorAll('[data-copy-year]').forEach((element) => {
  element.textContent = String(new Date().getFullYear());
});

function setDownloadUnavailable(card, reason) {
  const button = card.querySelector('[data-download-button]');
  const status = card.querySelector('[data-download-status]');
  const detail = card.querySelector('[data-download-detail]');
  const checksum = card.querySelector('[data-download-checksum]');

  card.dataset.available = 'false';
  if (button) {
    button.removeAttribute('href');
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('tabindex', '-1');
    button.textContent = 'Not available yet';
  }
  if (status) status.textContent = 'Build unavailable';
  if (detail) detail.textContent = reason;
  if (checksum) checksum.hidden = true;
}

function setDownloadAvailable(card, download) {
  const button = card.querySelector('[data-download-button]');
  const status = card.querySelector('[data-download-status]');
  const detail = card.querySelector('[data-download-detail]');
  const checksum = card.querySelector('[data-download-checksum]');
  const checksumValue = card.querySelector('[data-checksum-value]');

  card.dataset.available = 'true';
  if (button) {
    button.href = download.url;
    button.removeAttribute('aria-disabled');
    button.removeAttribute('tabindex');
    button.textContent = `Download ${download.version}`;
  }
  if (status) status.textContent = 'Signed build available';
  if (detail) detail.textContent = releaseLabel(download);
  if (checksum && checksumValue) {
    checksum.hidden = false;
    checksumValue.textContent = download.sha256;
  }
}

async function hydrateDownloads() {
  const cards = [...document.querySelectorAll('[data-download-platform]')];
  if (!cards.length) return;

  try {
    const response = await fetch('/releases.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Release manifest returned ${response.status}`);
    const manifest = await response.json();

    let availableCount = 0;
    for (const card of cards) {
      const download = resolveDownload(manifest, card.dataset.downloadPlatform);
      if (download.available) {
        availableCount += 1;
        setDownloadAvailable(card, download);
      } else {
        setDownloadUnavailable(card, download.reason);
      }
    }

    const manifestStatus = document.querySelector('[data-manifest-status]');
    if (manifestStatus) manifestStatus.textContent = 'Release manifest checked';
    const releaseTruth = document.querySelector('[data-release-truth]');
    if (releaseTruth && availableCount > 0) {
      releaseTruth.textContent = 'Only platforms with a manifest-verified signed build and checksum are available. Other platforms remain disabled.';
    }
  } catch {
    for (const card of cards) {
      setDownloadUnavailable(card, 'Release status could not be verified. No download was offered.');
    }
    const manifestStatus = document.querySelector('[data-manifest-status]');
    if (manifestStatus) manifestStatus.textContent = 'Release manifest unavailable';
    const releaseTruth = document.querySelector('[data-release-truth]');
    if (releaseTruth) releaseTruth.textContent = 'The release manifest could not be verified, so no download was offered.';
  }
}

function setConfiguredLink(element, url, label) {
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    element.removeAttribute('href');
    element.setAttribute('aria-disabled', 'true');
    element.classList.add('is-disabled');
    element.textContent = `${label} not configured`;
    return;
  }

  element.href = url;
  element.textContent = label;
}

async function hydrateSupport() {
  const configuredLinks = [...document.querySelectorAll('[data-config-link]')];
  if (!configuredLinks.length) return;

  try {
    const response = await fetch('/site-config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Site configuration unavailable');
    const config = await response.json();
    const values = {
      issueTracker: [config.support?.issueTrackerUrl, 'Open issue tracker'],
      statusPage: [config.support?.statusPageUrl, 'View service status'],
      sourceRepository: [config.sourceRepositoryUrl, 'View source repository'],
    };

    for (const element of configuredLinks) {
      const [url, label] = values[element.dataset.configLink] ?? [null, 'Link'];
      setConfiguredLink(element, url, label);
    }

    const emailLink = document.querySelector('[data-support-email]');
    const email = config.support?.email;
    if (emailLink && typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      emailLink.href = `mailto:${email}`;
      emailLink.textContent = email;
      emailLink.removeAttribute('aria-disabled');
      emailLink.classList.remove('is-disabled');
    }
  } catch {
    // Static copy already explains that unconfigured channels are unavailable.
  }
}

document.querySelector('[data-copy-support-template]')?.addEventListener('click', async (event) => {
  const template = `# Ensync support request\n\n## What happened\n\n\n## What you expected\n\n\n## Steps to reproduce\n1. \n\n## Environment\n- Ensync version: \n- Operating system: \n- Provider CLI and version: \n- Local or SSH worker: \n\n## Safe diagnostics\n- Exact error message (remove secrets): \n- Did a tool or file mutation start? Yes / No / Unknown\n\nDo not include passwords, bot tokens, API keys, SSH private keys, or subscription cookies.\n`;
  const button = event.currentTarget;

  try {
    await navigator.clipboard.writeText(template);
    button.textContent = 'Template copied';
    window.setTimeout(() => {
      button.textContent = 'Copy support template';
    }, 1800);
  } catch {
    const blob = new Blob([template], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'ensync-support-request.md';
    anchor.click();
    URL.revokeObjectURL(url);
  }
});

hydrateDownloads();
hydrateSupport();
