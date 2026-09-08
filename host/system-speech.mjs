import { execFile } from 'node:child_process'

const MAX_SPEECH_TEXT_LENGTH = 500
const SPEECH_TIMEOUT_MS = 30_000

const WINDOWS_SPEECH_SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$voice = $env:ENSYNC_SPEECH_VOICE',
  'if ($voice) { try { $speaker.SelectVoice($voice) } catch {} }',
  '$speaker.Speak($env:ENSYNC_SPEECH_TEXT)',
].join('; ')

function normalizeVoiceName(voiceId) {
  if (typeof voiceId !== 'string' || !voiceId) return null
  try {
    const parsed = JSON.parse(voiceId)
    if (!Array.isArray(parsed)) return null
    const name = typeof parsed[1] === 'string' ? parsed[1].trim() : ''
    return name && name.length <= 120 ? name : null
  } catch {
    return null
  }
}

function runExecutable(runFile, executable, args, options) {
  return new Promise((resolve) => {
    try {
      runFile(executable, args, options, (error) => resolve(error ?? null))
    } catch (error) {
      resolve(error)
    }
  })
}

export class SystemSpeechService {
  constructor({ platform = process.platform, runFile = execFile } = {}) {
    this.platform = platform
    this.runFile = runFile
  }

  async speak({ text, voiceId = null } = {}) {
    const message = typeof text === 'string' ? text.trim() : ''
    if (!message) {
      return { status: 'empty', message: 'Enter the words Ensync should speak.' }
    }
    if (message.length > MAX_SPEECH_TEXT_LENGTH) {
      return { status: 'blocked', message: `Spoken notifications are limited to ${MAX_SPEECH_TEXT_LENGTH} characters.` }
    }

    const voiceName = normalizeVoiceName(voiceId)
    let executable
    let args
    let options = { timeout: SPEECH_TIMEOUT_MS, windowsHide: true }
    if (this.platform === 'darwin') {
      executable = '/usr/bin/say'
      args = voiceName ? ['-v', voiceName, message] : [message]
    } else if (this.platform === 'win32') {
      executable = 'powershell.exe'
      args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WINDOWS_SPEECH_SCRIPT]
      options = {
        ...options,
        env: {
          ...process.env,
          ENSYNC_SPEECH_TEXT: message,
          ENSYNC_SPEECH_VOICE: voiceName ?? '',
        },
      }
    } else {
      return { status: 'unsupported', message: 'Native spoken notifications are not supported on this operating system.' }
    }

    const error = await runExecutable(this.runFile, executable, args, options)
    if (error) {
      return { status: 'blocked', message: 'The operating system could not play the spoken notification.' }
    }
    return {
      status: 'played',
      message: voiceName ? `Spoken with ${voiceName}.` : 'Spoken with the system voice.',
    }
  }
}
