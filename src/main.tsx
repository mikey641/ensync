import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DisplayPreferencesProvider } from './display-preferences'
import { UIVisibilityProvider } from './ui-visibility'
import { initializeNativeWorkspaceIdentity } from './lib/nativeWorkspaceIdentity.mjs'
import { initializeNativeWorkspaceRecovery } from './lib/nativeWorkspaceRecovery.mjs'
import { initializeNativeConversationImport } from './lib/nativeConversationImport.mjs'
import { initializeNativeRecentProjects } from './lib/nativeRecentProjects.mjs'
import { initializeCompletionNotificationPreferences } from './lib/completionNotificationPreferences.mjs'
import './index.css'
import './theme.css'

async function startRenderer() {
  const nativePlatform = window.ensyncDesktop?.nativePlatform
  if (nativePlatform) document.documentElement.dataset.nativePlatform = nativePlatform
  await initializeNativeWorkspaceIdentity(globalThis)
  await initializeNativeWorkspaceRecovery(globalThis)
  await initializeNativeConversationImport(globalThis)
  await initializeNativeRecentProjects(globalThis)
  await initializeCompletionNotificationPreferences(globalThis)
  const { default: App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <DisplayPreferencesProvider>
        <UIVisibilityProvider>
          <App />
        </UIVisibilityProvider>
      </DisplayPreferencesProvider>
    </StrictMode>,
  )
}

void startRenderer().catch((error) => {
  const root = document.getElementById('root')
  if (!root) return
  root.textContent = error instanceof Error
    ? error.message
    : 'Ensync could not verify this native workspace.'
})
