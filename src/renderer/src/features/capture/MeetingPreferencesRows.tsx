// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Preferences ▸ Meetings: the Live meeting indicator, the inactivity delays
// and the app-left stop. Meeting detection and its notifications live on
// Settings ▸ Notifications.

import type { JSX } from 'react'
import { SettingsCard, SettingsRow } from '../settings'
import { Choice, Toggle, setMeetingPrefs, useMeetingPrefs } from './settings-controls'

const WARNING_CHOICES = ['off', '5', '10', '15', '20', '30'] as const
const STOP_CHOICES = ['off', '10', '15', '20', '30', '45', '60'] as const

type Minutes = 'off' | `${number}`

function minutesOptions(values: readonly string[], current: number | null): { value: Minutes; label: string }[] {
  const all = new Set(values)
  // A value set elsewhere (or a dev profile) still shows as itself.
  if (current !== null) all.add(String(current))
  return [...all]
    .sort((a, b) => (a === 'off' ? -1 : b === 'off' ? 1 : Number(a) - Number(b)))
    .map((v) => ({ value: v as Minutes, label: v === 'off' ? 'Off' : `${v} minutes` }))
}

const toMinutes = (v: Minutes): number | null => (v === 'off' ? null : Number(v))
const fromMinutes = (n: number | null): Minutes => (n === null ? 'off' : (String(n) as Minutes))

export function MeetingPreferencesRows(): JSX.Element {
  const prefs = useMeetingPrefs()
  if (!prefs) return <></>
  const warn = prefs['capture.inactivityWarningMinutes']
  const stop = prefs['capture.inactivityAutoStopMinutes']
  const appLeft = prefs['capture.autoStopWhenMeetingAppCloses']
  return (
    <SettingsCard title="Meetings">
      <SettingsRow
        title="Live meeting indicator"
        description="Shows a small floating control while a meeting is transcribing."
        control={
          <Toggle
            label="Live meeting indicator"
            checked={!prefs['bubble.blocked']}
            onChange={(on) => setMeetingPrefs({ 'bubble.blocked': !on })}
          />
        }
      />
      <SettingsRow
        title="Check in when it goes quiet"
        description="Ask whether you’re still there after this long without any speech"
        control={
          <Choice
            label="Check in when it goes quiet"
            value={fromMinutes(warn)}
            options={minutesOptions(WARNING_CHOICES, warn)}
            onChange={(v) => setMeetingPrefs({ 'capture.inactivityWarningMinutes': toMinutes(v) })}
          />
        }
      />
      <SettingsRow
        title="Stop after inactivity"
        description="Stop transcribing after this long without any speech"
        control={
          <Choice
            label="Stop after inactivity"
            value={fromMinutes(stop)}
            options={minutesOptions(STOP_CHOICES, stop)}
            onChange={(v) => setMeetingPrefs({ 'capture.inactivityAutoStopMinutes': toMinutes(v) })}
          />
        }
      />
      <SettingsRow
        title="Stop when the call app closes"
        description="When the meeting app releases your microphone after at least 3 minutes of call audio"
        control={
          <Toggle
            label="Stop when the call app closes"
            checked={appLeft}
            onChange={(on) => setMeetingPrefs({ 'capture.autoStopWhenMeetingAppCloses': on })}
          />
        }
      />
      <SettingsRow
        title="Check with AI before stopping"
        description="Ask your AI provider whether the meeting really ended before stopping"
        control={
          <Toggle
            label="Check with AI before stopping"
            checked={prefs['capture.llmAutoStop']}
            disabled={!appLeft}
            onChange={(on) => setMeetingPrefs({ 'capture.llmAutoStop': on })}
          />
        }
      />
    </SettingsCard>
  )
}
