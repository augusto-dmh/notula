// SPDX-License-Identifier: Apache-2.0
// The #/media-worker ↔ main messages on the transferred port. A copy of
// src/main/imports/media-protocol.ts (T-internal; the renderer cannot import main code).

export type MediaFormat = 'mp3' | 'aac' | 'm4a' | 'wav'

export type MainToMedia =
  | { type: 'start'; jobId: string; format: MediaFormat; totalBytes: number }
  | { type: 'data'; jobId: string; offset: number; bytes: Uint8Array; eof: boolean }
  | { type: 'ack'; jobId: string; seq: number }
  | { type: 'cancel'; jobId: string }

export type MediaToMain =
  | { type: 'hello' }
  | { type: 'want'; jobId: string; offset: number }
  | { type: 'pcm'; jobId: string; seq: number; pcm: Uint8Array }
  | { type: 'done'; jobId: string; ms: number }
  | { type: 'error'; jobId: string; code: 'unsupported' | 'decode'; message: string }
