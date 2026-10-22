// SPDX-License-Identifier: Apache-2.0
// Settings ▸ AI ▸ "After each meeting": the switches of the post-summary features,
// bound to the same keys as their Labs rows (all off by default). Each one sends
// meeting content to the AI provider the user chose.

import type { JSX } from 'react'
import type { SettingKey } from '@shared/types/settings'
import { SettingsCard, SettingsRow } from '../settings/primitives'
import { setPrefs, usePrefs } from '../settings/prefs-store'

type BoolKey = Extract<SettingKey, 'actionItems.enabled' | 'followUpEmail.enabled' | 'followUpEmail.auto' | 'tags.classify' | 'attachedLinks.enabled'>

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange(next: boolean): void; label: string; disabled?: boolean }): JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="settings-switch" onClick={() => onChange(!checked)}>
      <span className="settings-switch__thumb" />
    </button>
  )
}

export function NotesAiSettingsRows(): JSX.Element {
  const prefs = usePrefs()
  const on = (k: BoolKey): boolean => prefs?.[k] === true
  const row = (key: BoolKey, title: string, description: string, disabled?: boolean): JSX.Element => (
    <SettingsRow
      title={title}
      description={description}
      control={<Toggle checked={on(key)} disabled={!prefs || disabled} label={title} onChange={(v) => setPrefs({ [key]: v })} />}
    />
  )
  return (
    <SettingsCard title="After each meeting" description="These run with your AI provider once a meeting’s notes are generated. All of them are off until you turn them on.">
      {row('actionItems.enabled', 'Action items', 'Pull action items out of each meeting summary.')}
      {row('followUpEmail.enabled', 'Suggested follow-up emails', 'Draft a follow-up email to attendees from the meeting’s notes, ready to edit and send.')}
      {on('followUpEmail.enabled')
        ? row('followUpEmail.auto', 'Draft automatically', 'Draft a follow-up after meetings with people outside your company.')
        : null}
      {row('tags.classify', 'Classify meetings', 'Tag each meeting with its type and sensitivity after its summary, using your AI provider.')}
      {row('attachedLinks.enabled', 'Links from invites', 'Offer to save the document links in a meeting’s invite to its note.')}
    </SettingsCard>
  )
}
