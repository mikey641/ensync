---
name: Display preferences
description: Persistent readable typography and color-scheme behavior.
---

# Display preferences

Ensync supports light, dark, and system-following themes. The preference is stored locally, resolved before the application paints, and updated live when the operating-system scheme changes while system mode is selected.

Large text is the default: normal UI content uses 15px type and conversation content uses 18px. A persistent comfortable option uses 14px UI and 16px conversation content. Labels remain at least 13px; only purely illustrative marks may be smaller.

The unread task-finished indicator is also device-local and persistent. Existing workspaces default to the compact green dot, while Settings can instead tint the unread tab or pane header green, or tint and outline the whole unread conversation pane. This changes only presentation: the indicator still represents the exact latest completed agent message and follows the existing chat-scoped read, working, failure, hidden-pane, and relaunch rules. Appearance storage is versioned at `ensync-display-preferences-v2` and migrates both earlier v1 keys so an older open renderer cannot strip the new completion field from the current record.

Theme styles use shared semantic surface, border, text, accent, focus, overlay, shadow, and scrollbar tokens. New components must use these variables rather than theme-specific hex colors.

Conversation text is bidirectional by content rather than by application locale. User drafts, user and agent messages, stored-context previews, and CLI-visible output use HTML `dir="auto"`; multi-line output also uses `unicode-bidi: plaintext` so each Hebrew or English paragraph derives its own base direction while embedded Latin code, paths, commands, numbers, and punctuation retain Unicode bidi ordering. Fixed workspace chrome stays left-to-right, and bidi support must not rewrite stored or copied text with invisible control characters.

The desktop workspace and public product site share one visual language. It takes a balanced contemporary direction between sparse assistant UI and editorial AI branding: clean sans-serif typography, neutral stone and graphite surfaces, the linked-loop Ensync mark, softly elevated cards, restrained rounding, user-message bubbles, and a circular send action. Green is a selective signature accent for the brand mark, primary actions, focus, and active indicators rather than a tint across the whole interface; warnings, provider identities, project colors, and completion state retain their independent semantics. Both light and dark themes keep this relationship; page-specific site layout must not replace desktop interaction state or accessibility behavior.

The Ensync green must be unmistakably green at normal 100% viewing size, not a gray-green or teal that is visible only when sampled. Dark mode uses a vivid organic green near `#45d483` with a lighter strong state; light mode uses a contrast-safe forest green near `#178449` with a darker strong state. The linked-loop mark and an always-visible active-pane edge or header marker provide persistent brand anchors. Ready primary actions, selected controls, enabled toggles, focus rings, and live/status dots use the same accent hierarchy. Soft accent backgrounds may support those elements, but pane bodies, title bars, activity rails, sidebars, and the general canvas remain neutral graphite or stone. A whole-pane green wash is never part of the brand theme; any existing unread-completion treatment remains a separate user-selected state style.

Visual-theme work is strictly palette-only unless the user separately requests more. It may adjust semantic foreground, background, border, focus, and accent colors, but it must preserve typography, spacing, border widths, radii, shadows, decorative geometry, component hierarchy, pane geometry, the window-inside-window presentation, responsive layout, controls, and behavior.
