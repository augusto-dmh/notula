// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Speaker tags and its Preferences row.
//
// One switch per app (Zoom, Microsoft Teams, Google Meet in Chrome), off by default, each with
// its live status (`attribution:get-status` / `attribution:status-changed`); the Meet selector
// editor under Advanced; the Suggestions switch. Windows needs no permission; macOS shows the
// rows disabled with "Coming later on macOS".

import { useEffect, useState, type JSX } from 'react'
import type { MeetSelectors } from '@shared/types/transcript'
import { DEFAULT_MEET_SELECTORS, type AttributionApp, type AttributionAppStatus, type AttributionStatus } from '@shared/types/transcript'
import { navigateToSettings } from '../../app/navigation'
import { SettingsCard, SettingsRow } from '../settings'
import { SpeechSwitch } from '../transcript/LocalAsrSettings'
import { setSpeechPrefs, useSpeechPrefs } from '../transcript/speech-state'
import './speaker-tags.css'

const APP_LABEL: Record<AttributionApp, string> = { zoom: 'Zoom', teams: 'Microsoft Teams', meet: 'Google Meet in Chrome' }
const SETTING = { zoom: 'attribution.zoom', teams: 'attribution.teams', meet: 'attribution.meet' } as const
const CLASS_NAME = /^[A-Za-z0-9_-]{1,64}$/

function useAttributionStatus(): AttributionStatus | null {
  const [status, setStatus] = useState<AttributionStatus | null>(null)
  useEffect(() => {
    let alive = true
    const off = window.notula.attribution.onStatusChanged((s) => {
      if (alive) setStatus(s)
    })
    const refresh = (): void => {
      void window.notula.attribution
        .getStatus()
        .then((s) => {
          if (alive) setStatus(s)
        })
        .catch(() => undefined)
    }
    refresh()
    // The counters change on every event but are pushed only with a state change.
    const t = setInterval(refresh, 5_000)
    return () => {
      alive = false
      off()
      clearInterval(t)
    }
  }, [])
  return status
}

function statusLine(s: AttributionAppStatus | undefined, supported: boolean): string {
  if (!supported) return 'Coming later on macOS'
  if (!s || !s.enabled) return 'Off'
  switch (s.state) {
    case 'waiting':
      return s.detail ?? 'Starts when a call begins'
    case 'active':
      return s.uniqueSpeakers > 0 ? `Identifying speakers · ${s.uniqueSpeakers} so far` : 'Identifying speakers'
    case 'blind':
      return s.detail ?? 'Looking for the meeting window'
    case 'unavailable':
      return 'Not available on this PC'
    case 'failed':
      return s.detail ?? 'Stopped after repeated errors'
    default:
      return 'Off'
  }
}

function MeetSelectorEditor({ value, onSave }: { value: MeetSelectors; onSave(v: MeetSelectors | null): void }): JSX.Element {
  const [draft, setDraft] = useState<MeetSelectors>(value)
  useEffect(() => setDraft(value), [value])
  const classes: (keyof Pick<MeetSelectors, 'galleryTileClass' | 'selfPreviewClass' | 'speakingIndicatorClass'>)[] = [
    'galleryTileClass',
    'selfPreviewClass',
    'speakingIndicatorClass'
  ]
  const labels: Record<string, string> = {
    galleryTileClass: 'Participant tile class',
    selfPreviewClass: 'Your own preview class',
    speakingIndicatorClass: 'Speaking indicator class',
    talkingMeansActive: 'The indicator means speaking',
    selfByNameMatch: 'Recognize your tile by your name',
    selfFromMeetingControls: 'Infer your tile from its controls'
  }
  const valid = classes.every((k) => CLASS_NAME.test(draft[k]))
  const changed = JSON.stringify(draft) !== JSON.stringify(value)
  return (
    <div className="nt-st-selectors">
      {classes.map((k) => (
        <label key={k} className="nt-st-selectors__field">
          <span>{labels[k]}</span>
          <input
            className="n-input nt-st-selectors__input"
            value={draft[k]}
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, [k]: e.target.value.trim() })}
            aria-invalid={!CLASS_NAME.test(draft[k])}
          />
        </label>
      ))}
      {(['talkingMeansActive', 'selfByNameMatch', 'selfFromMeetingControls'] as const).map((k) => (
        <label key={k} className="nt-st-selectors__check">
          <input type="checkbox" checked={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} />
          <span>{labels[k]}</span>
        </label>
      ))}
      <div className="nt-st-selectors__actions">
        <button type="button" className="n-btn n-btn--sm" onClick={() => onSave(null)}>
          Reset to defaults
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={!valid || !changed} onClick={() => onSave(draft)}>
          Save
        </button>
      </div>
    </div>
  )
}

/** Settings ▸ Speaker tags. */
export function SpeakerTagsSettings(): JSX.Element {
  const prefs = useSpeechPrefs()
  const status = useAttributionStatus()
  const [advanced, setAdvanced] = useState(false)
  const supported = status?.supported ?? navigator.userAgent.includes('Windows')
  const selectors = prefs?.['attribution.meetSelectors'] ?? DEFAULT_MEET_SELECTORS
  const apps: AttributionApp[] = ['zoom', 'teams', 'meet']
  return (
    <>
      <SettingsCard
        title="Speaker tags"
        description="Notula can see who is speaking in Zoom, Teams and Google Meet and put their names in the transcript. Turn it on for each app you use."
      >
        {apps.map((app) => (
          <SettingsRow
            key={app}
            title={APP_LABEL[app]}
            description={statusLine(
              status?.apps.find((a) => a.app === app),
              supported
            )}
            control={
              <SpeechSwitch
                label={APP_LABEL[app]}
                checked={supported && (prefs?.[SETTING[app]] ?? false)}
                disabled={!prefs || !supported}
                onChange={(next) => setSpeechPrefs({ [SETTING[app]]: next })}
              />
            }
          />
        ))}
        <SettingsRow
          title="Suggestions"
          description="Suggest names for unknown speakers after a meeting."
          control={
            <SpeechSwitch
              label="Suggestions"
              checked={prefs?.['speakerNames.suggestions'] ?? false}
              disabled={!prefs}
              onChange={(next) => setSpeechPrefs({ 'speakerNames.suggestions': next })}
            />
          }
        />
      </SettingsCard>
      <SettingsCard title="Advanced">
        <SettingsRow
          title="Google Meet page selectors"
          description="The class names Notula looks for in Meet's page. Google changes them from time to time."
          onClick={() => setAdvanced((v) => !v)}
          control={<span className="nt-st-chevron">{advanced ? 'Hide' : 'Edit'}</span>}
        />
        {advanced ? <MeetSelectorEditor value={selectors} onSave={(v) => setSpeechPrefs({ 'attribution.meetSelectors': v })} /> : null}
      </SettingsCard>
    </>
  )
}

/** The Preferences row that shows whether speaker tags are on and opens their settings. */
export function SpeakerTagsPreferenceRow(): JSX.Element {
  const prefs = useSpeechPrefs()
  // On Windows the row reads Enabled whenever an app switch is on.
  const on = !!prefs && (prefs['attribution.zoom'] || prefs['attribution.teams'] || prefs['attribution.meet'])
  return (
    <SettingsCard>
      <SettingsRow
        title="Speaker tags"
        description="Label who said what in transcripts"
        onClick={() => navigateToSettings('speaker-tags')}
        control={<span className="nt-st-chevron">{on ? 'Enabled' : 'Off'}</span>}
      />
    </SettingsCard>
  )
}
