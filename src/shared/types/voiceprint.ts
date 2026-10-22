// SPDX-License-Identifier: Apache-2.0
// The local voiceprint that labels the user "Me". No type here ever carries a vector:
// the vectors stay in main.

import type { IsoTime } from './common'

export type VoiceprintClassification = 'online' | 'in_person' | 'unknown'

export interface VoiceprintStatus {
  enabled: boolean
  modelReady: boolean
  passiveEnrolment: boolean
  profile: { present: boolean; totalSpeechMs: number; updatedAt: IsoTime | null; centroidCount: number }
  lastClassification: { noteId: string; value: VoiceprintClassification; at: IsoTime } | null
}

export interface VoiceprintSampleResult {
  enrolled: boolean
  speechMs: number
  reason: 'too-little-speech' | 'not-dominant' | 'cancelled' | 'model-missing' | 'mic-error' | null
}

export interface VoiceprintIdentifyResult {
  action: 'relabelled' | 'skipped'
  labeled: number
  unlabeled: number
  selfMatched: boolean
  reason: 'no-profile' | 'no-audio' | 'too-little-speech' | 'single-speaker' | 'no-match' | null
}

/** The space key; the model is the pinned `diarization-en` speaker model. */
export const VOICEPRINT_MODEL_ID = 'wespeaker-en-voxceleb-resnet34'

export const VOICEPRINT_LIMITS = {
  sampleMs: 30_000,
  onlineSystemSpeechMs: 15_000,
  inPersonMicMs: 60_000,
  inPersonSystemMaxMs: 5_000,
  minSegmentMs: 250,
  relabelMinMs: 30_000,
  selfCosine: 0.45,
  selfMargin: 0.1,
  chunkCoverage: 0.5,
  chunkShare: 0.7,
  enrolDominantMs: 20_000,
  enrolShare: 0.8,
  enrolMinSystemChunks: 3,
  maxCentroids: 4,
  mergeCosine: 0.6,
  weightCapMs: 600_000,
  dims: 256,
  workerIdleMs: 60_000
} as const
