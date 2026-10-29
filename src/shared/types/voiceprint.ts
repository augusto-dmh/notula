// SPDX-License-Identifier: Apache-2.0
// Record my voice: the guided sample that adds a self exemplar. No type
// here ever carries a vector: the vectors stay in main.

export interface VoiceprintSampleResult {
  enrolled: boolean
  speechMs: number
  reason: 'too-little-speech' | 'not-dominant' | 'cancelled' | 'model-missing' | 'mic-error' | null
}

export const VOICEPRINT_LIMITS = {
  sampleMs: 30_000,
  /** The online rule (`classify`). */
  onlineSystemSpeechMs: 15_000,
  inPersonMicMs: 60_000,
  inPersonSystemMaxMs: 5_000,
  minSegmentMs: 250,
  /** The enrolment guards, for the sample and the passive rule. */
  enrolDominantMs: 20_000,
  enrolShare: 0.8,
  enrolMinSystemChunks: 3,
  workerIdleMs: 60_000
} as const
