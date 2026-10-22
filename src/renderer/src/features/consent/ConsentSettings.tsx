// SPDX-License-Identifier: Apache-2.0
// The meeting notice's settings: the Labs row, the Preferences row
// and the `meeting-notice` sub-page (channels, the message with its preview, the two options).

import { useEffect, useState, type JSX } from 'react'
import { CONSENT_DEFAULT_MESSAGE, CONSENT_LIMITS } from '@shared/types/consent'
import { navigateToSettings } from '../../app/navigation'
import { isMac } from '../../app/platform'
import { Group, Row, Switch } from '../settings/controls'
import { usePrefs, setPrefs } from '../settings/prefs-store'
import { SettingsCard, SettingsRow } from '../settings/primitives'
import './consent.css'

export function ConsentLabsRow(): JSX.Element {
  const prefs = usePrefs()
  const on = prefs?.['consent.enabled'] === true
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <div className="settings-row__label">Notice in meeting chat</div>
        <div className="settings-row__hint">
          When you start taking notes in a Zoom or Teams call, post a short notice in the meeting chat so everyone knows.{' '}
          {on ? (
            <button type="button" className="consent-link" onClick={() => navigateToSettings('meeting-notice')}>
              Set up the notice
            </button>
          ) : null}
        </div>
      </div>
      <div className="settings-row__control">
        <Switch label="Notice in meeting chat" checked={on} disabled={!prefs} onChange={(next) => setPrefs({ 'consent.enabled': next })} />
      </div>
    </div>
  )
}

export function ConsentPreferencesRow(): JSX.Element | null {
  const prefs = usePrefs()
  if (prefs?.['consent.enabled'] !== true) return null
  return (
    <SettingsCard>
      <SettingsRow
        title="Add notice in meeting chat"
        description="Let others in the meeting know Notula is taking notes."
        control={<span className="consent-chevron" aria-hidden="true">›</span>}
        onClick={() => navigateToSettings('meeting-notice')}
      />
    </SettingsCard>
  )
}

function MessageEditor({ saved }: { saved: string }): JSX.Element {
  const [text, setText] = useState(saved)
  useEffect(() => setText(saved), [saved])
  const shown = text.trim() || CONSENT_DEFAULT_MESSAGE
  const commit = (): void => {
    const next = text.trim().slice(0, CONSENT_LIMITS.messageMax)
    if (next !== saved) setPrefs({ 'consent.message': next })
  }
  return (
    <div className="consent-editor">
      <div className="consent-preview" aria-label="Preview">
        <div className="consent-preview__who">You, just now</div>
        <div className="consent-preview__bubble">{shown}</div>
      </div>
      <label className="consent-editor__label" htmlFor="consent-message">
        Message Notula posts in the meeting chat:
      </label>
      <textarea
        id="consent-message"
        className="n-input consent-editor__text"
        rows={3}
        maxLength={CONSENT_LIMITS.messageMax}
        placeholder={CONSENT_DEFAULT_MESSAGE}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
      <div className="consent-editor__foot">
        <span>Leave it empty to use the default.</span>
        <span>
          {text.length}/{CONSENT_LIMITS.messageMax}
        </span>
      </div>
    </div>
  )
}

export function MeetingNoticeSettings(): JSX.Element {
  const prefs = usePrefs()
  if (!prefs) return <div className="n-skeleton" style={{ height: 160 }} />
  const how = isMac
    ? 'Notula copies the notice and reminds you to paste it in the chat.'
    : 'Notula pastes the notice in the call’s chat and sends it. If it can’t, it copies the notice for you.'
  return (
    <>
      {!prefs['consent.enabled'] ? (
        <p className="consent-off">
          The notice is off.{' '}
          <button type="button" className="consent-link" onClick={() => navigateToSettings('labs')}>
            Turn on Notice in meeting chat in Labs
          </button>
        </p>
      ) : null}
      <Group title="Automated chat message" description={how}>
        <Row label="Zoom">
          <Switch label="Zoom" checked={prefs['consent.zoom']} onChange={(v) => setPrefs({ 'consent.zoom': v })} />
        </Row>
        <Row label="Microsoft Teams">
          <Switch label="Microsoft Teams" checked={prefs['consent.teams']} onChange={(v) => setPrefs({ 'consent.teams': v })} />
        </Row>
        <Row label="Google Meet" hint="Notula copies the notice for you to paste in the Meet chat.">
          <Switch label="Google Meet" checked={prefs['consent.meet']} onChange={(v) => setPrefs({ 'consent.meet': v })} />
        </Row>
      </Group>
      <Group title="Message">
        <Row label="Notice" stacked>
          <MessageEditor saved={prefs['consent.message']} />
        </Row>
      </Group>
      <Group title="Options">
        <Row label="Wait for someone else to speak" hint="Post only after another participant has spoken.">
          <Switch
            label="Wait for someone else to speak"
            checked={prefs['consent.waitForOtherSpeaker']}
            onChange={(v) => setPrefs({ 'consent.waitForOtherSpeaker': v })}
          />
        </Row>
        <Row label="Start transcribing after the notice is posted" hint="Notula waits to transcribe until the notice is in the chat.">
          <Switch
            label="Start transcribing after the notice is posted"
            checked={prefs['consent.deferTranscription']}
            onChange={(v) => setPrefs({ 'consent.deferTranscription': v })}
          />
        </Row>
      </Group>
    </>
  )
}
