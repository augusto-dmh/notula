// SPDX-License-Identifier: Apache-2.0
// The main ↔ #/media-worker messages on the transferred MessagePort (internal to imports).
// The renderer keeps a copy of these shapes in features/imports/media-protocol.ts.
//
// Main streams the file in pieces (it never holds more than one piece); the worker decodes with
// WebCodecs and returns 16 kHz s16le mono PCM in 1 s batches. The worker keeps at most a few
// batches un-acknowledged; main acknowledges a batch once the engine is less than 30 s behind,
// so decoding never runs more than about 30 s ahead of transcription.

export type MediaFormat = 'mp3' | 'aac' | 'm4a' | 'wav'

export type MainToMedia =
  | { type: 'start'; jobId: string; format: MediaFormat; totalBytes: number }
  /** A piece of the file at `offset`; `eof` on the last one. */
  | { type: 'data'; jobId: string; offset: number; bytes: Uint8Array; eof: boolean }
  /** The engine took PCM batch `seq`: the worker may decode further. */
  | { type: 'ack'; jobId: string; seq: number }
  | { type: 'cancel'; jobId: string }

export type MediaToMain =
  /** The page is listening on the port. */
  | { type: 'hello' }
  /** The next piece the worker needs, from `offset` (M4A may ask for a box out of order). */
  | { type: 'want'; jobId: string; offset: number }
  | { type: 'pcm'; jobId: string; seq: number; pcm: Uint8Array }
  | { type: 'done'; jobId: string; ms: number }
  /** `unsupported`: WebCodecs lacks the codec (the cloud path may take the file). */
  | { type: 'error'; jobId: string; code: 'unsupported' | 'decode'; message: string }
