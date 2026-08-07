import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { GripVertical, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import './ResizableSidebar.css'

export const DEFAULT_RESIZABLE_SIDEBAR_STORAGE_KEY = 'ensync-conversations-sidebar-v1'
export const LEGACY_RESIZABLE_SIDEBAR_STORAGE_KEY = 'relay-conversations-sidebar-v1'

const DEFAULT_WIDTH = 280
const DEFAULT_MIN_WIDTH = 220
const DEFAULT_MAX_WIDTH = 520
const DEFAULT_KEYBOARD_STEP = 16

export type ResizableSidebarPreferences = {
  width: number
  visible: boolean
}

export type ResizableSidebarHandle = {
  hide: () => void
  show: () => void
  toggle: () => void
  setWidth: (width: number) => void
}

export type ResizableSidebarProps = {
  children: ReactNode
  /** Actions rendered beside the built-in hide button in the sidebar heading. */
  headerActions?: ReactNode
  title?: ReactNode
  ariaLabel?: string
  className?: string
  bodyClassName?: string
  storageKey?: string
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  keyboardStep?: number
  defaultVisible?: boolean
  /** Keep a narrow restore tab when hidden. Disable when a parent owns recovery UI. */
  showRestoreControl?: boolean
  /** Optional controlled visibility. Uncontrolled visibility persists automatically. */
  visible?: boolean
  /** Optional controlled width. Uncontrolled width persists automatically. */
  width?: number
  onVisibilityChange?: (visible: boolean) => void
  onWidthChange?: (width: number) => void
}

type DragState = {
  pointerId: number
  startX: number
  startWidth: number
}

type SidebarStyle = CSSProperties & {
  '--relay-sidebar-width': string
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function isStoredPreferences(value: unknown): value is Partial<ResizableSidebarPreferences> {
  if (!value || typeof value !== 'object') return false
  const stored = value as Partial<ResizableSidebarPreferences>
  const validWidth = stored.width === undefined
    || (typeof stored.width === 'number' && Number.isFinite(stored.width))
  const validVisibility = stored.visible === undefined || typeof stored.visible === 'boolean'
  return validWidth && validVisibility
}

export function readResizableSidebarPreferences(
  storageKey = DEFAULT_RESIZABLE_SIDEBAR_STORAGE_KEY,
  defaults: ResizableSidebarPreferences = { width: DEFAULT_WIDTH, visible: true },
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
): ResizableSidebarPreferences {
  if (typeof window === 'undefined') return defaults

  try {
    const rawValue = window.localStorage.getItem(storageKey)
      ?? (storageKey === DEFAULT_RESIZABLE_SIDEBAR_STORAGE_KEY
        ? window.localStorage.getItem(LEGACY_RESIZABLE_SIDEBAR_STORAGE_KEY)
        : null)
    if (!rawValue) return defaults
    const stored: unknown = JSON.parse(rawValue)
    if (!isStoredPreferences(stored)) return defaults

    return {
      width: clamp(stored.width ?? defaults.width, minWidth, maxWidth),
      visible: stored.visible ?? defaults.visible,
    }
  } catch {
    return defaults
  }
}

/**
 * A conversation sidebar with persistent visibility and width. Pointer resizing
 * and keyboard resizing share the same constrained state path.
 */
export const ResizableSidebar = forwardRef<ResizableSidebarHandle, ResizableSidebarProps>(
  function ResizableSidebar({
    children,
    headerActions,
    title = 'Conversations',
    ariaLabel = 'Conversations',
    className = '',
    bodyClassName = '',
    storageKey = DEFAULT_RESIZABLE_SIDEBAR_STORAGE_KEY,
    defaultWidth = DEFAULT_WIDTH,
    minWidth = DEFAULT_MIN_WIDTH,
    maxWidth = DEFAULT_MAX_WIDTH,
    keyboardStep = DEFAULT_KEYBOARD_STEP,
    defaultVisible = true,
    showRestoreControl = true,
    visible: controlledVisible,
    width: controlledWidth,
    onVisibilityChange,
    onWidthChange,
  }, forwardedRef) {
    const safeMinWidth = Math.max(1, Math.min(minWidth, maxWidth))
    const safeMaxWidth = Math.max(safeMinWidth, maxWidth)
    const defaults = useMemo<ResizableSidebarPreferences>(() => ({
      width: clamp(defaultWidth, safeMinWidth, safeMaxWidth),
      visible: defaultVisible,
    }), [defaultVisible, defaultWidth, safeMaxWidth, safeMinWidth])
    const [storedPreferences, setStoredPreferences] = useState<ResizableSidebarPreferences>(() =>
      readResizableSidebarPreferences(storageKey, defaults, safeMinWidth, safeMaxWidth),
    )
    const [dragState, setDragState] = useState<DragState | null>(null)
    const sidebarId = `relay-sidebar-${useId().replace(/:/g, '')}`
    const restoreButtonRef = useRef<HTMLButtonElement>(null)
    const hideButtonRef = useRef<HTMLButtonElement>(null)
    const focusAfterVisibilityChange = useRef<'hide' | 'show' | null>(null)

    const isVisible = controlledVisible ?? storedPreferences.visible
    const currentWidth = clamp(
      controlledWidth ?? storedPreferences.width,
      safeMinWidth,
      safeMaxWidth,
    )

    const updateVisibility = useCallback((nextVisible: boolean) => {
      if (controlledVisible === undefined) {
        setStoredPreferences((current) => ({ ...current, visible: nextVisible }))
      }
      onVisibilityChange?.(nextVisible)
    }, [controlledVisible, onVisibilityChange])

    const updateWidth = useCallback((nextWidth: number) => {
      const constrainedWidth = clamp(nextWidth, safeMinWidth, safeMaxWidth)
      if (controlledWidth === undefined) {
        setStoredPreferences((current) => ({ ...current, width: constrainedWidth }))
      }
      onWidthChange?.(constrainedWidth)
    }, [controlledWidth, onWidthChange, safeMaxWidth, safeMinWidth])

    const hide = useCallback(() => {
      focusAfterVisibilityChange.current = 'hide'
      updateVisibility(false)
    }, [updateVisibility])

    const show = useCallback(() => {
      focusAfterVisibilityChange.current = 'show'
      updateVisibility(true)
    }, [updateVisibility])

    const toggle = useCallback(() => {
      if (isVisible) hide()
      else show()
    }, [hide, isVisible, show])

    useImperativeHandle(forwardedRef, () => ({ hide, show, toggle, setWidth: updateWidth }), [
      hide,
      show,
      toggle,
      updateWidth,
    ])

    useEffect(() => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify({
          width: currentWidth,
          visible: isVisible,
        } satisfies ResizableSidebarPreferences))
      } catch {
        // Persistence is optional when browser storage is unavailable.
      }
    }, [currentWidth, isVisible, storageKey])

    useEffect(() => {
      const onStorage = (event: StorageEvent) => {
        if (
          event.key !== storageKey
          && (storageKey !== DEFAULT_RESIZABLE_SIDEBAR_STORAGE_KEY
            || event.key !== LEGACY_RESIZABLE_SIDEBAR_STORAGE_KEY
            || window.localStorage.getItem(storageKey))
        ) return
        const next = readResizableSidebarPreferences(
          storageKey,
          defaults,
          safeMinWidth,
          safeMaxWidth,
        )
        setStoredPreferences((current) => ({
          width: controlledWidth === undefined ? next.width : current.width,
          visible: controlledVisible === undefined ? next.visible : current.visible,
        }))
      }
      window.addEventListener('storage', onStorage)
      return () => window.removeEventListener('storage', onStorage)
    }, [controlledVisible, controlledWidth, defaults, safeMaxWidth, safeMinWidth, storageKey])

    useEffect(() => {
      if (focusAfterVisibilityChange.current === 'hide' && !isVisible) {
        restoreButtonRef.current?.focus()
        focusAfterVisibilityChange.current = null
      } else if (focusAfterVisibilityChange.current === 'show' && isVisible) {
        hideButtonRef.current?.focus()
        focusAfterVisibilityChange.current = null
      }
    }, [isVisible])

    useEffect(() => {
      if (!dragState) return undefined

      const onPointerMove = (event: PointerEvent) => {
        if (event.pointerId !== dragState.pointerId) return
        updateWidth(dragState.startWidth + event.clientX - dragState.startX)
      }
      const finishResize = (event: PointerEvent) => {
        if (event.pointerId === dragState.pointerId) setDragState(null)
      }

      document.documentElement.classList.add('relay-sidebar-is-resizing')
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', finishResize)
      window.addEventListener('pointercancel', finishResize)
      return () => {
        document.documentElement.classList.remove('relay-sidebar-is-resizing')
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', finishResize)
        window.removeEventListener('pointercancel', finishResize)
      }
    }, [dragState, updateWidth])

    const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      setDragState({
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: currentWidth,
      })
    }

    const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = Math.max(1, keyboardStep) * (event.shiftKey ? 4 : 1)
      let nextWidth: number | undefined

      if (event.key === 'ArrowLeft') nextWidth = currentWidth - step
      if (event.key === 'ArrowRight') nextWidth = currentWidth + step
      if (event.key === 'Home') nextWidth = safeMinWidth
      if (event.key === 'End') nextWidth = safeMaxWidth
      if (nextWidth === undefined) return

      event.preventDefault()
      updateWidth(nextWidth)
    }

    const style: SidebarStyle = {
      '--relay-sidebar-width': `${currentWidth}px`,
    }

    return (
      <div
        className={`relay-resizable-sidebar ${isVisible ? '' : 'relay-resizable-sidebar--hidden'} ${showRestoreControl ? '' : 'relay-resizable-sidebar--without-restore'} ${dragState ? 'relay-resizable-sidebar--resizing' : ''}`.trim()}
        style={style}
        data-visible={isVisible}
      >
        <aside
          id={sidebarId}
          className={`relay-resizable-sidebar__panel ${className}`.trim()}
          aria-label={ariaLabel}
          hidden={!isVisible}
        >
          <div className="relay-resizable-sidebar__heading">
            <span>{title}</span>
            <div className="relay-resizable-sidebar__heading-actions">
              {headerActions}
              <button
                ref={hideButtonRef}
                className="relay-resizable-sidebar__visibility-button"
                type="button"
                aria-controls={sidebarId}
                aria-expanded="true"
                aria-label={`Hide ${ariaLabel.toLowerCase()}`}
                title={`Hide ${ariaLabel.toLowerCase()}`}
                onClick={hide}
              >
                <PanelLeftClose size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className={`relay-resizable-sidebar__body ${bodyClassName}`.trim()}>{children}</div>
        </aside>
        {isVisible ? (
          <div
            className="relay-resizable-sidebar__separator"
            role="separator"
            tabIndex={0}
            aria-label={`Resize ${ariaLabel.toLowerCase()}`}
            aria-controls={sidebarId}
            aria-orientation="vertical"
            aria-valuemin={safeMinWidth}
            aria-valuemax={safeMaxWidth}
            aria-valuenow={Math.round(currentWidth)}
            aria-valuetext={`${Math.round(currentWidth)} pixels wide`}
            aria-keyshortcuts="ArrowLeft ArrowRight Home End"
            title="Drag to resize. Use arrow keys when focused."
            onPointerDown={startResize}
            onKeyDown={resizeWithKeyboard}
          >
            <GripVertical size={14} aria-hidden="true" />
          </div>
        ) : showRestoreControl ? (
          <button
            ref={restoreButtonRef}
            className="relay-resizable-sidebar__restore"
            type="button"
            aria-controls={sidebarId}
            aria-expanded="false"
            aria-label={`Show ${ariaLabel.toLowerCase()}`}
            title={`Show ${ariaLabel.toLowerCase()}`}
            onClick={show}
          >
            <PanelLeftOpen size={18} aria-hidden="true" />
            <span>{title}</span>
          </button>
        ) : null}
      </div>
    )
  },
)
