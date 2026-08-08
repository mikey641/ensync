---
name: Display preferences
description: Persistent readable typography and color-scheme behavior.
---

# Display preferences

Ensync supports light, dark, and system-following themes. The preference is cached locally so it resolves before the application paints, then included in account workspace v3 and updated live on every client signed into the same account. System mode still resolves against each computer's own operating-system scheme and reacts live when that local scheme changes.

Large text is the default: normal UI content uses 15px type and conversation content uses 18px. A persistent comfortable option uses 14px UI and 16px conversation content. Labels remain at least 13px; only purely illustrative marks may be smaller.

The unread task-finished indicator style is also account-portable and locally cached. Existing workspaces default to the compact green dot, while Settings can instead tint the unread tab or pane header green, or tint and outline the whole unread conversation pane. This changes only presentation: the indicator still represents the exact latest completed agent message and follows the existing chat-scoped read, working, failure, hidden-pane, and relaunch rules. Appearance storage is versioned at `ensync-display-preferences-v2` and migrates both earlier v1 keys so an older open renderer cannot strip the new completion field from the current record. Theme, text size, and indicator style use the account document's live compare-and-swap revision; a local change after the last synchronized settings snapshot wins the next merge, while an untouched client adopts the newer server value.

The task-finished sound preference remains physical-device-wide and is not account-synced because voices, playback availability, and acceptable alert behavior belong to that computer. Browser mode keeps mode, spoken text, and voice in `ensync-completion-notifications-v1`. The native shell additionally commits the same normalized values to a checksummed `device-preferences-v1.json` primary/staging/backup store under app data. Native startup restores that record before React mounts; when the native record does not exist yet, it migrates the current renderer value once. This preserves an explicit Off, ringtone, or spoken-text choice across renderer storage and origin resets without making alert settings workspace-specific.

Theme styles use shared semantic surface, border, text, accent, focus, overlay, shadow, and scrollbar tokens. New components must use these variables rather than theme-specific hex colors.

Conversation text is bidirectional by content rather than by application locale. User drafts, user and agent messages, stored-context previews, and CLI-visible output use HTML `dir="auto"`; multi-line output also uses `unicode-bidi: plaintext` so each Hebrew or English paragraph derives its own base direction while embedded Latin code, paths, commands, numbers, and punctuation retain Unicode bidi ordering. Fixed workspace chrome stays left-to-right, and bidi support must not rewrite stored or copied text with invisible control characters.

The desktop workspace and public product site share one visual language. The app maps the site's neutral paper/charcoal surfaces, teal status accent, Inter type stack, linked-loop Ensync mark, softly elevated cards, rounded pill controls, user-message bubbles, and circular send action through the semantic display tokens. Both light and dark themes keep this relationship; page-specific site layout must not replace desktop interaction state or accessibility behavior.
