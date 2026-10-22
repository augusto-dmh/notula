// SPDX-License-Identifier: Apache-2.0
// The main window's root. Secondary windows
// never load it: main.tsx picks their lazy roots by hash.

import { useEffect, type JSX } from 'react'
import type { SettingsSection } from '@shared/types/settings'
import { navigate, useRoute } from './app/navigation'
import { CrashBoundary, DeepLinkListener, Layout, ShellReporters } from './app/shell'
import { Sidebar } from './app/Sidebar'
import { Toaster } from './app/Toaster'
import { FramedPage } from './app/TopBar'
import { ActionItemsPage } from './features/action-items'
import { registerBlockCards } from './features/blocks'
import { CaptureEngineHost } from './features/capture'
import { ChatPage, FloatingChat } from './features/chat'
import { CompaniesPage, CompanyPage } from './features/companies'
import { CustomerCallsPage } from './features/crm'
import { DeviceLockGate } from './features/device-lock'
import { DispatchesPage } from './features/dispatch'
import { DemoHost } from './features/demo'
import { FolderPage } from './features/folders'
import { FollowUpComposerHost } from './features/follow-up'
import { HomePage } from './features/home'
import { RecordingDropTarget } from './features/imports'
import { IntegrationsDialogsHost } from './features/integrations'
import { registerIntegrationPlusSlots } from './features/integrations-plus'
import { NewNoteListener } from './features/new-note'
import { NotePage } from './features/note-page'
import { NuxHost } from './features/nux'
import { PeoplePage, PersonPage } from './features/people'
import { QuickAskListener } from './features/quick-ask'
import { RecipeModalHost, RecipesPage } from './features/recipes'
import { ScratchpadPage } from './features/scratchpad'
import { CommandPaletteHost, SearchPage } from './features/search'
import { OnboardingGate, PermissionsPage, SettingsPage } from './features/settings'
import { usePrefs } from './features/settings/prefs-store'
import { StorageGate } from './features/storage-gate'
import { TasksPage } from './features/tasks'
import { TemplateGalleryHost } from './features/templates'
import { TranscriptionRulesDialogHost } from './features/transcription-rules'
import { DiagnosticsToasts } from './features/troubleshooting'
import { UserContextPage } from './features/user-context'
import { WindowModeChrome } from './features/window-modes'

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'preferences',
  'keyboard-shortcuts',
  'ai',
  'profile',
  'calendar',
  'notifications',
  'speaker-tags',
  'voice-typing',
  'integrations',
  'connectors',
  'labs',
  'troubleshooting',
  'about',
  'dev',
  // `feedback` and `automations` are sidebar entries; the last two are sub-pages
  'feedback',
  'automations',
  'meeting-notice',
  'transcription-rules',
  'sources'
]

/**
 * `/settings` lands on `/settings/<section>` (replace), from the older `?section=` when given;
 * any route's `?settings=<section>` does the same and leaves the address.
 */
function settingsRedirect(path: string, query: URLSearchParams): string | null {
  // The Labs address other notes apps link to lands on Notula's Labs section.
  if (path === '/settings/preferences/labs') return '/settings/labs'
  if (path === '/settings') {
    const s = query.get('section')
    return `/settings/${s && (SETTINGS_SECTIONS as readonly string[]).includes(s) ? s : 'preferences'}`
  }
  const s = query.get('settings')
  if (s !== null) return `/settings/${(SETTINGS_SECTIONS as readonly string[]).includes(s) ? s : 'preferences'}`
  return null
}

/**
 * Routes: `/` home, `/meeting/:id` note, `/settings/:section`, `/permissions`,
 * `/chat[/:threadId]`, `/recipes`, `/search`, `/list/:id` (a folder) and `/person/:email`.
 * `/action-items` and `/scratchpad` are each the home page while their Labs switch is off;
 * then `/people`, `/person/:email`, `/companies` and `/company/:domain`.
 */
function Router(): JSX.Element | null {
  const { path, params, query } = useRoute()
  const prefs = usePrefs()
  const redirect = settingsRedirect(path, query)
  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true })
  }, [redirect])
  if (redirect) return null
  if (path.startsWith('/settings/')) return <SettingsPage />
  if (path === '/permissions') {
    return (
      <FramedPage>
        <PermissionsPage />
      </FramedPage>
    )
  }
  if (path === '/chat' || path.startsWith('/chat/')) {
    return (
      <FramedPage>
        <ChatPage threadId={params['threadId'] ?? null} />
      </FramedPage>
    )
  }
  if (path === '/recipes') {
    return (
      <FramedPage>
        <RecipesPage />
      </FramedPage>
    )
  }
  if (path === '/search') {
    return (
      <FramedPage>
        <SearchPage />
      </FramedPage>
    )
  }
  const email = params['email']
  if (path.startsWith('/person/') && email) {
    return (
      <FramedPage>
        <PersonPage key={email} email={email} />
      </FramedPage>
    )
  }
  if (path === '/action-items' && prefs?.['actionItems.enabled']) {
    return (
      <FramedPage>
        <ActionItemsPage />
      </FramedPage>
    )
  }
  if (path === '/scratchpad' && prefs?.['scratchpad.enabled']) {
    return (
      <FramedPage>
        <ScratchpadPage />
      </FramedPage>
    )
  }
  // ---------- Labs pages: each is the home page while its switch is off, except Tasks ----------
  if (path === '/tasks') {
    return (
      <FramedPage>
        <TasksPage />
      </FramedPage>
    )
  }
  if ((path === '/wiki' || path.startsWith('/wiki/')) && prefs?.['userContext.enabled']) {
    return (
      <FramedPage>
        <UserContextPage />
      </FramedPage>
    )
  }
  if ((path === '/dispatches' || path === '/dispatches/archived') && prefs?.['dispatcher.enabled']) {
    return (
      <FramedPage>
        <DispatchesPage />
      </FramedPage>
    )
  }
  if (path === '/view/customer-calls' && prefs?.['customerCalls.enabled']) {
    return (
      <FramedPage>
        <CustomerCallsPage />
      </FramedPage>
    )
  }
  if (path === '/people') {
    return (
      <FramedPage>
        <PeoplePage />
      </FramedPage>
    )
  }
  if (path === '/companies') {
    return (
      <FramedPage>
        <CompaniesPage />
      </FramedPage>
    )
  }
  const domain = params['domain']
  if (path.startsWith('/company/') && domain) {
    return (
      <FramedPage>
        <CompanyPage key={domain} domain={domain} />
      </FramedPage>
    )
  }
  const id = params['id']
  if (path.startsWith('/list/') && id) {
    return (
      <FramedPage>
        <FolderPage key={id} id={id} />
      </FramedPage>
    )
  }
  if (path.startsWith('/meeting/') && id) return <NotePage key={id} id={id} />
  return <HomePage />
}

/** The integration and tool-card slot registrations, once per main window. */
let slotsRegistered = false
function registerP4Slots(): void {
  if (slotsRegistered) return
  slotsRegistered = true
  registerBlockCards()
  registerIntegrationPlusSlots()
}

export function App(): JSX.Element {
  registerP4Slots()
  return (
    <CrashBoundary>
      <StorageGate>
        {/* While Notula is locked only the lock view renders; capture keeps running below. */}
        <DeviceLockGate>
          <OnboardingGate>
            <Layout sidebar={<Sidebar />}>
              <Router />
            </Layout>
            <NewNoteListener />
            <DeepLinkListener />
            <TemplateGalleryHost />
            <RecipeModalHost />
            <FloatingChat />
            <CommandPaletteHost />
            <RecordingDropTarget />
            <FollowUpComposerHost />
            <DemoHost />
            <QuickAskListener />
            <IntegrationsDialogsHost />
            <NuxHost />
            <TranscriptionRulesDialogHost />
          </OnboardingGate>
        </DeviceLockGate>
        <CaptureEngineHost />
      </StorageGate>
      <ShellReporters />
      {/* Small-mode chrome and the trace toasts. */}
      <WindowModeChrome />
      <DiagnosticsToasts />
      <Toaster />
    </CrashBoundary>
  )
}
