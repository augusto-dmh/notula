// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Speaker tags ▸ Recognize my voice ▸ Your voice: Record
// my voice, its status, Forget my voice and Keep improving from my online meetings. Rows of the
// Speaker tags card, under the Recognize my voice switch (that row, its fix line, its switch-off
// dialog and the "moved here from Labs" line are the page's).
//
// - The status reads `speakers:get-status` (counts and a date only; never a score) and follows
//   `speakers:status-changed` and `speaker-people:changed`.
// - Record my voice works with the switch off: a sample that passes turns it on (main does).
// - Forget my voice is `speaker-people:forget-voice` on the self person, after a confirmation.
// - Keep improving binds `speakers.selfPassive`; it applies only while Recognize my voice is on.

import { useEffect, useState, type JSX } from 'react'
import type { SpeakersStatus } from '@shared/types/speakers'
import { showToast } from '../../app/toast'
import { Modal } from '../folders/Modal'
import { SettingsRow } from '../settings'
import { Switch } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import * as S from '../speaker-profiles/strings'
import { errorText, RecordDialog } from './RecordDialog'
import './voiceprint.css'

function samplesLine(s: SpeakersStatus['self']): string {
  return S.yourVoiceSamples(s.sampleCount, s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : null)
}

function useSpeakersStatus(): SpeakersStatus | null {
  const [status, setStatus] = useState<SpeakersStatus | null>(null)
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void window.notula.speakers
        .getStatus()
        .then((s) => {
          if (alive) setStatus(s)
        })
        .catch(() => undefined)
    }
    const offStatus = window.notula.speakers.onStatusChanged((s) => {
      if (alive) setStatus(s)
    })
    const offPeople = window.notula.speakerPeople.onChanged(refresh)
    refresh()
    return () => {
      alive = false
      offStatus()
      offPeople()
    }
  }, [])
  return status
}

function ForgetDialog({ onClose }: { onClose(): void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const forget = (): void => {
    setBusy(true)
    window.notula.speakerPeople
      .list({})
      .then((rows) => {
        const self = rows.find((r) => r.isSelf)?.personId
        if (!self) throw new Error(S.couldnt('forget your voice'))
        return window.notula.speakerPeople.forgetVoice({ personId: self, reason: 'forget', confirmed: true })
      })
      .then(() => showToast({ title: S.toastForgotMine() }))
      .catch((err: unknown) => showToast({ title: errorText(err, S.couldnt('forget your voice')), kind: 'error' }))
      .finally(() => {
        setBusy(false)
        onClose()
      })
  }
  return (
    <Modal label={S.yourVoiceForgetTitle()} onClose={onClose}>
      <div className="h-modal__body vp-record">
        <h2 className="h-modal__title">{S.yourVoiceForgetTitle()}</h2>
        <p className="h-modal__subtitle">{S.yourVoiceForgetBody()}</p>
        <footer className="vp-record__actions">
          <button type="button" className="n-btn n-btn--ghost" data-autofocus disabled={busy} onClick={onClose}>
            {S.cancel()}
          </button>
          <button type="button" className="n-btn n-btn--danger" disabled={busy} onClick={forget}>
            {S.settingsForgetMyVoice()}
          </button>
        </footer>
      </div>
    </Modal>
  )
}

export function YourVoiceRows(): JSX.Element | null {
  const prefs = usePrefs()
  const status = useSpeakersStatus()
  const [dialog, setDialog] = useState<'record' | 'forget' | null>(null)
  if (!prefs || !status) return null
  const on = prefs['speakers.selfVoice']
  const self = status.self
  const modelReady = status.model.state === 'ready' || status.model.state === 'mismatch'
  const description = self.present ? samplesLine(self) : status.movedFromLabs ? S.settingsRecordNewSample() : modelReady ? S.yourVoiceNoSample() : S.yourVoiceNeedsModel()
  return (
    <>
      <SettingsRow
        title={S.settingsYourVoice()}
        description={description}
        control={
          <div className="vp-actions">
            {self.present ? (
              <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setDialog('forget')}>
                {S.settingsForgetMyVoice()}
              </button>
            ) : null}
            <button type="button" className="n-btn n-btn--sm" disabled={!modelReady} onClick={() => setDialog('record')}>
              {S.settingsRecordMyVoice()}
            </button>
          </div>
        }
      />
      <SettingsRow
        title={S.settingsKeepImproving()}
        description={S.settingsKeepImprovingDetail()}
        control={
          <Switch
            label={S.settingsKeepImproving()}
            checked={on && prefs['speakers.selfPassive']}
            disabled={!on}
            onChange={(next) => setPrefs({ 'speakers.selfPassive': next })}
          />
        }
      />
      {dialog === 'record' ? <RecordDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'forget' ? <ForgetDialog onClose={() => setDialog(null)} /> : null}
    </>
  )
}
