// SPDX-License-Identifier: Apache-2.0
// Settings ▸ AI, in the transcription block: on-device transcription and its speech
// models.
// Choosing on-device is enabled once a model is ready. Each model is its own
// download, started only by the user, with its languages, size, licence and
// attribution. Whisper large-v3-turbo is the recommended one, listed first with a
// one-click "Download and use".

import { useState, type JSX } from 'react'
import type { Settings } from '@shared/types/settings'
import {
  LOCAL_ASR_MODELS,
  localAsrModelInfo,
  type CloudAsrProviderId,
  type LocalAsrChoice,
  type LocalAsrModelId,
  type LocalAsrModelInfo,
  type LocalModelState
} from '@shared/types/transcript'
import { showToast } from '../../app/toast'
import { SettingsRow } from '../settings'
import { SpeechDialog } from './SpeechDialog'
import { downloadAndUse, errorText, formatBytes, setSpeechPrefs, useLocalAsrStates, useSpeechPrefs } from './speech-state'
import './speech.css'

/** The cloud provider to go back to when on-device is turned off or uninstalled. */
let lastCloud: CloudAsrProviderId = 'deepgram'

export const MODEL_LICENCES =
  'Speech models: OpenAI Whisper large-v3-turbo (MIT); NVIDIA Parakeet TDT 0.6B v3 and Parakeet TDT 110M (CC BY 4.0); ' +
  'all converted for sherpa-onnx by the k2-fsa project. ' +
  'Speaker separation: pyannote segmentation-3.0 (MIT, © CNRS) and the WeSpeaker ResNet-34 VoxCeleb model (CC BY 4.0, the WeSpeaker project).'

export function SpeechSwitch({
  label,
  checked,
  disabled,
  onChange
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange(next: boolean): void
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="settings-switch nt-sp-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="settings-switch__thumb" />
    </button>
  )
}

function ModelRow({
  info,
  state,
  prefs,
  onRemove
}: {
  info: LocalAsrModelInfo
  state: LocalModelState | undefined
  prefs: Settings | null
  onRemove(): void
}): JSX.Element {
  const size = formatBytes(state?.totalBytes ?? 0)
  const inUse = prefs?.['asr.provider'] === 'local' && prefs['asr.local.model'] === info.id

  const download = async (andUse: boolean): Promise<void> => {
    try {
      if (andUse) await downloadAndUse(info.id)
      else await window.notula.asr.downloadLocalModel({ modelId: info.id })
    } catch {
      showToast({ id: `local-asr-download-${info.id}`, kind: 'error', title: 'Couldn’t start the model download. Try again.' })
    }
  }

  let status = ''
  let actions: JSX.Element | null = null
  switch (state?.state) {
    case 'missing':
      status = `${size} to download.`
      actions = info.recommended ? (
        <>
          <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => void download(true)}>
            Download and use
          </button>
        </>
      ) : (
        <button type="button" className="n-btn n-btn--sm" onClick={() => void download(false)}>
          Download
        </button>
      )
      break
    case 'downloading':
      // Every byte in: the files are being unpacked and checked, which takes some seconds
      // and would otherwise look like a stalled download.
      status =
        state.totalBytes > 0 && state.receivedBytes >= state.totalBytes
          ? 'Installing…'
          : `Downloading ${formatBytes(state.receivedBytes)} of ${formatBytes(state.totalBytes)}`
      break
    case 'ready':
      status = inUse ? 'Downloaded. In use for your meetings.' : 'Downloaded. Not in use right now.'
      actions = (
        <>
          {inUse ? null : (
            <button
              type="button"
              className="n-btn n-btn--sm"
              onClick={() => setSpeechPrefs({ 'asr.provider': 'local', 'asr.local.model': info.id })}
            >
              Use
            </button>
          )}
          <button type="button" className="n-btn n-btn--sm" onClick={onRemove}>
            Remove
          </button>
        </>
      )
      break
    case 'error':
      status = 'The download didn’t finish.'
      actions = (
        <button type="button" className="n-btn n-btn--sm" onClick={() => void download(info.recommended)}>
          Try again
        </button>
      )
      break
    default:
      status = 'Checking…'
  }

  const percent = state?.state === 'downloading' && state.totalBytes ? Math.min(100, (state.receivedBytes / state.totalBytes) * 100) : 0

  return (
    <div className="nt-sp-model">
      <div className="nt-sp-model__head">
        <div className="nt-sp-model__text">
          <div className="nt-sp-model__name">
            {info.name}
            {info.recommended ? <span className="nt-sp-badge">Recommended</span> : null}
          </div>
          <div className="nt-sp-model__meta">
            {info.languageSummary} · {size} · {info.licence}
          </div>
          <div className="nt-sp-model__status">{status}</div>
        </div>
        {actions ? <span className="nt-sp-actions">{actions}</span> : null}
      </div>
      {state?.state === 'downloading' && (
        <div
          className="nt-sp-progress"
          role="progressbar"
          aria-label={`${info.name} download`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <div className="nt-sp-progress__bar" style={{ width: `${percent}%` }} />
        </div>
      )}
      {state?.state === 'error' && <div className="nt-sp-model__error">{state.message}</div>}
      <div className="nt-sp-model__fine">{info.attribution}</div>
    </div>
  )
}

export function LocalAsrSettings(): JSX.Element {
  const prefs = useSpeechPrefs()
  const states = useLocalAsrStates()
  const [dialog, setDialog] = useState<'learn' | null>(null)
  const [removing, setRemoving] = useState<LocalAsrModelId | null>(null)
  const [busy, setBusy] = useState(false)
  const provider = prefs?.['asr.provider']
  if (provider && provider !== 'local') lastCloud = provider
  const on = provider === 'local'
  const installed = LOCAL_ASR_MODELS.filter((m) => states[m.id]?.state === 'ready')
  const choice = prefs?.['asr.local.model'] ?? 'auto'

  const remove = async (id: LocalAsrModelId): Promise<void> => {
    setBusy(true)
    try {
      await window.notula.asr.deleteLocalModel({ modelId: id })
      const left = installed.filter((m) => m.id !== id)
      // If no models are left while on-device is on, switch back to the last cloud provider.
      if (on && !left.length) setSpeechPrefs({ 'asr.provider': lastCloud, 'asr.local.model': 'auto' })
      else if (choice === id) setSpeechPrefs({ 'asr.local.model': 'auto' })
      setRemoving(null)
      showToast({ id: 'local-asr-uninstall', kind: 'success', title: 'Speech model removed' })
    } catch (err) {
      showToast({ id: 'local-asr-uninstall', kind: 'error', title: `Could not remove the speech model: ${errorText(err)}` })
    } finally {
      setBusy(false)
    }
  }

  const choiceOptions: { value: LocalAsrChoice; label: string }[] = [
    { value: 'auto', label: 'Automatic, by language' },
    ...installed.map((m) => ({ value: m.id, label: m.name }))
  ]
  if (choice !== 'auto' && !installed.some((m) => m.id === choice)) {
    choiceOptions.push({ value: choice, label: `${localAsrModelInfo(choice).name} (not downloaded)` })
  }
  const prefer = prefs?.['asr.local.prefer'] ?? 'accuracy'
  const multilingualInstalled = installed.filter((m) => m.languages.includes('multi'))

  return (
    <>
      <SettingsRow
        title="On-device transcription"
        description="Transcribe meetings on this computer instead of sending audio to a cloud service. It needs a one-time model download."
        control={
          <SpeechSwitch
            label="On-device transcription"
            checked={on}
            disabled={!prefs || (!on && !installed.length)}
            onChange={(next) => setSpeechPrefs({ 'asr.provider': next ? 'local' : lastCloud })}
          />
        }
      />
      {installed.length ? (
        <SettingsRow
          title="Speech model"
          description={
            choice === 'auto'
              ? 'English meetings use the English model when it is downloaded; other languages use a multilingual model.'
              : 'Every meeting uses this model, whatever its language.'
          }
          control={
            <span className="settings-select nt-sp-select">
              <select
                aria-label="Speech model"
                value={choice}
                disabled={!prefs}
                onChange={(e) => setSpeechPrefs({ 'asr.local.model': e.target.value as LocalAsrChoice })}
              >
                {choiceOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </span>
          }
        />
      ) : null}
      {choice === 'auto' && multilingualInstalled.length > 1 ? (
        <SettingsRow
          title="Other languages"
          description="Which multilingual model Automatic prefers."
          control={
            <span className="settings-select nt-sp-select">
              <select
                aria-label="Other languages"
                value={prefer}
                onChange={(e) => setSpeechPrefs({ 'asr.local.prefer': e.target.value as 'accuracy' | 'speed' })}
              >
                <option value="accuracy">Most accurate (Whisper)</option>
                <option value="speed">Faster (Parakeet v3)</option>
              </select>
            </span>
          }
        />
      ) : null}
      <div className="nt-sp-models" aria-label="Speech models">
        {LOCAL_ASR_MODELS.map((m) => (
          <ModelRow key={m.id} info={m} state={states[m.id]} prefs={prefs} onRemove={() => setRemoving(m.id)} />
        ))}
      </div>
      <SettingsRow
        title="About on-device models"
        description="Downloads start only when you choose one. Each is checked against its published fingerprint."
        control={
          <button type="button" className="nt-sp-link" onClick={() => setDialog('learn')}>
            Learn more
          </button>
        }
      />

      {removing && (
        <SpeechDialog
          title={`Remove ${localAsrModelInfo(removing).name}?`}
          onClose={() => !busy && setRemoving(null)}
          footer={
            <>
              <button type="button" className="n-btn" disabled={busy} onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button type="button" className="n-btn nt-sp-danger" disabled={busy} onClick={() => void remove(removing)}>
                {busy ? 'Removing...' : 'Remove'}
              </button>
            </>
          }
        >
          <p>
            This frees {formatBytes(states[removing]?.totalBytes ?? 0)} on this device.
            {installed.length <= 1 && on ? 'On-device transcription turns off.' : ''} You can download it again later.
          </p>
        </SpeechDialog>
      )}
      {dialog === 'learn' && (
        <SpeechDialog
          title="On-device transcription"
          onClose={() => setDialog(null)}
          footer={
            <button type="button" className="n-btn n-btn--primary" onClick={() => setDialog(null)}>
              Got it
            </button>
          }
        >
          <h3 className="nt-sp-dialog__heading">Benefits</h3>
          <ul className="nt-sp-list">
            <li>Works with no internet</li>
            <li>Uses almost no network data</li>
            <li>Audio stays on your computer</li>
          </ul>
          <h3 className="nt-sp-dialog__heading">Drawbacks</h3>
          <ul className="nt-sp-list">
            <li>Whisper uses more of your computer’s power than cloud transcription</li>
            <li>Needs a large one-time model download</li>
            <li>Can be less accurate than cloud transcription</li>
          </ul>
          <p className="nt-sp-fine">{MODEL_LICENCES}</p>
        </SpeechDialog>
      )}
    </>
  )
}
