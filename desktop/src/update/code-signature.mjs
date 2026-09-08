/**
 * Code-signature checks for the installed build and for a downloaded installer.
 *
 * VS Code has no equivalent: on macOS it hands the update to Squirrel.Mac and on
 * Windows to a signed Inno Setup bundle, and lets the OS enforce the signature.
 * Ensync downloads the installer itself, so it verifies that the installed build
 * is signed at all, and that anything it downloads is signed by the *same*
 * identity, before the file is ever offered to the user.
 */

import { spawn } from 'node:child_process'
import { parse, resolve } from 'node:path'

function appBundleForExecutable(executablePath) {
  let current = resolve(executablePath)
  while (parse(current).root !== current) {
    if (current.toLowerCase().endsWith('.app')) return current
    current = resolve(current, '..')
  }
  return null
}

export function defaultRunCommand(executable, args, options = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const output = []
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolveResult(result)
    }
    child.stdout?.on('data', (chunk) => output.push(chunk))
    child.stderr?.on('data', (chunk) => output.push(chunk))
    child.once('error', () => finish({ ok: false, output: '' }))
    child.once('exit', (code) => finish({ ok: code === 0, output: Buffer.concat(output).toString('utf8') }))
    const timeout = setTimeout(() => {
      child.kill()
      finish({ ok: false, output: '' })
    }, options.timeoutMs ?? 15_000)
    timeout.unref?.()
  })
}

async function readWindowsSignature(filePath, runCommand) {
  const env = { ...process.env, ENSYNC_SIGNATURE_TARGET: filePath }
  const result = await runCommand('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:ENSYNC_SIGNATURE_TARGET; @{ Status = $signature.Status.ToString(); Subject = $signature.SignerCertificate.Subject } | ConvertTo-Json -Compress",
  ], { env, timeoutMs: 20_000 })
  if (!result.ok) return null
  try {
    const parsed = JSON.parse(result.output.trim())
    return parsed.Status === 'Valid' && typeof parsed.Subject === 'string' && parsed.Subject.trim()
      ? parsed.Subject.trim()
      : null
  } catch {
    return null
  }
}

function macTeamIdentifier(output) {
  const match = output.match(/^TeamIdentifier=(.+)$/m)
  const value = match?.[1]?.trim()
  return value && /^[A-Z0-9]{10}$/.test(value) ? value : null
}

async function readMacSignature(filePath, runCommand, deep) {
  const verifyArgs = ['--verify', '--strict']
  if (deep) verifyArgs.push('--deep')
  verifyArgs.push(filePath)
  if (!(await runCommand('codesign', verifyArgs, { timeoutMs: 20_000 })).ok) return null
  const details = await runCommand('codesign', ['--display', '--verbose=4', filePath], { timeoutMs: 20_000 })
  return details.ok ? macTeamIdentifier(details.output) : null
}

export async function verifyInstalledNativeBuild({ platform, executablePath, runCommand = defaultRunCommand }) {
  if (platform === 'darwin') {
    const appBundle = appBundleForExecutable(executablePath)
    if (!appBundle) return { verified: false, signerIdentity: null }
    const signerIdentity = await readMacSignature(appBundle, runCommand, true)
    return { verified: Boolean(signerIdentity), signerIdentity }
  }
  if (platform === 'win32') {
    const signerIdentity = await readWindowsSignature(executablePath, runCommand)
    return { verified: Boolean(signerIdentity), signerIdentity }
  }
  return { verified: false, signerIdentity: null }
}

export async function verifyDownloadedInstaller({
  platform,
  installerPath,
  expectedSignerIdentity,
  runCommand = defaultRunCommand,
}) {
  if (platform === 'darwin') {
    const signerIdentity = await readMacSignature(installerPath, runCommand, false)
    if (!signerIdentity || signerIdentity !== expectedSignerIdentity) return false
    return (await runCommand('spctl', [
      '--assess',
      '--type', 'open',
      '--context', 'context:primary-signature',
      '--verbose=4',
      installerPath,
    ], { timeoutMs: 30_000 })).ok
  }
  if (platform === 'win32') {
    return await readWindowsSignature(installerPath, runCommand) === expectedSignerIdentity
  }
  return false
}
