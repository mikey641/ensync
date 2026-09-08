
// Official curl install commands verified from each provider's first-party
// documentation. These are the exact commands the provider publishes for
// macOS/Linux. Ensync launches them in a terminal exactly as the connect and
// update routes do; the browser cannot choose the executable or arguments.
//
// Windows PowerShell equivalents are included for cross-platform support but
// are launched through the same terminal-launch path as login/update.
const installCommands = {
  codex: {
    posix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    windows: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    source: 'https://github.com/openai/codex',
  },
  claude: {
    posix: 'curl -fsSL https://claude.ai/install.sh | bash',
    windows: 'irm https://claude.ai/install.ps1 | iex',
    source: 'https://code.claude.com/docs/en/setup',
  },
  copilot: {
    posix: 'curl -fsSL https://gh.io/copilot-install | bash',
    windows: 'irm https://gh.io/copilot-install | iex',
    source: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
  },
  cursor: {
    posix: 'curl https://cursor.com/install -fsS | bash',
    windows: "irm 'https://cursor.com/install?win32=true' | iex",
    source: 'https://cursor.com/docs/cli/installation',
  },
  antigravity: {
    posix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    windows: 'irm https://antigravity.google/cli/install.ps1 | iex',
    source: 'https://antigravity.google/docs/cli/install',
  },
  jules: {
    posix: 'npm install -g @google/jules',
    windows: 'npm install -g @google/jules',
    source: 'https://jules.google/docs/cli/reference/',
  },
  kimi: {
    posix: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    windows: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
    source: 'https://www.kimi.com/help/kimi-code/cli-getting-started',
  },
  kiro: {
    posix: 'curl -fsSL https://cli.kiro.dev/install | bash',
    windows: 'irm https://cli.kiro.dev/install | iex',
    source: 'https://kiro.dev/docs/cli/installation/',
  },
  junie: {
    posix: 'curl -fsSL https://junie.jetbrains.com/install.sh | bash',
    windows: "powershell -NoProfile -ExecutionPolicy Bypass -Command \"iex (irm 'https://junie.jetbrains.com/install.ps1')\"",
    source: 'https://junie.jetbrains.com/docs/junie-cli.html',
  },
  gitlab_duo: {
    posix: 'bash <(curl --fail --silent --show-error --location "https://gitlab.com/gitlab-org/editor-extensions/gitlab-lsp/-/raw/main/packages/cli/scripts/install_duo_cli.sh")',
    windows: 'irm "https://gitlab.com/gitlab-org/editor-extensions/gitlab-lsp/-/raw/main/packages/cli/scripts/install_duo_cli.ps1" | iex',
    source: 'https://docs.gitlab.com/user/gitlab_duo_cli/set_up/',
  },
  oz: {
    posix: 'curl -fsSL https://app.warp.dev/download/agent-cli | bash',
    windows: 'Invoke-RestMethod "https://app.warp.dev/download/agent-cli.ps1" | Invoke-Expression',
    source: 'https://docs.warp.dev/cli/quickstart/',
  },
  droid: {
    posix: 'curl -fsSL https://app.factory.ai/cli | sh',
    windows: 'irm https://app.factory.ai/cli | iex',
    source: 'https://docs.factory.ai/cli/getting-started/quickstart',
  },
  amp: {
    posix: 'curl -fsSL https://ampcode.com/install.sh | bash',
    windows: 'powershell -c "irm https://ampcode.com/install.ps1 | iex"',
    source: 'https://ampcode.com/manual',
  },
  auggie: {
    posix: 'npm install -g @augmentcode/auggie',
    windows: 'npm install -g @augmentcode/auggie',
    source: 'https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli',
  },
  qoder: {
    posix: 'curl -fsSL https://qoder.com/install | bash',
    windows: 'irm https://qoder.com/install.ps1 | iex',
    source: 'https://docs.qoder.com/cli/installation',
  },
  codebuddy: {
    posix: 'curl -fsSL https://www.codebuddy.cn/cli/install.sh | bash',
    windows: 'irm https://www.codebuddy.cn/cli/install.ps1 | iex',
    source: 'https://www.codebuddy.ai/docs/cli/installation',
  },
  ollama: {
    posix: 'curl -fsSL https://ollama.com/install.sh | sh',
    windows: 'irm https://ollama.com/install.ps1 | iex',
    source: 'https://docs.ollama.com/linux',
  },
}

export function getInstallCommand(providerId, platform = process.platform) {
  const command = installCommands[providerId]
  if (!command) return null
  return platform === 'win32'
    ? { command: command.windows, source: command.source }
    : { command: command.posix, source: command.source }
}

export function hasInstallCommand(providerId) {
  return providerId in installCommands
}

// MCP (Model Context Protocol) configuration locations and write schemas are
// catalog-wide knowledge owned by mcp-provider-config.mjs; re-exported here so
// existing discovery callers keep working.
export { getMcpConfigPath, hasMcpConfig } from './mcp-provider-config.mjs'
