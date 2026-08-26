import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ANSWER_NEEDED_ALERT,
  COMPLETION_NOTIFICATIONS_STORAGE_KEY,
  DEFAULT_COMPLETION_NOTIFICATION_SETTINGS,
  TASK_FINISHED_ALERT,
  completionAlertPlan,
  normalizeCompletionNotificationSettings,
  readCompletionNotificationSettings,
  saveCompletionNotificationPreferences,
  writeCompletionNotificationSettings,
} from './lib/completionNotificationPreferences.mjs'
import type {
  CompletionAlertTrigger,
  CompletionNotificationMode,
  CompletionNotificationSettings,
} from './lib/completionNotificationPreferences.mjs'
import './completion-notifications.css'

const COMPLETION_NOTIFICATIONS_CHANGE_EVENT = 'ensync:completion-notifications-change'

export {
  ANSWER_NEEDED_ALERT,
  COMPLETION_NOTIFICATIONS_STORAGE_KEY,
  DEFAULT_COMPLETION_NOTIFICATION_SETTINGS,
  TASK_FINISHED_ALERT,
  completionAlertPlan,
  normalizeCompletionNotificationSettings,
  readCompletionNotificationSettings,
  writeCompletionNotificationSettings,
}
export type { CompletionAlertTrigger, CompletionNotificationMode, CompletionNotificationSettings }

export type CompletionVoice = {
  id: string
  name: string
  language: string
  isDefault: boolean
  isLocal: boolean
}

export type CompletionNotificationResult = {
  mode: CompletionNotificationMode
  status: 'disabled' | 'played' | 'queued' | 'unsupported' | 'blocked' | 'empty' | 'voice-unavailable'
  message: string
}

type AudioContextWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext
}

let preparedAudioContext: AudioContext | null = null

function voiceId(voice: SpeechSynthesisVoice) {
  return JSON.stringify([voice.voiceURI, voice.name, voice.lang])
}

function serializeVoice(voice: SpeechSynthesisVoice): CompletionVoice {
  return {
    id: voiceId(voice),
    name: voice.name,
    language: voice.lang,
    isDefault: voice.default,
    isLocal: voice.localService,
  }
}

function readBrowserVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return []
  try {
    return window.speechSynthesis.getVoices()
  } catch {
    return []
  }
}

export function getAvailableCompletionVoices(): CompletionVoice[] {
  return readBrowserVoices().map(serializeVoice)
}

export function getCompletionNotificationCapabilities() {
  if (typeof window === 'undefined') return { ringtone: false, speech: false }
  const audioWindow = window as AudioContextWindow
  return {
    ringtone: Boolean(audioWindow.AudioContext || audioWindow.webkitAudioContext),
    speech: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
  }
}

function getOrCreateAudioContext() {
  if (preparedAudioContext?.state === 'closed') preparedAudioContext = null
  if (preparedAudioContext) return preparedAudioContext
  if (typeof window === 'undefined') return null

  const audioWindow = window as AudioContextWindow
  const AudioContextConstructor = audioWindow.AudioContext || audioWindow.webkitAudioContext
  if (!AudioContextConstructor) return null
  preparedAudioContext = new AudioContextConstructor()
  return preparedAudioContext
}

function isAudioContextRunning(context: AudioContext) {
  return context.state === 'running'
}

async function resumeAudioContext(context: AudioContext, timeoutMs = 900) {
  if (isAudioContextRunning(context)) return true
  try {
    await Promise.race([
      context.resume(),
      new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
    ])
  } catch {
    return false
  }
  return isAudioContextRunning(context)
}

/**
 * Call this directly from the user's Send click/key handler. Constructing and
 * resuming the context while the browser still has a user gesture prevents the
 * later completion chime from being rejected by autoplay policy.
 */
export function primeCompletionNotifications(): Promise<boolean> {
  try {
    const context = getOrCreateAudioContext()
    if (!context) return Promise.resolve(false)
    return resumeAudioContext(context)
  } catch {
    return Promise.resolve(false)
  }
}

/**
 * The two chimes are deliberately different figures, not the same notes at a
 * different pitch: a finished run resolves upwards and stops, a waiting
 * question asks the same rising pair twice and never resolves. Hearing one
 * from another room has to be enough to know whether anything is blocked.
 */
const CHIMES: Record<CompletionAlertTrigger, { notes: { frequency: number, at: number }[], end: number }> = {
  [TASK_FINISHED_ALERT]: {
    notes: [659.25, 783.99, 1046.5].map((frequency, index) => ({ frequency, at: index * 0.1 })),
    end: 0.52,
  },
  [ANSWER_NEEDED_ALERT]: {
    notes: [
      { frequency: 587.33, at: 0 },
      { frequency: 880, at: 0.1 },
      { frequency: 587.33, at: 0.28 },
      { frequency: 880, at: 0.38 },
    ],
    end: 0.7,
  },
}

async function playChime(trigger: CompletionAlertTrigger): Promise<CompletionNotificationResult> {
  const mode = 'ringtone' as const
  const chime = CHIMES[trigger]
  if (typeof window === 'undefined') {
    return { mode, status: 'unsupported', message: 'Ringtone playback is not available here.' }
  }

  if (!getCompletionNotificationCapabilities().ringtone) {
    return { mode, status: 'unsupported', message: 'This browser does not support ringtone playback.' }
  }

  try {
    const context = getOrCreateAudioContext()
    if (!context) {
      return { mode, status: 'unsupported', message: 'This browser does not support ringtone playback.' }
    }
    if (!await resumeAudioContext(context)) {
      return {
        mode,
        status: 'blocked',
        message: 'Ringtone playback was blocked. Interact with Ensync once, then try Preview again.',
      }
    }

    const start = context.currentTime
    const master = context.createGain()
    master.gain.setValueAtTime(0.0001, start)
    master.gain.exponentialRampToValueAtTime(0.16, start + 0.018)
    master.gain.setValueAtTime(0.16, start + chime.end - 0.27)
    master.gain.exponentialRampToValueAtTime(0.0001, start + chime.end)
    master.connect(context.destination)

    chime.notes.forEach(({ frequency, at }) => {
      const oscillator = context?.createOscillator()
      const gain = context?.createGain()
      if (!context || !oscillator || !gain) return
      const noteStart = start + at
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, noteStart)
      gain.gain.setValueAtTime(0.0001, noteStart)
      gain.gain.exponentialRampToValueAtTime(0.7, noteStart + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.22)
      oscillator.connect(gain)
      gain.connect(master)
      oscillator.start(noteStart)
      oscillator.stop(noteStart + 0.23)
    })

    await new Promise<void>((resolve) => window.setTimeout(resolve, Math.round(chime.end * 1000) + 40))
    return { mode, status: 'played', message: 'Ringtone played.' }
  } catch {
    return {
      mode,
      status: 'blocked',
      message: 'Ringtone playback was blocked. Interact with Ensync once, then try Preview again.',
    }
  }
}

export function playCompletionRingtone(): Promise<CompletionNotificationResult> {
  return playChime(TASK_FINISHED_ALERT)
}

export function playAnswerNeededRingtone(): Promise<CompletionNotificationResult> {
  return playChime(ANSWER_NEEDED_ALERT)
}

export function speakCompletionText(
  text: string,
  selectedVoiceId: string | null,
): CompletionNotificationResult {
  const mode = 'speech' as const
  if (
    typeof window === 'undefined'
    || !('speechSynthesis' in window)
    || !('SpeechSynthesisUtterance' in window)
  ) {
    return { mode, status: 'unsupported', message: 'Spoken notifications are not supported here.' }
  }

  const message = text.trim()
  if (!message) return { mode, status: 'empty', message: 'Enter the words Ensync should speak.' }

  const voices = readBrowserVoices()
  const selectedVoice = selectedVoiceId
    ? voices.find((voice) => voiceId(voice) === selectedVoiceId)
    : voices.find((voice) => voice.default) ?? voices[0]
  if (!selectedVoice) {
    return { mode, status: 'voice-unavailable', message: 'No browser or system voice is currently available.' }
  }

  try {
    const utterance = new SpeechSynthesisUtterance(message)
    utterance.voice = selectedVoice
    utterance.lang = selectedVoice.lang
    window.speechSynthesis.speak(utterance)
    return { mode, status: 'queued', message: `Speaking with ${selectedVoice.name} (${selectedVoice.lang}).` }
  } catch {
    return { mode, status: 'blocked', message: 'The browser could not start spoken playback.' }
  }
}

export function stopCompletionSpeech() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false
  try {
    window.speechSynthesis.cancel()
    return true
  } catch {
    return false
  }
}

type UpdateCompletionNotificationSettings = (
  update: Partial<CompletionNotificationSettings>
    | ((current: CompletionNotificationSettings) => CompletionNotificationSettings),
) => void

export function useCompletionNotifications() {
  const [settings, setSettings] = useState<CompletionNotificationSettings>(readCompletionNotificationSettings)
  const settingsRef = useRef(settings)
  const [voices, setVoices] = useState<CompletionVoice[]>(getAvailableCompletionVoices)
  const capabilities = useMemo(() => getCompletionNotificationCapabilities(), [])

  useEffect(() => {
    const refreshVoices = () => setVoices(getAvailableCompletionVoices())
    const onSettingsChange = (event: Event) => {
      const detail = (event as CustomEvent<CompletionNotificationSettings>).detail
      const next = detail ? normalizeCompletionNotificationSettings(detail) : readCompletionNotificationSettings()
      if (next.mode !== 'speech') stopCompletionSpeech()
      settingsRef.current = next
      setSettings(next)
    }
    const onStorageChange = (event: StorageEvent) => {
      if (event.key === COMPLETION_NOTIFICATIONS_STORAGE_KEY) {
        const next = event.newValue
          ? normalizeCompletionNotificationSettings(safeJsonParse(event.newValue))
          : { ...DEFAULT_COMPLETION_NOTIFICATION_SETTINGS }
        if (next.mode !== 'speech') stopCompletionSpeech()
        settingsRef.current = next
        setSettings(next)
      }
    }

    refreshVoices()
    if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', refreshVoices)
    window.addEventListener(COMPLETION_NOTIFICATIONS_CHANGE_EVENT, onSettingsChange)
    window.addEventListener('storage', onStorageChange)
    return () => {
      if ('speechSynthesis' in window) window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices)
      window.removeEventListener(COMPLETION_NOTIFICATIONS_CHANGE_EVENT, onSettingsChange)
      window.removeEventListener('storage', onStorageChange)
    }
  }, [])

  const updateSettings = useCallback<UpdateCompletionNotificationSettings>((update) => {
    const current = settingsRef.current
    const candidate = typeof update === 'function' ? update(current) : { ...current, ...update }
    const next = saveCompletionNotificationPreferences(candidate)
    if (next.mode !== 'speech') stopCompletionSpeech()
    settingsRef.current = next
    setSettings(next)
    window.dispatchEvent(new CustomEvent(COMPLETION_NOTIFICATIONS_CHANGE_EVENT, { detail: next }))
  }, [])

  const notify = useCallback(async (
    trigger: CompletionAlertTrigger,
    speechTextOverride?: string,
  ) => {
    const plan = completionAlertPlan(settings, trigger)
    if (plan.mode === 'ringtone') {
      return plan.chime === ANSWER_NEEDED_ALERT ? playAnswerNeededRingtone() : playCompletionRingtone()
    }
    if (plan.mode === 'speech') return speakCompletionText(speechTextOverride ?? plan.speechText, plan.voiceId)
    return {
      mode: 'off',
      status: 'disabled',
      message: trigger === ANSWER_NEEDED_ALERT
        ? 'Question alerts are off.'
        : 'Completion notifications are off.',
    } satisfies CompletionNotificationResult
  }, [settings])

  const notifyCompletion = useCallback(
    (speechTextOverride?: string) => notify(TASK_FINISHED_ALERT, speechTextOverride),
    [notify],
  )

  /** A run that stopped to ask something cannot go on until the person answers. */
  const notifyAnswerNeeded = useCallback(() => notify(ANSWER_NEEDED_ALERT), [notify])

  return {
    settings,
    voices,
    capabilities,
    updateSettings,
    setMode: (mode: CompletionNotificationMode) => updateSettings({ mode }),
    setSpeechText: (speechText: string) => updateSettings({ speechText }),
    setVoiceId: (selectedVoiceId: string | null) => updateSettings({ voiceId: selectedVoiceId }),
    prime: primeCompletionNotifications,
    notifyCompletion,
    notifyAnswerNeeded,
  }
}

export function useNotifyWhenFinished(
  isWorking: boolean,
  options: {
    completionId?: string | number
    speechText?: string
    enabled?: boolean
    succeeded?: boolean
  } = {},
) {
  const { notifyCompletion } = useCompletionNotifications()
  const previous = useRef({ hydrated: false, id: options.completionId, isWorking })

  useEffect(() => {
    const last = previous.current
    const sameWorkItem = last.id === options.completionId

    if (
      last.hydrated
      && sameWorkItem
      && last.isWorking
      && !isWorking
      && options.enabled !== false
      && options.succeeded === true
    ) {
      void notifyCompletion(options.speechText)
    }

    previous.current = { hydrated: true, id: options.completionId, isWorking }
  }, [
    isWorking,
    notifyCompletion,
    options.completionId,
    options.enabled,
    options.speechText,
    options.succeeded,
  ])
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function formatLanguage(language: string) {
  try {
    return new Intl.DisplayNames(undefined, { type: 'language' }).of(language) ?? language
  } catch {
    return language
  }
}

type CompletionNotificationPreferencesProps = {
  className?: string
}

export function CompletionNotificationPreferences({ className = '' }: CompletionNotificationPreferencesProps) {
  const {
    settings,
    voices,
    capabilities,
    updateSettings,
    notifyCompletion,
    notifyAnswerNeeded,
  } = useCompletionNotifications()
  const [previewStatus, setPreviewStatus] = useState('')

  const selectedVoiceExists = voices.some((voice) => voice.id === settings.voiceId)
  const preferredVoice = voices.find((voice) => voice.isDefault) ?? voices[0]

  useEffect(() => {
    if (settings.mode !== 'speech' || selectedVoiceExists || !preferredVoice) return
    updateSettings({ voiceId: preferredVoice.id })
  }, [preferredVoice, selectedVoiceExists, settings.mode, updateSettings])

  const selectMode = (mode: CompletionNotificationMode) => {
    if (mode === 'speech' && !selectedVoiceExists && preferredVoice) {
      updateSettings({ mode, voiceId: preferredVoice.id })
    } else {
      updateSettings({ mode })
    }
    setPreviewStatus('')
  }

  const preview = async (trigger: CompletionAlertTrigger) => {
    setPreviewStatus('Playing preview…')
    const result = trigger === ANSWER_NEEDED_ALERT ? await notifyAnswerNeeded() : await notifyCompletion()
    setPreviewStatus(result.message)
  }

  return (
    <section className={`completion-notification-preferences ${className}`.trim()} aria-labelledby="completion-notification-title">
      <div className="completion-notification-preferences__heading">
        <div>
          <h3 id="completion-notification-title">Agent alerts</h3>
          <p>Play a local alert when an agent finishes, or needs an answer. Saved on this device.</p>
        </div>
        <span>{settings.mode === 'off' ? 'Off' : 'On'}</span>
      </div>

      <div className="completion-notification-preferences__modes" role="radiogroup" aria-label="Agent alert type">
        <ModeButton mode="off" label="Off" currentMode={settings.mode} onSelect={selectMode} />
        <ModeButton
          mode="ringtone"
          label="Ringtone"
          currentMode={settings.mode}
          onSelect={selectMode}
          disabled={!capabilities.ringtone}
        />
        <ModeButton
          mode="speech"
          label="Spoken text"
          currentMode={settings.mode}
          onSelect={selectMode}
          disabled={!capabilities.speech}
        />
      </div>

      {settings.mode === 'ringtone' && (
        <p className="completion-notification-preferences__note">
          Ensync will play a short three-note chime on this device, and a different, unresolved
          two-note chime when an agent is waiting on you.
        </p>
      )}

      {settings.mode !== 'off' && (
        <label className="completion-notification-preferences__toggle">
          <input
            type="checkbox"
            checked={settings.answerAlerts}
            onChange={(event) => updateSettings({ answerAlerts: event.target.checked })}
          />
          <span>
            Alert when an agent needs an answer
            <small>
              A question or a permission request stops the run in that conversation until you
              answer it, including one you are not looking at.
            </small>
          </span>
        </label>
      )}

      {settings.mode === 'speech' && (
        <div className="completion-notification-preferences__speech">
          <label>
            Words to speak
            <textarea
              value={settings.speechText}
              maxLength={240}
              rows={3}
              onChange={(event) => updateSettings({ speechText: event.target.value })}
              placeholder="Your Ensync task is finished."
            />
          </label>

          {settings.answerAlerts && (
            <label>
              Words to speak when an agent needs an answer
              <textarea
                value={settings.answerSpeechText}
                maxLength={240}
                rows={2}
                onChange={(event) => updateSettings({ answerSpeechText: event.target.value })}
                placeholder="Your Ensync task needs an answer."
              />
            </label>
          )}

          <label>
            System voice and accent
            <select
              value={selectedVoiceExists ? settings.voiceId ?? '' : ''}
              disabled={voices.length === 0}
              onChange={(event) => updateSettings({ voiceId: event.target.value || null })}
            >
              {voices.length === 0 && <option value="">No system voices available</option>}
              {voices.map((voice) => (
                <option value={voice.id} key={voice.id}>
                  {voice.name} — {formatLanguage(voice.language)} ({voice.language}){voice.isDefault ? ' · Default' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="completion-notification-preferences__note">
            {voices.length > 0
              ? `${voices.length} ${voices.length === 1 ? 'voice' : 'voices'} reported by this browser and operating system.`
              : 'No voices have been reported by this browser or operating system yet.'}
          </p>
        </div>
      )}

      <div className="completion-notification-preferences__footer">
        <button
          type="button"
          onClick={() => void preview(TASK_FINISHED_ALERT)}
          disabled={
            settings.mode === 'off'
            || (settings.mode === 'speech' && (!settings.speechText.trim() || !selectedVoiceExists))
          }
        >
          Preview finished
        </button>
        <button
          type="button"
          onClick={() => void preview(ANSWER_NEEDED_ALERT)}
          disabled={
            settings.mode === 'off'
            || !settings.answerAlerts
            || (settings.mode === 'speech' && (!settings.answerSpeechText.trim() || !selectedVoiceExists))
          }
        >
          Preview needs answer
        </button>
        <span role="status" aria-live="polite">{previewStatus}</span>
      </div>
    </section>
  )
}

function ModeButton({
  mode,
  label,
  currentMode,
  onSelect,
  disabled = false,
}: {
  mode: CompletionNotificationMode
  label: string
  currentMode: CompletionNotificationMode
  onSelect: (mode: CompletionNotificationMode) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={currentMode === mode}
      className={currentMode === mode ? 'selected' : ''}
      disabled={disabled}
      onClick={() => onSelect(mode)}
    >
      {label}
    </button>
  )
}
