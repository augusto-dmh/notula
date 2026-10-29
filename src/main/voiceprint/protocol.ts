// SPDX-License-Identifier: Apache-2.0
// The main ↔ notula-voiceprint messages. Types only. Embedding vectors travel only
// over this in-memory port, from the worker to main's voiceprint module; never IPC, logs or files.

import type { VerifiedFile } from '../asr/protocol'

export interface VoiceprintJob {
  type: 'job'
  jobId: string
  /** `segmentation` and `embedding` separate the speakers (the `diarization-en` files); `identification` is the `speaker-id` extractor. */
  files: { segmentation: VerifiedFile; embedding: VerifiedFile; identification: VerifiedFile }
  numThreads: number
  windowShiftRatio: number
  clusterThreshold: number
  minSegmentMs: number
  /** The guided sample, 16 kHz s16le mono, held in memory only. */
  pcm: Uint8Array
}

export interface VoiceprintSpeaker {
  speaker: number
  speechMs: number
  /** The clean spans' total. */
  cleanMs: number
  /** The identification vector, L2-normalized; null under 3 s of clean speech. */
  vector: Float32Array | null
}

export type VoiceprintToMain =
  | { type: 'result'; jobId: string; audioMs: number; computeMs: number; speakers: VoiceprintSpeaker[] }
  | { type: 'error'; jobId: string | null; message: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; event: string; data?: Record<string, unknown> }
