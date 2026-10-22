// SPDX-License-Identifier: Apache-2.0
// The main ↔ notula-voiceprint messages. Types only. Embedding vectors travel only
// over this in-memory port, from the worker to main's voiceprint module; never IPC, logs or files.

import type { VerifiedFile } from '../asr/protocol'

export type VoiceprintAudio =
  /** A guided sample, held in memory only. */
  | { kind: 'pcm'; pcm: Uint8Array }
  /** A session's NAU1 mic temp file; its key arrives here, never on the command line. */
  | { kind: 'naud'; path: string; id: string; key: string }

export interface VoiceprintJob {
  type: 'job'
  jobId: string
  files: { segmentation: VerifiedFile; embedding: VerifiedFile }
  numThreads: number
  windowShiftRatio: number
  clusterThreshold: number
  minSegmentMs: number
  audio: VoiceprintAudio
}

export interface VoiceprintSegment {
  /** Seconds into the audio. */
  start: number
  end: number
  speaker: number
}

export interface VoiceprintSpeaker {
  speaker: number
  speechMs: number
  /** L2-normalized; null when no segment was long enough to embed. */
  vector: number[] | null
}

export type VoiceprintToMain =
  | { type: 'result'; jobId: string; audioMs: number; computeMs: number; segments: VoiceprintSegment[]; speakers: VoiceprintSpeaker[] }
  | { type: 'error'; jobId: string | null; message: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; event: string; data?: Record<string, unknown> }
