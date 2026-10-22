// SPDX-License-Identifier: Apache-2.0
// Settings (`/settings/<section>`). The section list lives in the window's sidebar
// (app/Sidebar), which swaps to
// it on Settings routes. This page is the frame: a back bar, then one scroll area with
// the page header and the section's cards.
//
// - Scroll restore: each history entry's position is kept in session
//   storage (`notula-settings-scroll`, last 50 entries). Back and Forward bring it back,
//   hiding the area for up to 100 ms while the content grows and giving up after 5 s;
//   new navigations start at the top.
// - The menu item (Ctrl/⌘+,), `settings.open()` and main's `settings:open` push land
//   here through `useSettingsOpenListener`.

import { useEffect, useLayoutEffect, useRef, type JSX, type RefObject } from 'react'
import type { SettingsSection } from '@shared/types/settings'
import { IconArrowLeft } from '../../app/icons'
import {
  currentEntryKey,
  currentRoute,
  isSettingsPath,
  lastNavigationKind,
  leaveSettings,
  navigate,
  navigateToSettings,
  useRoute
} from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { TopBar } from '../../app/TopBar'
import { useUpdateState } from '../../app/update-store'
import { CalendarSettings, PeoplePreferencesRows } from '../calendar'
import { AboutSettings } from '../about'
import { AutomationsSettings } from '../automations'
import { CaptionsPreferenceRow } from '../captions'
import { ImageInputRows } from '../chat'
import { CompanyPreferencesRows } from '../companies'
import { ConnectorsSettings } from '../connectors'
import { ConsentPreferencesRow, MeetingNoticeSettings } from '../consent'
import { DataExportCard } from '../data-export'
import { NotesImportCard } from '../imports-md'
import { VoiceTypingSettings } from '../dictation'
import { FeedbackSettings } from '../feedback'
import { FolderPreferencesRows } from '../folders'
import { ChatEnterBehaviorRow, LabsMoreRow } from '../general-prefs'
import { IntegrationsSettings } from '../integrations'
import { KeyboardShortcutsSettings } from '../keyboard-shortcuts'
import { LabsPage } from '../labs'
import { DataUsageCard, LocalOnlySwitch } from '../local-only'
import { MeetingPreferencesRows } from '../capture'
import { NotesAiSettingsRows } from '../notes-ai'
import { NotificationsSettings } from '../notify'
import { TipsPreferencesRow } from '../nux'
import { ProfileForm, ThisDeviceCard } from '../profile'
import { RecordingsPreferencesRows } from '../recordings'
import { DeletionLog, RetentionRows } from '../retention'
import { SourcesSettings } from '../sources'
import { SpeakerTagsPreferenceRow, SpeakerTagsSettings } from '../speaker-tags'
import { SpeechPreferencesRows } from '../transcript'
import { TranscriptionRulesPreferencesRow, TranscriptionRulesSettings } from '../transcription-rules'
import { TroubleshootingSettings } from '../troubleshooting'
import { AiSection } from './AiSection'
import { DevSection } from './DevSection'
import { PreferencesSection } from './PreferencesSection'
import { usePrefs } from './prefs-store'
import { useSettingsSections, type SettingsSectionMeta } from './sections'
import './settings.css'

// ---------- scroll memory ----------

const SCROLL_KEY = 'notula-settings-scroll'
const SCROLL_ENTRIES = 50
const REVEAL_MS = 100
const RESTORE_GIVE_UP_MS = 5_000

function readScrollMap(): [string, number][] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? (raw.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number') as [string, number][]) : []
  } catch {
    return []
  }
}

function saveScroll(key: string, y: number): void {
  try {
    const entries = readScrollMap().filter(([k]) => k !== key)
    entries.push([key, Math.round(y)])
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(entries.slice(-SCROLL_ENTRIES)))
  } catch (err) {
    debugLog('settings:scroll-save-failed', { err: String(err) })
  }
}

function savedScroll(key: string): number | null {
  return readScrollMap().find(([k]) => k === key)?.[1] ?? null
}

/** Saves the area's position per history entry and restores it on Back/Forward. */
function useScrollMemory(ref: RefObject<HTMLDivElement | null>, section: string): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const key = currentEntryKey()
    const target = lastNavigationKind() === 'pop' ? savedScroll(key) : null
    let frame = 0
    let restoring = target !== null && target > 0
    let userScrolled = false

    const onScroll = (): void => {
      if (restoring) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => saveScroll(key, el.scrollTop))
    }
    const onUser = (): void => {
      userScrolled = true
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onUser, { passive: true })
    el.addEventListener('pointerdown', onUser)
    el.addEventListener('keydown', onUser)

    if (!restoring || target === null) {
      el.scrollTop = 0
    } else {
      el.style.visibility = 'hidden'
      const started = performance.now()
      const reveal = (): void => {
        el.style.visibility = ''
      }
      const tick = (): void => {
        if (el.scrollHeight - el.clientHeight >= target) {
          el.scrollTop = target
          reveal()
          restoring = false
          return
        }
        const elapsed = performance.now() - started
        if (elapsed >= REVEAL_MS) reveal()
        if (elapsed >= RESTORE_GIVE_UP_MS || userScrolled) {
          reveal()
          restoring = false
          return
        }
        frame = requestAnimationFrame(tick)
      }
      tick()
    }

    return () => {
      cancelAnimationFrame(frame)
      el.style.visibility = ''
      if (!restoring) saveScroll(key, el.scrollTop)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onUser)
      el.removeEventListener('pointerdown', onUser)
      el.removeEventListener('keydown', onUser)
    }
  }, [ref, section])
}

// ---------- the page ----------

function SectionBody({ meta }: { meta: SettingsSectionMeta }): JSX.Element {
  const prefs = usePrefs()
  if (meta.id === 'calendar') return <CalendarSettings />
  if (meta.id === 'notifications') return <NotificationsSettings />
  if (meta.id === 'dev') return <DevSection />
  // Feature sections: each feature's own page.
  if (meta.id === 'keyboard-shortcuts') return <KeyboardShortcutsSettings />
  if (meta.id === 'speaker-tags') return <SpeakerTagsSettings />
  if (meta.id === 'voice-typing') return <VoiceTypingSettings />
  if (meta.id === 'integrations') return <IntegrationsSettings />
  if (meta.id === 'connectors') return <ConnectorsSettings />
  if (meta.id === 'labs') return <LabsPage />
  if (meta.id === 'troubleshooting') return <TroubleshootingSettings />
  if (meta.id === 'about') return <AboutSettings />
  // Workflow and Labs sections
  if (meta.id === 'feedback') return <FeedbackSettings />
  if (meta.id === 'automations') return <AutomationsSettings />
  if (meta.id === 'meeting-notice') return <MeetingNoticeSettings />
  if (meta.id === 'transcription-rules') return <TranscriptionRulesSettings />
  if (meta.id === 'sources') return <SourcesSettings />
  if (!prefs) {
    return (
      <div className="settings__loading" aria-busy="true">
        <div className="n-skeleton" style={{ height: 18, width: 120 }} />
        <div className="n-skeleton" style={{ height: 120 }} />
        <div className="n-skeleton" style={{ height: 160 }} />
      </div>
    )
  }
  if (meta.id === 'ai') {
    return (
      <>
        <AiSection prefs={prefs} />
        <NotesAiSettingsRows />
        <ImageInputRows />
      </>
    )
  }
  if (meta.id === 'profile') {
    // The profile form, then This device.
    return (
      <>
        <ProfileForm />
        <ThisDeviceCard />
      </>
    )
  }
  return (
    <>
      <PreferencesSection prefs={prefs} />
      {/* The chat Enter-key row, the meeting notice row, the transcription rules row and the tips rows. */}
      <ChatEnterBehaviorRow />
      <ConsentPreferencesRow />
      <TranscriptionRulesPreferencesRow />
      <TipsPreferencesRow />
      <MeetingPreferencesRows />
      <SpeechPreferencesRows />
      <PeoplePreferencesRows />
      <FolderPreferencesRows />
      <SpeakerTagsPreferenceRow />
      <CaptionsPreferenceRow />
      <RecordingsPreferencesRows />
      <CompanyPreferencesRows />
      <DataExportCard />
      <NotesImportCard />
      {/* The "Your data" additions after the export, then the "More" group. */}
      <DataUsageCard />
      <LocalOnlySwitch />
      <RetentionRows />
      <DeletionLog />
      <LabsMoreRow />
    </>
  )
}

/** `/settings/:section`. App's router has already turned `/settings` and `?section=` into a path. */
export function SettingsPage(): JSX.Element {
  const { params } = useRoute()
  const sections = useSettingsSections()
  const update = useUpdateState()
  const prefs = usePrefs()
  const requested = params['section']
  const found = sections.find((s) => s.id === requested)
  const meta = found ?? sections[0]!
  const scrollRef = useRef<HTMLDivElement>(null)

  // A section this build does not ship lands on Preferences. Developer tools waits
  // until main has said whether this is a packaged build; Voice typing waits for the
  // preferences (its Labs switch).
  useEffect(() => {
    if (
      found ||
      (requested === 'dev' && update === null) ||
      ((requested === 'voice-typing' || requested === 'sources') && prefs === null)
    ) {
      return
    }
    navigate('/settings/preferences', { replace: true })
  }, [found, requested, update, prefs])
  useScrollMemory(scrollRef, meta.id)

  useEffect(() => debugLog('settings-opened'), [])

  return (
    <div className="page settings-view">
      <TopBar
        left={
          <button type="button" className="n-btn n-btn--ghost topbar__back" onClick={leaveSettings}>
            <IconArrowLeft size={16} />
            Back
          </button>
        }
      />
      <div className="page__scroll settings-view__scroll" ref={scrollRef}>
        <div className="settings-page">
          <header className="settings-page__header">
            <span className="settings-page__icon">{meta.icon(18)}</span>
            <div>
              <h1 className="settings-page__title">{meta.title}</h1>
              <p className="settings-page__description">{meta.description}</p>
            </div>
          </header>
          <SectionBody key={meta.id} meta={meta} />
        </div>
      </div>
    </div>
  )
}

/**
 * The `settings:open` push (the app menu, or `settings.open()` forwarded by main): go
 * to the requested section. A push without a section opens Preferences, and is
 * ignored while Settings is already open, so Ctrl/⌘+, keeps the page.
 */
export function useSettingsOpenListener(): void {
  useEffect(
    () =>
      window.notula.settings.onOpen(({ section }) => {
        if (!section) {
          if (!isSettingsPath(currentRoute().path)) navigateToSettings('preferences')
          return
        }
        navigateToSettings(section satisfies SettingsSection)
      }),
    []
  )
}
