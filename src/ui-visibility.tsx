import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { readWorkspaceSnapshot } from './lib/workspacePersistence.mjs'
import { createWorkspaceSnapshotKeys } from './lib/workspacePersistence.mjs'
import {
  getNativeWorkspaceIdentity,
  isCanonicalWorkspace,
  workspaceStorageKey,
} from './lib/nativeWorkspaceIdentity.mjs'
import './ui-visibility.css'

export const UI_VISIBILITY_STORAGE_KEY = 'ensync-ui-visibility-v1'
export const LEGACY_UI_VISIBILITY_STORAGE_KEY = 'relay-ui-visibility-v1'
export const SHOW_ALL_UI_EVENT = 'ensync:show-all-ui'
export const LEGACY_SHOW_ALL_UI_EVENT = 'relay:show-all-ui'
export const SHOW_ALL_UI_SHORTCUT = 'Mod+Shift+U'
export const SHOW_ALL_UI_SHORTCUT_LABEL = '⌘/Ctrl ⇧ U'

export const UI_SECTION_IDS = [
  'activityRail',
  'titleBar',
  'tabStrip',
  'conversationSidebar',
  'conversationHeader',
  'composerStatus',
] as const

export type UISectionId = (typeof UI_SECTION_IDS)[number]
export type UIVisibilityState = Record<UISectionId, boolean>

export type UISectionDefinition = {
  id: UISectionId
  label: string
  description: string
}

export const UI_SECTIONS: readonly UISectionDefinition[] = [
  { id: 'activityRail', label: 'Activity rail', description: 'Primary navigation on the edge of the workspace' },
  { id: 'titleBar', label: 'Title bar', description: 'Project, host, usage, and search controls' },
  { id: 'tabStrip', label: 'Tab strip', description: 'Open conversation tabs and the new-tab button' },
  { id: 'conversationSidebar', label: 'Conversation sidebar', description: 'Searchable conversation history' },
  { id: 'conversationHeader', label: 'Conversation header', description: 'Conversation title, branch, and model picker' },
  { id: 'composerStatus', label: 'Composer and status', description: 'Prompt input, context status, and send controls' },
]

export const DEFAULT_UI_VISIBILITY: UIVisibilityState = {
  activityRail: true,
  titleBar: true,
  tabStrip: true,
  conversationSidebar: true,
  conversationHeader: true,
  composerStatus: true,
}

export type UISectionElementProps = Pick<HTMLAttributes<HTMLElement>, 'hidden' | 'aria-hidden'> & {
  'data-relay-ui-section': UISectionId
}

type UIVisibilityContextValue = {
  visibility: UIVisibilityState
  hiddenCount: number
  isVisible: (section: UISectionId) => boolean
  setVisible: (section: UISectionId, visible: boolean) => void
  toggleSection: (section: UISectionId) => void
  showAll: () => void
  getSectionProps: (section: UISectionId) => UISectionElementProps
}

const UIVisibilityContext = createContext<UIVisibilityContextValue | null>(null)

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/**
 * Merge a persisted value with current defaults. This intentionally ignores
 * unknown keys so future releases can safely add or remove workspace sections.
 */
export function normalizeUIVisibility(value: unknown): UIVisibilityState {
  const stored = value && typeof value === 'object' ? value as Partial<Record<UISectionId, unknown>> : {}
  return UI_SECTION_IDS.reduce<UIVisibilityState>((result, section) => {
    result[section] = isBoolean(stored[section]) ? stored[section] : DEFAULT_UI_VISIBILITY[section]
    return result
  }, { ...DEFAULT_UI_VISIBILITY })
}

export function readUIVisibility(storage?: Pick<Storage, 'getItem'>): UIVisibilityState {
  if (typeof window === 'undefined' && !storage) return { ...DEFAULT_UI_VISIBILITY }

  try {
    const source = storage ?? window.localStorage
    const identity = getNativeWorkspaceIdentity()
    const keys = createWorkspaceSnapshotKeys((key) => workspaceStorageKey(key, identity))
    const workspaceVisibility = readWorkspaceSnapshot<{ uiVisibility?: unknown }>(source, { keys })?.state.uiVisibility
    if (workspaceVisibility) return normalizeUIVisibility(workspaceVisibility)
    const scopedKey = workspaceStorageKey(UI_VISIBILITY_STORAGE_KEY, identity)
    const stored = source.getItem(scopedKey)
      ?? (isCanonicalWorkspace(identity) ? source.getItem(LEGACY_UI_VISIBILITY_STORAGE_KEY) : null)
    return stored ? normalizeUIVisibility(JSON.parse(stored)) : { ...DEFAULT_UI_VISIBILITY }
  } catch {
    return { ...DEFAULT_UI_VISIBILITY }
  }
}

/** Allows a desktop-shell menu or command palette to expose the same recovery action. */
export function requestShowAllUI() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SHOW_ALL_UI_EVENT))
}

function RecoveryAction({ hiddenCount, onShowAll }: { hiddenCount: number; onShowAll: () => void }) {
  if (hiddenCount === 0) return null

  return (
    <button
      className="ui-visibility-recovery"
      type="button"
      onClick={onShowAll}
      aria-label={`Show all interface sections. ${hiddenCount} ${hiddenCount === 1 ? 'section is' : 'sections are'} hidden.`}
      title={`Show all interface sections (${SHOW_ALL_UI_SHORTCUT_LABEL})`}
    >
      <span aria-hidden="true">◫</span>
      <strong>Show all</strong>
      <kbd>{SHOW_ALL_UI_SHORTCUT_LABEL}</kbd>
    </button>
  )
}

/**
 * Owns device-local chrome preferences and guarantees an always-reachable way
 * back after any part of the interface is hidden.
 */
export function UIVisibilityProvider({ children }: { children: ReactNode }) {
  const identity = getNativeWorkspaceIdentity()
  const scopedStorageKey = workspaceStorageKey(UI_VISIBILITY_STORAGE_KEY, identity)
  const [visibility, setVisibility] = useState<UIVisibilityState>(readUIVisibility)
  const [announcement, setAnnouncement] = useState('')

  const hiddenCount = useMemo(
    () => UI_SECTION_IDS.reduce((count, section) => count + (visibility[section] ? 0 : 1), 0),
    [visibility],
  )

  const isVisible = useCallback((section: UISectionId) => visibility[section], [visibility])

  const setVisible = useCallback((section: UISectionId, visible: boolean) => {
    setVisibility((current) => current[section] === visible ? current : { ...current, [section]: visible })
  }, [])

  const toggleSection = useCallback((section: UISectionId) => {
    setVisibility((current) => ({ ...current, [section]: !current[section] }))
  }, [])

  const showAll = useCallback(() => {
    setVisibility((current) => {
      if (UI_SECTION_IDS.every((section) => current[section])) return current
      return { ...DEFAULT_UI_VISIBILITY }
    })
    setAnnouncement('All interface sections are visible.')
  }, [])

  const getSectionProps = useCallback((section: UISectionId): UISectionElementProps => {
    const hidden = !visibility[section]
    return {
      hidden,
      'aria-hidden': hidden ? true : undefined,
      'data-relay-ui-section': section,
    }
  }, [visibility])

  useLayoutEffect(() => {
    try {
      window.localStorage.setItem(scopedStorageKey, JSON.stringify(visibility))
    } catch {
      // The controls remain usable for this session when storage is unavailable.
    }

    document.documentElement.dataset.relayHiddenUiCount = String(hiddenCount)
  }, [hiddenCount, scopedStorageKey, visibility])

  useEffect(() => {
    const onStorageChange = (event: StorageEvent) => {
      if (
        event.key !== scopedStorageKey
        && (!isCanonicalWorkspace(identity)
          || event.key !== LEGACY_UI_VISIBILITY_STORAGE_KEY
          || window.localStorage.getItem(scopedStorageKey))
      ) return
      setVisibility(event.newValue ? normalizeUIVisibility(safeParse(event.newValue)) : { ...DEFAULT_UI_VISIBILITY })
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'u') {
        event.preventDefault()
        showAll()
      }
    }

    window.addEventListener('storage', onStorageChange)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener(SHOW_ALL_UI_EVENT, showAll)
    window.addEventListener(LEGACY_SHOW_ALL_UI_EVENT, showAll)
    return () => {
      window.removeEventListener('storage', onStorageChange)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener(SHOW_ALL_UI_EVENT, showAll)
      window.removeEventListener(LEGACY_SHOW_ALL_UI_EVENT, showAll)
      delete document.documentElement.dataset.relayHiddenUiCount
    }
  }, [identity, scopedStorageKey, showAll])

  const value = useMemo<UIVisibilityContextValue>(() => ({
    visibility,
    hiddenCount,
    isVisible,
    setVisible,
    toggleSection,
    showAll,
    getSectionProps,
  }), [getSectionProps, hiddenCount, isVisible, setVisible, showAll, toggleSection, visibility])

  return (
    <UIVisibilityContext.Provider value={value}>
      {children}
      <RecoveryAction hiddenCount={hiddenCount} onShowAll={showAll} />
      <span className="ui-visibility-sr-status" role="status" aria-live="polite">{announcement}</span>
    </UIVisibilityContext.Provider>
  )
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

export function useUIVisibility() {
  const context = useContext(UIVisibilityContext)
  if (!context) throw new Error('useUIVisibility must be used inside UIVisibilityProvider')
  return context
}

/** Conditional boundary for sections whose local state can be safely unmounted. */
export function UIVisibilityBoundary({ section, children }: { section: UISectionId; children: ReactNode }) {
  const { isVisible } = useUIVisibility()
  return isVisible(section) ? children : null
}

/** Settings-panel controls. Every switch updates the real shared visibility store. */
export function UIVisibilityPreferences({ className = '' }: { className?: string }) {
  const { visibility, hiddenCount, setVisible, showAll } = useUIVisibility()

  return (
    <section className={`ui-visibility-preferences ${className}`.trim()} aria-labelledby="ui-visibility-title">
      <div className="ui-visibility-preferences__heading">
        <div>
          <h3 id="ui-visibility-title">Interface sections</h3>
          <p>Choose which workspace controls stay visible. Changes are saved on this device.</p>
        </div>
        <button type="button" onClick={showAll} disabled={hiddenCount === 0}>Show all</button>
      </div>

      <div className="ui-visibility-preferences__list" role="group" aria-label="Visible interface sections">
        {UI_SECTIONS.map((section) => (
          <button
            className="ui-visibility-preferences__switch"
            key={section.id}
            type="button"
            role="switch"
            aria-checked={visibility[section.id]}
            onClick={() => setVisible(section.id, !visibility[section.id])}
          >
            <span>
              <strong>{section.label}</strong>
              <small>{section.description}</small>
            </span>
            <i aria-hidden="true"><span /></i>
          </button>
        ))}
      </div>

      <p className="ui-visibility-preferences__recovery-note">
        The recovery button remains available whenever something is hidden. Keyboard: <kbd>{SHOW_ALL_UI_SHORTCUT_LABEL}</kbd>.
      </p>
    </section>
  )
}
