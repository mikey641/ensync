import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export const DISPLAY_PREFERENCES_STORAGE_KEY = 'ensync-display-preferences-v2'
export const LEGACY_DISPLAY_PREFERENCES_STORAGE_KEY = 'ensync-display-preferences-v1'
export const LEGACY_RELAY_DISPLAY_PREFERENCES_STORAGE_KEY = 'relay-display-preferences-v1'

export type ThemePreference = 'system' | 'light' | 'dark'
export type TextSizePreference = 'comfortable' | 'large'
export type CompletionIndicatorPreference = 'dot' | 'header' | 'tab'
export type ResolvedTheme = 'light' | 'dark'

export type DisplayPreferencesState = {
  theme: ThemePreference
  textSize: TextSizePreference
  completionIndicator: CompletionIndicatorPreference
}

type DisplayPreferencesContextValue = DisplayPreferencesState & {
  resolvedTheme: ResolvedTheme
  setTheme: (theme: ThemePreference) => void
  setTextSize: (textSize: TextSizePreference) => void
  setCompletionIndicator: (completionIndicator: CompletionIndicatorPreference) => void
}

const DEFAULT_PREFERENCES: DisplayPreferencesState = {
  theme: 'system',
  textSize: 'large',
  completionIndicator: 'dot',
}

const DisplayPreferencesContext = createContext<DisplayPreferencesContextValue | null>(null)

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

function isTextSizePreference(value: unknown): value is TextSizePreference {
  return value === 'comfortable' || value === 'large'
}

function isCompletionIndicatorPreference(value: unknown): value is CompletionIndicatorPreference {
  return value === 'dot' || value === 'header' || value === 'tab'
}

export function readDisplayPreferences(): DisplayPreferencesState {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES

  try {
    const stored = JSON.parse(
      window.localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY)
        ?? window.localStorage.getItem(LEGACY_DISPLAY_PREFERENCES_STORAGE_KEY)
        ?? window.localStorage.getItem(LEGACY_RELAY_DISPLAY_PREFERENCES_STORAGE_KEY)
        ?? '{}',
    ) as Partial<DisplayPreferencesState>
    return {
      theme: isThemePreference(stored.theme) ? stored.theme : DEFAULT_PREFERENCES.theme,
      textSize: isTextSizePreference(stored.textSize) ? stored.textSize : DEFAULT_PREFERENCES.textSize,
      completionIndicator: isCompletionIndicatorPreference(stored.completionIndicator)
        ? stored.completionIndicator
        : DEFAULT_PREFERENCES.completionIndicator,
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function applyDisplayPreferences(preferences: DisplayPreferencesState, systemTheme = getSystemTheme()): ResolvedTheme {
  const resolvedTheme = preferences.theme === 'system' ? systemTheme : preferences.theme

  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme
    root.dataset.themePreference = preferences.theme
    root.dataset.textSize = preferences.textSize
    root.dataset.completionIndicator = preferences.completionIndicator
    root.style.colorScheme = resolvedTheme

    const themeColor = resolvedTheme === 'light' ? '#f7f7f5' : '#212121'
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', themeColor)
  }

  return resolvedTheme
}

export function DisplayPreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<DisplayPreferencesState>(readDisplayPreferences)
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)
  const resolvedTheme = preferences.theme === 'system' ? systemTheme : preferences.theme

  useLayoutEffect(() => {
    const appliedTheme = applyDisplayPreferences(preferences, systemTheme)
    void window.ensyncDesktop?.setTitleBarAppearance?.(appliedTheme).catch(() => {})
    window.localStorage.setItem(DISPLAY_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  }, [preferences, systemTheme])

  useEffect(() => {
    const colorScheme = window.matchMedia('(prefers-color-scheme: light)')
    const onColorSchemeChange = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? 'light' : 'dark')
    const onStorageChange = (event: StorageEvent) => {
      if (
        event.key === DISPLAY_PREFERENCES_STORAGE_KEY
        || ((event.key === LEGACY_DISPLAY_PREFERENCES_STORAGE_KEY
          || event.key === LEGACY_RELAY_DISPLAY_PREFERENCES_STORAGE_KEY)
          && !window.localStorage.getItem(DISPLAY_PREFERENCES_STORAGE_KEY))
      ) setPreferences(readDisplayPreferences())
    }

    colorScheme.addEventListener('change', onColorSchemeChange)
    window.addEventListener('storage', onStorageChange)
    return () => {
      colorScheme.removeEventListener('change', onColorSchemeChange)
      window.removeEventListener('storage', onStorageChange)
    }
  }, [])

  const setTheme = useCallback((theme: ThemePreference) => {
    setPreferences((current) => ({ ...current, theme }))
  }, [])

  const setTextSize = useCallback((textSize: TextSizePreference) => {
    setPreferences((current) => ({ ...current, textSize }))
  }, [])

  const setCompletionIndicator = useCallback((completionIndicator: CompletionIndicatorPreference) => {
    setPreferences((current) => ({ ...current, completionIndicator }))
  }, [])

  const value = useMemo<DisplayPreferencesContextValue>(() => ({
    ...preferences,
    resolvedTheme,
    setTheme,
    setTextSize,
    setCompletionIndicator,
  }), [preferences, resolvedTheme, setCompletionIndicator, setTextSize, setTheme])

  return <DisplayPreferencesContext.Provider value={value}>{children}</DisplayPreferencesContext.Provider>
}

export function useDisplayPreferences() {
  const context = useContext(DisplayPreferencesContext)
  if (!context) throw new Error('useDisplayPreferences must be used inside DisplayPreferencesProvider')
  return context
}

const themeOptions: Array<{ value: ThemePreference; label: string; description: string }> = [
  { value: 'system', label: 'System', description: 'Follow this computer' },
  { value: 'light', label: 'Light', description: 'Bright and high contrast' },
  { value: 'dark', label: 'Dark', description: 'Dimmer for low light' },
]

const textSizeOptions: Array<{ value: TextSizePreference; label: string; description: string }> = [
  { value: 'comfortable', label: 'Comfortable', description: '14–16 px content' },
  { value: 'large', label: 'Large', description: '15–18 px content' },
]

const completionIndicatorOptions: Array<{
  value: CompletionIndicatorPreference
  label: string
  description: string
}> = [
  { value: 'dot', label: 'Small dot', description: 'Compact marker beside the title' },
  { value: 'header', label: 'Green header', description: 'Tint the finished tab header' },
  { value: 'tab', label: 'Whole tab', description: 'Tint and outline the full conversation' },
]

export function DisplayPreferences({ className = '' }: { className?: string }) {
  const {
    theme,
    textSize,
    completionIndicator,
    resolvedTheme,
    setTheme,
    setTextSize,
    setCompletionIndicator,
  } = useDisplayPreferences()

  return (
    <section className={`display-preferences ${className}`.trim()} aria-labelledby="display-preferences-title">
      <div className="display-preferences__heading">
        <div>
          <h3 id="display-preferences-title">Appearance</h3>
          <p>Theme and text size are saved on this device.</p>
        </div>
        <span className="display-preferences__status">{resolvedTheme} active</span>
      </div>

      <fieldset className="display-preferences__group">
        <legend>Theme</legend>
        <div className="display-preferences__options display-preferences__options--themes">
          {themeOptions.map((option) => (
            <button
              className={theme === option.value ? 'selected' : ''}
              key={option.value}
              type="button"
              aria-pressed={theme === option.value}
              onClick={() => setTheme(option.value)}
            >
              <span className={`theme-preview theme-preview--${option.value}`} aria-hidden="true"><i /><i /></span>
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="display-preferences__group">
        <legend>Text size</legend>
        <div className="display-preferences__options display-preferences__options--text">
          {textSizeOptions.map((option) => (
            <button
              className={textSize === option.value ? 'selected' : ''}
              key={option.value}
              type="button"
              aria-pressed={textSize === option.value}
              onClick={() => setTextSize(option.value)}
            >
              <span className="text-size-preview" data-size={option.value} aria-hidden="true">Aa</span>
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="display-preferences__group">
        <legend>Task finished indicator</legend>
        <div
          className="display-preferences__options display-preferences__options--completion"
          role="radiogroup"
          aria-label="Task finished indicator"
        >
          {completionIndicatorOptions.map((option) => (
            <button
              className={completionIndicator === option.value ? 'selected' : ''}
              key={option.value}
              type="button"
              role="radio"
              aria-checked={completionIndicator === option.value}
              onClick={() => setCompletionIndicator(option.value)}
            >
              <span className="completion-indicator-preview" data-style={option.value} aria-hidden="true">
                <i className="completion-indicator-preview__header"><span /></i>
                <i className="completion-indicator-preview__body" />
              </span>
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
            </button>
          ))}
        </div>
      </fieldset>
    </section>
  )
}
