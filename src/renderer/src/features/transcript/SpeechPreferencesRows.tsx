// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Preferences: the speech rows. "Separate speakers
// (on-device)" turns diarization on (off by
// default) and fetches its model; the multi-language rows pick each cloud provider's
// multilingual model (settings, not flags).

import type { JSX } from 'react'
import { MULTI_LANGUAGE_SETS } from '@shared/types/languages'
import type { AssemblyAiMultilingualModel, DeepgramMultilingualVersion } from '@shared/types/settings'
import { showToast } from '../../app/toast'
import { SettingsCard, SettingsRow } from '../settings'
import { SpeechSwitch } from './LocalAsrSettings'
import { formatBytes, setSpeechPrefs, useLocalModelState, useSpeechPrefs } from './speech-state'
import './speech.css'

const DIARIZATION_MODEL = 'diarization-en' as const

function NativeSelect<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange(v: T): void
}): JSX.Element {
  return (
    <span className="settings-select nt-sp-select">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  )
}

export function SpeechPreferencesRows(): JSX.Element {
  const prefs = useSpeechPrefs()
  const model = useLocalModelState(DIARIZATION_MODEL)
  const on = prefs?.['transcription.diarization'] ?? false

  const download = async (): Promise<void> => {
    try {
      await window.notula.asr.downloadLocalModel({ modelId: DIARIZATION_MODEL })
    } catch {
      showToast({ id: 'diarization-download', kind: 'error', title: 'Couldn’t start the model download. Try again.' })
    }
  }

  const toggle = (next: boolean): void => {
    setSpeechPrefs({ 'transcription.diarization': next })
    if (next && model && model.state !== 'ready' && model.state !== 'downloading') void download()
  }

  let modelLine = ''
  if (on && model) {
    if (model.state === 'downloading') {
      modelLine = ` Downloading the speaker models: ${formatBytes(model.receivedBytes)} of ${formatBytes(model.totalBytes)}.`
    } else if (model.state === 'missing') modelLine = ` The speaker models (${formatBytes(model.totalBytes)}) download first.`
    else if (model.state === 'error') modelLine = ' The speaker models didn’t download. Try again.'
  }

  const deepgramVersion = prefs?.['asr.deepgram.multilingualVersion'] ?? 'default'
  const assemblyModel = prefs?.['asr.assemblyai.multilingualModel'] ?? 'universal-3-5-pro'

  return (
    <SettingsCard title="Speech" description="How meetings are transcribed and who said what.">
      <SettingsRow
        title="Separate speakers (on-device)"
        description={`After a meeting, labels each voice as Speaker A, Speaker B, and so on. It runs on this computer and never sends audio anywhere.${modelLine}`}
        control={
          <span className="nt-sp-actions">
            {on && (model?.state === 'error' || model?.state === 'missing') && (
              <button type="button" className="n-btn n-btn--sm" onClick={() => void download()}>
                {model.state === 'error' ? 'Try again' : 'Download'}
              </button>
            )}
            <SpeechSwitch label="Separate speakers (on-device)" checked={on} disabled={!prefs} onChange={toggle} />
          </span>
        }
      />
      <SettingsRow
        title="Multi-language model (Deepgram)"
        description="Used when the transcription language is Multi-language."
        control={
          <NativeSelect<DeepgramMultilingualVersion>
            label="Deepgram multi-language model"
            value={deepgramVersion}
            options={[
              { value: 'default', label: `Nova-3 (${MULTI_LANGUAGE_SETS['nova-3'].length} languages)` },
              { value: '58-lang-beta', label: `Nova-3, more languages (${MULTI_LANGUAGE_SETS['nova-3-mega'].length}, beta)` }
            ]}
            onChange={(v) => setSpeechPrefs({ 'asr.deepgram.multilingualVersion': v })}
          />
        }
      />
      <SettingsRow
        title="Multi-language model (AssemblyAI)"
        description="Used when the transcription language is Multi-language."
        control={
          <NativeSelect<AssemblyAiMultilingualModel>
            label="AssemblyAI multi-language model"
            value={assemblyModel}
            options={[
              { value: 'universal-3-5-pro', label: 'Universal 3.5 Pro' },
              { value: 'universal-3-6-pro', label: 'Universal 3.6 Pro' }
            ]}
            onChange={(v) => setSpeechPrefs({ 'asr.assemblyai.multilingualModel': v })}
          />
        }
      />
    </SettingsCard>
  )
}
