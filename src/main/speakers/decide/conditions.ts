// SPDX-License-Identifier: Apache-2.0
// The calibration condition of a cluster: channel ×
// language × clean-speech bucket. A condition missing from the file means no voice auto and
// the default suggest rule; only the `>=30s` bucket can carry `autoEnabled`, whatever the file
// says. Pure.

import type {
  SpeakerCalibration,
  SpeakerCalibrationLanguage,
  SpeakerChannel,
  SpeakerCleanBucket,
  SpeakerFusionSignal
} from '@shared/types/speakers'
import { SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import type { SpeakerCalibrationConditionFile, SpeakerCalibrationState } from '../calibration'

export interface DecideCondition {
  /** Found in the file. */
  found: boolean
  autoEnabled: boolean
  tauAuto: number
  tauSuggest: number
  margin: number
  tieMargin: number
  /** Maps a voice score (the max cosine) to log-odds `a·x + b`. */
  logistic: { a: number; b: number }
  /** The unknown option's score, as P(correct): a person is assigned only strictly above it. */
  floor: number
}

export type DecideFusion = Record<SpeakerFusionSignal, { weight: number; offset: number }>

// The default suggest rule: the strictest of the shipped priors, with the default tie margin.
const DEFAULT_TAU_AUTO = 0.97
const DEFAULT_TAU_SUGGEST = 0.85
const DEFAULT_MARGIN = 0.1
const DEFAULT_LOGISTIC: Record<SpeakerChannel, { a: number; b: number }> = {
  mic: { a: 12, b: -6 },
  system: { a: 11, b: -6 }
}
/** P = 0.5: any net positive evidence beats the unknown option; the bands decide what it shows. */
const DEFAULT_FLOOR = 0.5

const DEFAULT_FUSION: DecideFusion = {
  voice: { weight: 1, offset: 0 },
  app: { weight: 1, offset: 0 },
  conversation: { weight: 0.8, offset: 0 },
  elimination: { weight: 0.5, offset: 0 }
}

export function cleanBucket(cleanMs: number): SpeakerCleanBucket {
  if (cleanMs < SPEAKER_PROFILE_LIMITS.voiceSuggestOnlyBelowMs) return '<10s'
  if (cleanMs < SPEAKER_PROFILE_LIMITS.autoMinSpeechMs) return '10-30s'
  return '>=30s'
}

export function conditionFor(
  calibration: SpeakerCalibrationState,
  channel: SpeakerChannel,
  language: SpeakerCalibrationLanguage,
  cleanMs: number
): DecideCondition {
  const bucket = cleanBucket(cleanMs)
  const found = calibration.file?.conditions.find(
    (c) => c.channel === channel && c.language === language && c.bucket === bucket
  ) as SpeakerCalibrationConditionFile | undefined
  if (!found) {
    return {
      found: false,
      autoEnabled: false,
      tauAuto: DEFAULT_TAU_AUTO,
      tauSuggest: DEFAULT_TAU_SUGGEST,
      margin: DEFAULT_MARGIN,
      tieMargin: SPEAKER_PROFILE_LIMITS.defaultTieMargin,
      logistic: DEFAULT_LOGISTIC[channel],
      floor: DEFAULT_FLOOR
    }
  }
  return {
    found: true,
    autoEnabled: found.autoEnabled && bucket === '>=30s',
    tauAuto: found.tauAuto,
    tauSuggest: found.tauSuggest,
    margin: found.margin,
    tieMargin: found.tieMargin,
    logistic: found.logistic,
    floor: found.floor ?? DEFAULT_FLOOR
  }
}

export function fusionOf(file: SpeakerCalibration | null): DecideFusion {
  return file?.fusion ?? DEFAULT_FUSION
}
