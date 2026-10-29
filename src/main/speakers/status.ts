// SPDX-License-Identifier: Apache-2.0
// `speakers:get-status` and `speakers:status-changed`: the two voice
// layers, the identification model, the self voice, the counts and `movedFromLabs`.
//
// - A voice layer is `off` while its switch is; `needs-separation` while Separate speakers is
//   off or its model isn't installed (no pass, so no clusters to recognize); `needs-model`
//   while the `speaker-id` extractor isn't ready; else `ready`. A calibration that names
//   another extractor shows on the model (`mismatch`), not on the layers.
// - `calibration.autoConditions` is a count, never the thresholds, and 0 while the file
//   doesn't apply to the installed extractor.
// - The push follows the switches, the two models' states and the voice tables, debounced.
//   No vector or score is read here.

import { ipcMain } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel } from '@shared/ipc'
import type { SettingKey } from '@shared/types/settings'
import type { SpeakerVoiceLayerState, SpeakersStatus } from '@shared/types/speakers'
import { getLocalModels } from '../asr/instance'
import { speakerIdModelId } from '../asr/manifest'
import { speakerModelState } from '../asr/models'
import type { MainContext } from '../context'
import { log } from '../log'
import { getCalibration } from './calibration'
import { llmReachesCloud } from './notice'

const SETTING_KEYS: readonly SettingKey[] = [
  'speakers.voices',
  'speakers.selfVoice',
  'transcription.diarization',
  'llm.provider',
  'llm.openai.baseUrl',
  'llm.local.baseUrl',
  'privacy.localOnly'
]
const TABLES: readonly string[] = ['speaker_exemplars', 'speaker_people', 'speaker_agreements', 'voiceprints']
const MODELS: readonly string[] = ['speaker-id', 'diarization-en']
const PUSH_DEBOUNCE_MS = 250

export async function speakersStatus(ctx: MainContext): Promise<SpeakersStatus> {
  const models = getLocalModels(ctx)
  const settings = await ctx.settings.getAll()
  const calibration = getCalibration(ctx)
  const model = models.stateNow('speaker-id')
  const separation = settings['transcription.diarization'] && models.isReady('diarization-en')
  const layer = (on: boolean): SpeakerVoiceLayerState => (!on ? 'off' : !separation ? 'needs-separation' : model.state !== 'ready' ? 'needs-model' : 'ready')
  const summary = await ctx.storage.speakerVoiceSummary({ modelId: speakerIdModelId() }).catch((err: unknown) => {
    log('warn', 'speakers:status-summary-failed', { err: err instanceof Error ? err.message : String(err) })
    return { peopleWithVoice: 0, peopleWithAgreement: 0, self: { present: false, sampleCount: 0, updatedAt: null }, movedFromLabs: false }
  })
  return {
    voices: layer(settings['speakers.voices']),
    selfVoice: layer(settings['speakers.selfVoice']),
    model: {
      state: speakerModelState(model, calibration.file?.modelSha ?? null),
      totalBytes: model.totalBytes,
      receivedBytes: model.state === 'downloading' ? model.receivedBytes : model.state === 'ready' ? model.totalBytes : 0
    },
    self: summary.self,
    peopleWithVoice: summary.peopleWithVoice,
    peopleWithAgreement: summary.peopleWithAgreement,
    calibration: {
      present: calibration.file !== null,
      autoConditions: calibration.voice ? calibration.file.conditions.filter((c) => c.autoEnabled).length : 0
    },
    movedFromLabs: summary.movedFromLabs,
    llmCloud: await llmReachesCloud(ctx).catch(() => true)
  }
}

export function registerSpeakerStatus(ctx: MainContext): void {
  let timer: NodeJS.Timeout | null = null
  const push = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      void speakersStatus(ctx)
        .then((s) => {
          for (const wc of ctx.windows.targets()) wc.send('speakers:status-changed' satisfies PushChannel, s)
        })
        .catch((err: unknown) => log('warn', 'speakers:status-push-failed', { err: err instanceof Error ? err.message : String(err) }))
    }, PUSH_DEBOUNCE_MS)
    timer.unref()
  }

  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.some((k) => SETTING_KEYS.includes(k))) push()
  })
  ctx.bus.on('storage:changed', (c) => {
    if (c.tables.some((t) => TABLES.includes(t))) push()
  })
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') push()
  })
  getLocalModels(ctx).onState((s) => {
    if (MODELS.includes(s.modelId)) push()
  })

  ipcMain.handle('speakers:get-status' satisfies InvokeChannel, (): Promise<InvokeRes<'speakers:get-status'>> => speakersStatus(ctx))
}
