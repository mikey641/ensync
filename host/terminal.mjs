import { spawn } from 'node:child_process'
import { findExecutable, runProcess, subscriptionEnvironment } from './command.mjs'

function posixQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function powershellQuote(value) {
  return `'${value.replaceAll("'", "''")}'`
}

export function displayCommand(executable, args, platform = process.platform) {
  if (platform === 'win32') {
    return [executable, ...args]
      .map((part) => (/\s|"/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part))
      .join(' ')
  }
  return [executable, ...args].map(posixQuote).join(' ')
}

async function launchMac(executable, args) {
  const command = displayCommand(executable, args, 'darwin')
  const appleScript = [
    'tell application "Terminal"',
    'activate',
    `do script ${JSON.stringify(command)}`,
    'end tell',
  ].join('\n')
  const result = await runProcess('/usr/bin/osascript', ['-e', appleScript], { timeoutMs: 8_000 })
  if (result.exitCode === 0) return { started: true, launchMode: 'terminal' }
  return {
    started: false,
    launchMode: 'manual',
    reason: result.stderr || 'macOS Terminal could not be opened.',
  }
}

async function launchWindows(executable, args) {
  const cliCommand = `& ${powershellQuote(executable)} ${args.map(powershellQuote).join(' ')}`.trim()
  const script = [
    '$ensyncArgs = @("-NoExit", "-Command",',
    `${powershellQuote(cliCommand)})`,
    'Start-Process -FilePath "powershell.exe" -ArgumentList $ensyncArgs',
  ].join(' ')
  const result = await runProcess('powershell.exe', ['-NoProfile', '-Command', script], {
    timeoutMs: 8_000,
  })
  if (result.exitCode === 0) return { started: true, launchMode: 'terminal' }
  return {
    started: false,
    launchMode: 'manual',
    reason: result.stderr || 'Windows PowerShell could not open a login window.',
  }
}

const linuxTerminals = [
  { command: 'x-terminal-emulator', prefix: ['-e'] },
  { command: 'gnome-terminal', prefix: ['--'] },
  { command: 'konsole', prefix: ['-e'] },
  { command: 'xfce4-terminal', prefix: ['--command'] },
]

async function launchLinux(executable, args) {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return {
      started: false,
      launchMode: 'manual',
      reason: 'No graphical Linux session is available. Run the shown command in a terminal.',
    }
  }

  for (const terminal of linuxTerminals) {
    const terminalPath = await findExecutable(terminal.command)
    if (!terminalPath) continue

    const terminalArgs = terminal.command === 'xfce4-terminal'
      ? [...terminal.prefix, displayCommand(executable, args, 'linux')]
      : [...terminal.prefix, executable, ...args]
    const child = spawn(terminalPath, terminalArgs, {
      detached: true,
      env: subscriptionEnvironment(),
      stdio: 'ignore',
    })
    child.unref()
    return { started: true, launchMode: 'terminal' }
  }

  return {
    started: false,
    launchMode: 'manual',
    reason: 'No supported terminal application was found. Run the shown command in a terminal.',
  }
}

export async function launchTerminalCommand(executable, args, platform = process.platform) {
  if (platform === 'darwin') return launchMac(executable, args)
  if (platform === 'win32') return launchWindows(executable, args)
  if (platform === 'linux') return launchLinux(executable, args)
  return {
    started: false,
    launchMode: 'manual',
    reason: `Automatic terminal launch is not supported on ${platform}.`,
  }
}

// Compatibility alias for existing callers that launch provider login commands.
export const launchLogin = launchTerminalCommand
