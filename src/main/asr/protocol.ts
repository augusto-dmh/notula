// SPDX-License-Identifier: Apache-2.0
// The main ↔ worker messages of notula-asr and notula-diarize (internal to the local
// engine). Types only, so the workers and main share it without runtime code.

import type { LocalModelId } from '@shared/types/transcript'

/** A model file the worker re-verifies before loading it (layer 3). */
export interface VerifiedFile {
  path: string
  bytes: number
  sha256: string
}

// ---------- notula-asr ----------

interface AsrWorkerArgsBase {
  modelId: LocalModelId
  sampleRate: 16000
  /** Hotwords stay off until a vocabulary is pinned; the score is kept for when they are on. */
  hotwordScore: number
  numThreads: number
}

/** The one JSON argument of `utilityProcess.fork`. Parakeet: a NeMo transducer (110M or 0.6B v3). */
export type AsrWorkerArgs =
  | (AsrWorkerArgsBase & {
      engine: 'parakeet'
      files: { encoder: VerifiedFile; decoder: VerifiedFile; joiner: VerifiedFile; tokens: VerifiedFile }
    })
  | (AsrWorkerArgsBase & {
      /** Whisper large-v3-turbo. */
      engine: 'whisper'
      files: { encoder: VerifiedFile; decoder: VerifiedFile; tokens: VerifiedFile }
      /** A Whisper language code, or '' to detect it per segment. */
      language: string
    })

export type MainToAsr =
  /** s16le mono at 16 kHz. */
  | { type: 'audio'; pcm: Uint8Array }
  /** A capture gap: closes any open segment and moves the clock. */
  | { type: 'skip'; ms: number }
  | { type: 'keywords'; terms: string[] }
  | { type: 'ping'; id: number }
  | { type: 'finalize' }
  | { type: 'shutdown' }

/** Times are ms from the first audio this worker received (skips included). */
export interface AsrWorkerWord {
  w: string
  s_ms: number
  e_ms: number
}

export interface AsrFinalizeStats {
  segments: number
  partials: number
  decodedAudioMs: number
  totalDecodeMs: number
  totalPartialDecodeMs: number
  maxDecodeMs: number
}

export type AsrToMain =
  | { type: 'ready'; loadMs: number }
  | { type: 'partial'; segmentId: number; text: string; startMs: number; endMs: number; words: AsrWorkerWord[] }
  | { type: 'segment'; segmentId: number; text: string; startMs: number; endMs: number; words: AsrWorkerWord[] }
  /** Everything before this time is decoded or decoding. */
  | { type: 'progress'; committedMs: number }
  | { type: 'pong'; id: number }
  | { type: 'finalized'; stats: AsrFinalizeStats }
  | { type: 'error'; message: string }
  | WorkerLog

// ---------- notula-diarize ----------

/** One NAU1 temp file: its path, its id and its base64 key. */
export interface DiarizeFile {
  path: string
  id: string
  key: string
}

/** One source's audio: its session files in order, played back to back. */
export interface DiarizeInput {
  key: string
  files: DiarizeFile[]
}

/** Main → notula-diarize: the job, sent over the port once the process spawned (never argv: it holds keys). */
export interface DiarizeStart {
  type: 'start'
  args: DiarizeWorkerArgs
}

export interface DiarizeWorkerArgs {
  files: { segmentation: VerifiedFile; embedding: VerifiedFile }
  numThreads: number
  /** Clustering distance threshold (sherpa-onnx fast clustering; -1 clusters = by threshold). */
  threshold: number
  /** pyannote window step as a share of its 10 s window: larger is faster, coarser. */
  windowShiftRatio: number
  inputs: DiarizeInput[]
}

export interface DiarizeSegment {
  /** Seconds from the start of the input's first file. */
  start: number
  end: number
  speaker: number
}

export type DiarizeToMain =
  | { type: 'result'; key: string; segments: DiarizeSegment[]; audioMs: number; computeMs: number }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | WorkerLog

/** Workers have no log file of their own; main writes these lines. */
export interface WorkerLog {
  type: 'log'
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  data?: Record<string, unknown>
}
