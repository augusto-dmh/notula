// SPDX-License-Identifier: Apache-2.0
// Kept meeting audio and recording imports.
// Stored records use the SQL column names; the per-file key and an import's source
// path never leave main.

import type { AudioSource, IsoTime } from './common'

/** `audio.retention`; `note` = kept as long as the note. */
export type AudioRetention = '1d' | '7d' | '30d' | '90d' | '365d' | 'note'

export type RecordingState = 'recording' | 'complete' | 'incomplete'

/** A `recordings` row without its `file_key`. */
export interface RecordingInfo {
  id: string
  note_id: string
  session_id: string
  source: AudioSource
  started_at: IsoTime
  ended_at: IsoTime | null
  duration_ms: number
  bytes: number
  state: RecordingState
}

export interface RecordingsUsage {
  totalBytes: number
  count: number
}

export type ImportPhase = 'queued' | 'creating' | 'reading' | 'transcribing' | 'summarizing' | 'complete' | 'failed'

export type ImportEngine = 'deepgram' | 'assemblyai' | 'local'

/** An `audio_imports` row; `source_path` stays in main. */
export interface ImportJob {
  id: string
  note_id: string | null
  file_name: string
  size_bytes: number
  phase: ImportPhase
  error: string | null
  engine: ImportEngine | null
  created_at: IsoTime
  updated_at: IsoTime
}

export const IMPORT_LIMITS = {
  maxBytes: 524_288_000,
  maxInProgress: 5,
  extensions: ['.mp3', '.m4a', '.aac', '.wav'],
  /** The audio MIME types a drop accepts, WAV included. */
  dragMimeTypes: [
    'audio/mpeg',
    'audio/mp3',
    'audio/x-mp3',
    'audio/m4a',
    'audio/x-m4a',
    'audio/mp4',
    'audio/aac',
    'audio/wav',
    'audio/x-wav'
  ],
  assemblyAiPollMs: 5_000,
  localAheadMs: 30_000,
  decodeMemoryBytes: 268_435_456,
  pcmBatchMs: 1_000
} as const

export const RECORDING_LIMITS = { frameBytes: 65_536, flushMs: 1_000, sweepMs: 86_400_000 } as const
