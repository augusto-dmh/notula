// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Labs: every default-off feature from LABS_FEATURES, grouped by LABS_SECTIONS.
//
// - A row is a generic switch bound to its settings key, or the owning feature's custom row.
//   Until an owner ships its row, the generic switch stands in for it, so every key can be
//   toggled from the first build.
// - Children are indented and disabled while their parent is off. Rows with a platform
//   list are hidden elsewhere. A row that is also elsewhere links there; both bind one key.
// - Turning a row on never starts network traffic by itself.
// - A filter at the top matches labels and descriptions; a nested match shows with its parent.
//   It lives for the visit only. A jump list of the sections scrolls to each one.
// - `openLabs({ focus })` (./labs-focus.ts) scrolls to a row and highlights it.

import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { LABS_FEATURES, LABS_SECTIONS, type LabsFeature, type LabsSettingKey } from '@shared/types/labs'
import { DEFAULT_SETTINGS, MAIN_ONLY_SETTING_KEYS, type Settings } from '@shared/types/settings'
import { navigateToSettings } from '../../app/navigation'
import { isMac } from '../../app/platform'
import { OffRecordLabsRow } from '../capture/OffRecordLabsRow'
import { LiveContextLabsRow } from '../live-context'
import { CompanionCliLabsRow } from '../companion-cli'
import { ConsentLabsRow } from '../consent'
import { CustomerCallsLabsRow } from '../crm'
import { DeviceLockLabsRow } from '../device-lock'
import { VoiceTypingLabsRow } from '../dictation'
import { QuickAskLabsRow } from '../quick-ask'
import { BetaLabsRow } from '../release-channel'
import { Switch } from '../settings/controls'
import { usePrefs, setPrefs } from '../settings/prefs-store'
import { ScreenSnapshotsLabsRow } from '../snapshots'
import { subscribeLabsFocus } from './labs-focus'
import './labs.css'

/** The owning features' custom rows. */
const CUSTOM_ROWS: Partial<Record<LabsSettingKey, () => JSX.Element | null>> = {
  'screenSnapshots.enabled': ScreenSnapshotsLabsRow,
  'quickAsk.enabled': QuickAskLabsRow,
  'voiceTyping.enabled': VoiceTypingLabsRow,
  'consent.enabled': ConsentLabsRow,
  'liveContext.mode': LiveContextLabsRow,
  'companionCli.enabled': CompanionCliLabsRow,
  'updates.channel': BetaLabsRow,
  'security.deviceLock': DeviceLockLabsRow,
  'customerCalls.enabled': CustomerCallsLabsRow,
  'capture.offRecordPrompt': OffRecordLabsRow
}

/**
 * A key the generic switch cannot stand in for (a select, a channel, or a main-only key
 * that only its own row may change): until its owner's row ships, the row shows its text only.
 */
function hasGenericFallback(key: LabsSettingKey): boolean {
  return typeof DEFAULT_SETTINGS[key] === 'boolean' && !(MAIN_ONLY_SETTING_KEYS as readonly string[]).includes(key)
}

const SECTION_LABEL: Partial<Record<string, string>> = { ai: 'AI' }

const platform: 'win32' | 'darwin' | 'linux' = isMac ? 'darwin' : /Windows/i.test(navigator.userAgent) ? 'win32' : 'linux'

function shown(f: LabsFeature): boolean {
  return !f.platforms || (platform !== 'linux' && f.platforms.includes(platform))
}

/** Lower case without accents, so "écran" finds "ecran" and the other way round. */
const fold = (s: string): string => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')

function matches(f: LabsFeature, terms: string[]): boolean {
  const text = fold(`${f.label} ${f.description}`)
  return terms.every((t) => text.includes(t))
}

/** The rows the filter keeps: a match, the parent of a matching child, or a child of a matching parent. */
function filtered(features: LabsFeature[], query: string): LabsFeature[] {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (!terms.length) return features
  const hit = new Set(features.filter((f) => matches(f, terms)).map((f) => f.key))
  return features.filter((f) => hit.has(f.key) || (f.parent && hit.has(f.parent)) || features.some((c) => c.parent === f.key && hit.has(c.key)))
}

const rowId = (key: LabsSettingKey): string => `labs-row-${key}`
const sectionId = (id: string): string => `labs-section-${id}`

function GenericRow({ feature, prefs }: { feature: LabsFeature; prefs: Settings }): JSX.Element {
  const parentOff = feature.parent ? prefs[feature.parent] !== true : false
  const checked = prefs[feature.key] === true
  let hint: ReactNode = feature.description
  if (feature.alsoIn) {
    const section = feature.alsoIn
    hint = (
      <>
        {feature.description}{' '}
        <button type="button" className="labs-link" onClick={() => navigateToSettings(section)}>
          Also in {SECTION_LABEL[section] ?? section} settings
        </button>
      </>
    )
  }
  return (
    <div className={`settings-row${feature.parent ? ' labs-row--child' : ''}`}>
      <div className="settings-row__text">
        <div className="settings-row__label">{feature.label}</div>
        <div className="settings-row__hint">{hint}</div>
      </div>
      <div className="settings-row__control">
        <Switch
          label={feature.label}
          checked={checked}
          disabled={parentOff}
          onChange={(next) => setPrefs({ [feature.key]: next })}
        />
      </div>
    </div>
  )
}

function TextRow({ feature }: { feature: LabsFeature }): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <div className="settings-row__label">{feature.label}</div>
        <div className="settings-row__hint">{feature.description}</div>
      </div>
    </div>
  )
}

function LabsItem({ feature, prefs, focused }: { feature: LabsFeature; prefs: Settings; focused: boolean }): JSX.Element {
  const Custom = feature.kind === 'custom' ? CUSTOM_ROWS[feature.key] : undefined
  const cls = `labs-item${focused ? ' labs-item--focus' : ''}`
  if (!Custom) {
    return (
      <div className={cls} id={rowId(feature.key)}>
        <GenericRow feature={feature} prefs={prefs} />
      </div>
    )
  }
  return (
    <div className={cls} id={rowId(feature.key)}>
      {/* The owner's row; while it renders nothing, the generic switch below shows instead. */}
      <div className="labs-custom">
        <Custom />
      </div>
      <div className="labs-fallback">
        {hasGenericFallback(feature.key) ? <GenericRow feature={feature} prefs={prefs} /> : <TextRow feature={feature} />}
      </div>
    </div>
  )
}

/** How long a deep-linked row stays highlighted. */
const FOCUS_MS = 2400

export function LabsPage(): JSX.Element {
  const prefs = usePrefs()
  const [query, setQuery] = useState('')
  const [focus, setFocus] = useState<LabsSettingKey | null>(null)

  // A deep link clears the filter, so its row is there to scroll to.
  useEffect(
    () =>
      subscribeLabsFocus((key) => {
        setQuery('')
        setFocus(key)
      }),
    []
  )
  useEffect(() => {
    if (!focus || !prefs) return
    // After the layout settles, so the scroll lands on the row and nothing moves it after.
    const raf = requestAnimationFrame(() => document.getElementById(rowId(focus))?.scrollIntoView({ block: 'center' }))
    const t = setTimeout(() => setFocus(null), FOCUS_MS)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [focus, prefs])

  if (!prefs) {
    return (
      <div className="settings__loading" aria-busy="true">
        <div className="n-skeleton" style={{ height: 18, width: 120 }} />
        <div className="n-skeleton" style={{ height: 200 }} />
      </div>
    )
  }
  const rows = filtered(LABS_FEATURES.filter(shown), query)
  const sections = LABS_SECTIONS.map((section) => ({ ...section, rows: rows.filter((f) => f.section === section.id) })).filter((s) => s.rows.length > 0)
  return (
    <>
      <div className="labs-find">
        <input
          type="search"
          className="n-input labs-find__input"
          placeholder="Search Labs"
          aria-label="Search Labs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {sections.length ? (
          <nav className="labs-jump" aria-label="Labs sections">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className="labs-jump__item"
                onClick={() => document.getElementById(sectionId(s.id))?.scrollIntoView({ block: 'start', behavior: 'smooth' })}
              >
                {s.title}
              </button>
            ))}
          </nav>
        ) : null}
      </div>
      {sections.length === 0 ? <p className="labs-empty">No Labs features match “{query.trim()}”.</p> : null}
      {sections.map((section) => (
        <section key={section.id} id={sectionId(section.id)} className="settings-group labs-group">
          <h2 className="settings-group__title">{section.title}</h2>
          <div className="settings-card labs-card">
            {section.rows.map((f) => (
              <LabsItem key={f.key} feature={f} prefs={prefs} focused={f.key === focus} />
            ))}
          </div>
        </section>
      ))}
      <p className="labs-footnote">
        Turning a feature on never sends anything by itself. Features that use your AI provider say so in their own settings.
      </p>
    </>
  )
}
