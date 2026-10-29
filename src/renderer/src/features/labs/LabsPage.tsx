// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Labs: every default-off feature from LABS_FEATURES, grouped by LABS_SECTIONS.
//
// - A row is a generic switch bound to its settings key, or the owning feature's custom row.
//   Until an owner ships its row, the generic switch stands in for it, so every key can be
//   toggled from the first build.
// - Children are indented and disabled while their parent is off. Rows with a platform
//   list are hidden elsewhere. A row that is also elsewhere links there; both bind one key.
// - Turning a row on never starts network traffic by itself.

import type { JSX, ReactNode } from 'react'
import { LABS_FEATURES, LABS_SECTIONS, type LabsFeature, type LabsSettingKey } from '@shared/types/labs'
import { DEFAULT_SETTINGS, MAIN_ONLY_SETTING_KEYS, type Settings } from '@shared/types/settings'
import { navigateToSettings } from '../../app/navigation'
import { isMac } from '../../app/platform'
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
  'customerCalls.enabled': CustomerCallsLabsRow
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

function LabsItem({ feature, prefs }: { feature: LabsFeature; prefs: Settings }): JSX.Element {
  const Custom = feature.kind === 'custom' ? CUSTOM_ROWS[feature.key] : undefined
  if (!Custom) {
    return (
      <div className="labs-item">
        <GenericRow feature={feature} prefs={prefs} />
      </div>
    )
  }
  return (
    <div className="labs-item">
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

export function LabsPage(): JSX.Element {
  const prefs = usePrefs()
  if (!prefs) {
    return (
      <div className="settings__loading" aria-busy="true">
        <div className="n-skeleton" style={{ height: 18, width: 120 }} />
        <div className="n-skeleton" style={{ height: 200 }} />
      </div>
    )
  }
  const visible = LABS_FEATURES.filter(shown)
  return (
    <>
      {LABS_SECTIONS.map((section) => {
        const rows = visible.filter((f) => f.section === section.id)
        if (rows.length === 0) return null
        return (
          <section key={section.id} className="settings-group">
            <h2 className="settings-group__title">{section.title}</h2>
            <div className="settings-card labs-card">
              {rows.map((f) => (
                <LabsItem key={f.key} feature={f} prefs={prefs} />
              ))}
            </div>
          </section>
        )
      })}
      <p className="labs-footnote">
        Turning a feature on never sends anything by itself. Features that use your AI provider say so in their own settings.
      </p>
    </>
  )
}
