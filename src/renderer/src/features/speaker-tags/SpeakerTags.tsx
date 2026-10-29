// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Speaker tags and its Preferences row: the feature's home,
// master switches only. Everything about one person lives on the person page.
//
// - Naming: Names from meeting apps (the master over the three app switches, each with its live
//   status from `attribution:get-status` / `attribution:status-changed`; Windows only, macOS
//   shows the rows disabled with "Coming later on macOS"), and Suggest names from the
//   conversation, with the transfer note under it when the step would reach a cloud service
//   (main's rule, `speakers:get-status` `llmCloud`).
// - Voices: Recognize my voice with the Your voice rows, Recognize voices with the retention
//   line, People with a remembered voice and Forget all voices. A voice row that can't run says
//   why and offers the fix; turning one on shows the model's size and licence before the
//   `speaker-id` download starts. Turning one off asks whether to forget, forgetting first.
// - Notices: the participant notice in English and Portuguese, and the meeting-notice line.
// - Advanced: the Meet selector editor.

import { useCallback, useEffect, useState, type JSX } from 'react'
import type { Settings } from '@shared/types/settings'
import type { SpeakersStatus } from '@shared/types/speakers'
import type { MeetSelectors } from '@shared/types/transcript'
import { DEFAULT_MEET_SELECTORS, type AttributionApp, type AttributionAppStatus, type AttributionStatus } from '@shared/types/transcript'
import { navigate, navigateToSettings } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { SettingsCard, SettingsRow } from '../settings'
import { addChatNoticeLine, copyParticipantNotice, LanguageMenuButton, SpDialog } from '../speaker-profiles'
import * as S from '../speaker-profiles/strings'
import { SpeechSwitch } from '../transcript/LocalAsrSettings'
import { formatBytes, setSpeechPrefs, useLocalModelState, useSpeechPrefs } from '../transcript/speech-state'
import { YourVoiceRows } from '../voiceprint'
import './speaker-tags.css'

const APP_LABEL: Record<AttributionApp, string> = { zoom: 'Zoom', teams: 'Microsoft Teams', meet: 'Google Meet in Chrome' }
const SETTING = { zoom: 'attribution.zoom', teams: 'attribution.teams', meet: 'attribution.meet' } as const
const CLASS_NAME = /^[A-Za-z0-9_-]{1,64}$/
/** The identification model's size before its state has loaded (28,281,164 bytes). */
const SPEAKER_ID_BYTES = 28_281_164

type VoiceKey = 'speakers.voices' | 'speakers.selfVoice'

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

/** `speakers:get-status`, kept current; null until it first answers. */
function useSpeakersStatus(): SpeakersStatus | null {
  const [status, setStatus] = useState<SpeakersStatus | null>(null)
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      window.notula.speakers.getStatus().then(
        (s) => {
          if (alive) setStatus(s)
        },
        () => undefined
      )
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

/** Speaker tags reads Enabled when any naming layer is on; Separate speakers alone doesn't count. */
export function speakerTagsEnabled(prefs: Settings | null, windows: boolean): boolean {
  if (!prefs) return false
  const apps = windows && prefs['speakers.appNames'] && (prefs['attribution.zoom'] || prefs['attribution.teams'] || prefs['attribution.meet'])
  return !!apps || prefs['speakerNames.suggestions'] || prefs['speakers.voices'] || prefs['speakers.selfVoice']
}

type Ask = { kind: 'model'; key: VoiceKey } | { kind: 'forget-others' } | { kind: 'forget-mine' } | { kind: 'forget-all' }

/**
 * "Your voice moved here from Labs" shows on one visit of this page, then never again: the
 * flag is set when that visit ends. A per-profile convenience, so a lost flag only shows it once more.
 */
const LABS_LINE_SEEN_KEY = 'notula.speakers.labsLineSeen'

function readLabsLineSeen(): boolean {
  try {
    return localStorage.getItem(LABS_LINE_SEEN_KEY) === '1'
  } catch {
    return false
  }
}

function writeLabsLineSeen(): void {
  try {
    localStorage.setItem(LABS_LINE_SEEN_KEY, '1')
  } catch {
    // A convenience only.
  }
}

/** The voice rows, People with a remembered voice and Forget all voices. */
function SpeakerTagsVoiceSlot({ prefs }: { prefs: Settings | null }): JSX.Element {
  const status = useSpeakersStatus()
  const idModel = useLocalModelState('speaker-id')
  const sepModel = useLocalModelState('diarization-en')
  const [ask, setAsk] = useState<Ask | null>(null)
  const close = useCallback(() => setAsk(null), [])
  // Read once, so the line stays for the whole visit that shows it.
  const [labsLineSeen] = useState(readLabsLineSeen)

  const voices = prefs?.['speakers.voices'] ?? false
  const selfVoice = prefs?.['speakers.selfVoice'] ?? false
  const separation = prefs?.['transcription.diarization'] ?? false
  const idReady = idModel?.state === 'ready'
  const idBusy = idModel?.state === 'downloading'
  const sepReady = sepModel?.state === 'ready'
  const idBytes = idModel?.totalBytes || SPEAKER_ID_BYTES

  const download = (withSeparation: boolean): void => {
    const start = (modelId: 'speaker-id' | 'diarization-en'): void => {
      window.notula.asr.downloadLocalModel({ modelId }).catch((err: unknown) => {
        debugLog('speaker-model-download-failed', { modelId, err: String(err).slice(0, 200) })
        showToast({ id: `speaker-model-${modelId}`, kind: 'error', title: 'Couldn’t start the model download. Try again.' })
      })
    }
    if (!idReady && !idBusy) start('speaker-id')
    if (withSeparation && sepModel && sepModel.state !== 'ready' && sepModel.state !== 'downloading') start('diarization-en')
  }

  /** On: the model's size and licence come first while it isn't installed. */
  const turnOn = (key: VoiceKey): void => {
    if (idReady || idBusy) setSpeechPrefs({ [key]: true })
    else setAsk({ kind: 'model', key })
  }

  const turnOff = async (key: VoiceKey): Promise<void> => {
    setSpeechPrefs({ [key]: false })
    // Main deletes the cluster vectors itself; forgetting the remembered voices is a question,
    // asked while anyone has a voice or an active agreement.
    const s = status ?? (await window.notula.speakers.getStatus().catch(() => null))
    if (!s) return
    if (key === 'speakers.voices' && (s.peopleWithVoice > 0 || (s.peopleWithAgreement ?? 0) > 0)) setAsk({ kind: 'forget-others' })
    if (key === 'speakers.selfVoice' && s.self.present) setAsk({ kind: 'forget-mine' })
  }

  const forgetOthers = async (): Promise<void> => {
    close()
    try {
      await window.notula.speakers.forgetAll({ confirmed: true, keepSelf: true })
      showToast({ kind: 'success', title: S.toastForgotOthers() })
    } catch {
      showToast({ kind: 'error', title: S.couldnt('forget the voices') })
    }
  }

  const forgetMine = async (): Promise<void> => {
    close()
    try {
      const self = (await window.notula.speakerPeople.list({})).find((r) => r.isSelf && r.personId)
      if (self?.personId) await window.notula.speakerPeople.forgetVoice({ personId: self.personId, reason: 'forget', confirmed: true })
      showToast({ kind: 'success', title: S.toastForgotMine() })
    } catch {
      showToast({ kind: 'error', title: S.couldnt('forget your voice') })
    }
  }

  const forgetAll = async (): Promise<void> => {
    close()
    try {
      await window.notula.speakers.forgetAll({ confirmed: true })
      showToast({ kind: 'success', title: S.toastForgotAll() })
    } catch {
      showToast({ kind: 'error', title: S.couldnt('forget the voices') })
    }
  }

  /** Why a voice row that is on can't run yet, and the fix. */
  const blocked = (on: boolean): { line: string; fix: JSX.Element | null } | null => {
    if (!on) return null
    if (!separation) {
      return {
        line: S.settingsNeedsSeparation(),
        fix: (
          <button
            type="button"
            className="n-btn n-btn--sm"
            onClick={() => {
              setSpeechPrefs({ 'transcription.diarization': true })
              download(true)
            }}
          >
            {S.settingsTurnOnSeparation()}
          </button>
        )
      }
    }
    const m = idModel?.state === 'downloading' ? idModel : sepModel?.state === 'downloading' ? sepModel : null
    if (m?.state === 'downloading') {
      const done = m.totalBytes > 0 && m.receivedBytes >= m.totalBytes
      return { line: done ? S.settingsModelInstalling() : S.settingsModelDownloading(formatBytes(m.receivedBytes), formatBytes(m.totalBytes)), fix: null }
    }
    if (idModel?.state === 'error' || sepModel?.state === 'error') {
      return {
        line: S.settingsModelFailed(),
        fix: (
          <button type="button" className="n-btn n-btn--sm" onClick={() => download(true)}>
            {S.settingsTryAgain()}
          </button>
        )
      }
    }
    if (idModel && sepModel && (!idReady || !sepReady)) {
      const bytes = (idReady ? 0 : idBytes) + (sepReady ? 0 : sepModel.totalBytes)
      return {
        line: sepReady ? S.settingsNeedsModel(formatBytes(bytes)) : S.settingsNeedsModels(formatBytes(bytes)),
        fix: (
          <button type="button" className="n-btn n-btn--sm" onClick={() => download(true)}>
            {S.settingsDownload()}
          </button>
        )
      }
    }
    if (status?.model.state === 'mismatch') return { line: S.settingsModelMismatch(), fix: null }
    return null
  }

  const voiceRow = (key: VoiceKey, title: string, detail: string): JSX.Element => {
    const on = key === 'speakers.voices' ? voices : selfVoice
    const why = blocked(on)
    return (
      <SettingsRow
        title={title}
        description={why ? why.line : detail}
        control={
          <span className="nt-st-actions">
            {why?.fix}
            <SpeechSwitch label={title} checked={on} disabled={!prefs} onChange={(next) => (next ? turnOn(key) : void turnOff(key))} />
          </span>
        }
      />
    )
  }

  // Agreement records alone count too: Forget all stamps them `forget_all`.
  const showForgetAll =
    voices || selfVoice || (status ? status.peopleWithVoice > 0 || (status.peopleWithAgreement ?? 0) > 0 || status.self.present : false)
  const showLabsLine = !!status?.movedFromLabs && !voices && !labsLineSeen
  useEffect(() => (showLabsLine ? writeLabsLineSeen : undefined), [showLabsLine])

  return (
    <SettingsCard title={S.settingsVoicesCard()} description={S.settingsVoicesCardDescription()}>
      {showLabsLine ? (
        <SettingsRow
          title={S.settingsMovedFromLabs()}
          description={S.settingsMovedFromLabsDetail()}
          control={
            <button type="button" className="n-btn n-btn--sm" onClick={() => turnOn('speakers.voices')}>
              {S.settingsTurnOnVoices()}
            </button>
          }
        />
      ) : null}
      {voiceRow('speakers.selfVoice', S.settingsRecognizeMyVoice(), S.settingsRecognizeMyVoiceDetail())}
      <div className="nt-st-sub">
        <YourVoiceRows />
      </div>
      {voiceRow('speakers.voices', S.settingsRecognizeVoices(), S.settingsRecognizeVoicesDetail())}
      <p className="nt-st-note">{S.settingsRetentionLine()}</p>
      <SettingsRow
        title={S.settingsPeopleWithVoice()}
        description={status ? S.settingsPeopleWithVoiceCount(status.peopleWithVoice) : undefined}
        onClick={() => navigate('/people?filter=voice')}
        control={<span className="nt-st-chevron">{S.settingsOpen()}</span>}
      />
      {showForgetAll ? (
        <SettingsRow
          title={S.settingsForgetAllVoices()}
          description={S.settingsForgetAllDetail()}
          control={
            <button type="button" className="n-btn n-btn--sm n-btn--danger" onClick={() => setAsk({ kind: 'forget-all' })}>
              {S.forgetAllButton()}
            </button>
          }
        />
      ) : null}

      {ask?.kind === 'model' ? (
        <SpDialog
          title={S.modelDialogTitle()}
          onClose={close}
          actions={[
            { label: S.cancel(), onClick: close },
            {
              label: S.modelDialogConfirm(),
              kind: 'primary',
              autoFocus: true,
              onClick: () => {
                setSpeechPrefs({ [ask.key]: true })
                download(separation)
                close()
              }
            }
          ]}
        >
          <p>{S.modelDialogBody(formatBytes(idBytes))}</p>
        </SpDialog>
      ) : null}
      {ask?.kind === 'forget-others' ? (
        <SpDialog
          title={S.settingsAlsoForgetOthers()}
          onClose={close}
          actions={[
            { label: S.settingsKeep(), onClick: close },
            { label: S.settingsForgetVoices(), kind: 'danger', autoFocus: true, onClick: () => void forgetOthers() }
          ]}
        >
          <p>{S.settingsAlsoForgetOthersBody()}</p>
        </SpDialog>
      ) : null}
      {ask?.kind === 'forget-mine' ? (
        <SpDialog
          title={S.settingsAlsoForgetMine()}
          onClose={close}
          actions={[
            { label: S.settingsKeep(), onClick: close },
            { label: S.settingsForgetMyVoice(), kind: 'danger', autoFocus: true, onClick: () => void forgetMine() }
          ]}
        >
          <p>{S.settingsAlsoForgetMineBody()}</p>
        </SpDialog>
      ) : null}
      {ask?.kind === 'forget-all' ? (
        <SpDialog
          title={S.forgetAllTitle()}
          onClose={close}
          actions={[
            { label: S.cancel(), onClick: close, autoFocus: true },
            { label: S.forgetAllConfirm(), kind: 'danger', onClick: () => void forgetAll() }
          ]}
        >
          <p>{S.forgetAllBody()}</p>
        </SpDialog>
      ) : null}
    </SettingsCard>
  )
}

/** Copy a notice for participants, and Add a line about speaker names to the meeting notice. */
function SpeakerTagsNoticeSlot({ prefs }: { prefs: Settings | null }): JSX.Element {
  return (
    <SettingsCard>
      <SettingsRow
        title={S.settingsCopyParticipantNotice()}
        description={S.settingsParticipantNoticeDetail()}
        control={
          <span className="nt-st-actions">
            <button type="button" className="n-btn n-btn--sm" onClick={() => void copyParticipantNotice('en')}>
              {S.languageEnglish()}
            </button>
            <button type="button" className="n-btn n-btn--sm" onClick={() => void copyParticipantNotice('pt')}>
              {S.languagePortuguese()}
            </button>
          </span>
        }
      />
      {prefs?.['consent.enabled'] ? (
        <SettingsRow
          title={S.settingsAddChatNoticeLine()}
          description={S.settingsChatNoticeLineDetail()}
          control={<LanguageMenuButton label={S.settingsAdd()} onPick={(l) => void addChatNoticeLine(l)} />}
        />
      ) : null}
    </SettingsCard>
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
  const speakers = useSpeakersStatus()
  const appNames = prefs?.['speakers.appNames'] ?? true
  const suggestions = prefs?.['speakerNames.suggestions'] ?? false
  const paused = !!prefs && prefs['llm.provider'] !== 'local' && !!prefs['privacy.localOnly']
  return (
    <>
      <SettingsCard title={S.settingsTitle()} description={S.settingsNamingDescription()}>
        <SettingsRow
          title={S.settingsAppNames()}
          description={supported ? S.settingsAppNamesDetail() : 'Coming later on macOS'}
          control={
            <SpeechSwitch
              label={S.settingsAppNames()}
              checked={supported && appNames}
              disabled={!prefs || !supported}
              onChange={(next) => setSpeechPrefs({ 'speakers.appNames': next })}
            />
          }
        />
        <div className={`nt-st-sub${supported && appNames ? '' : ' is-off'}`}>
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
                  disabled={!prefs || !supported || !appNames}
                  onChange={(next) => setSpeechPrefs({ [SETTING[app]]: next })}
                />
              }
            />
          ))}
        </div>
        <SettingsRow
          title={S.settingsSuggestNames()}
          description={paused ? S.settingsSuggestLocalOnly() : S.settingsSuggestNamesDetail()}
          control={
            <SpeechSwitch
              label={S.settingsSuggestNames()}
              checked={suggestions}
              disabled={!prefs}
              onChange={(next) => setSpeechPrefs({ 'speakerNames.suggestions': next })}
            />
          }
        />
        {suggestions && speakers?.llmCloud === true ? <p className="nt-st-note">{S.settingsTransferNote()}</p> : null}
      </SettingsCard>
      <SpeakerTagsVoiceSlot prefs={prefs} />
      <SpeakerTagsNoticeSlot prefs={prefs} />
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
  const on = speakerTagsEnabled(prefs, navigator.userAgent.includes('Windows'))
  return (
    <SettingsCard>
      <SettingsRow
        title={S.settingsTitle()}
        description={S.preferencesRowDetail()}
        onClick={() => navigateToSettings('speaker-tags')}
        control={<span className="nt-st-chevron">{on ? S.enabled() : S.off()}</span>}
      />
    </SettingsCard>
  )
}
