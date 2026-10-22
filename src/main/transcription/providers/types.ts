// SPDX-License-Identifier: Apache-2.0
// The ASR provider interface, shared by the cloud providers and the local engine.
// The session owns everything provider-independent: the
// pending buffer, segment→UUID map, store merge, failover and per-source state.

import type { EventEmitter } from 'node:events'
import type { AudioSource } from '@shared/types/common'
import type { AsrProviderId } from '@shared/types/transcript'

export type AsrUnavailableReason = 'no-key' | 'not-installed' | 'unsupported-language'

export interface AsrConnectOptions {
  source: AudioSource
  language: string
  keywords: string[]
  sampleRate: 16000
  sessionId: string
}

export interface AsrWord {
  w: string
  s_ms: number
  e_ms: number
  conf: number
  spk?: number
  lang?: string
  spk_conf?: number
  lang_conf?: number
}

export interface AsrResult {
  /** Stable for one segment's partials and its final. Never used as a chunk id. */
  segmentKey: string
  isFinal: boolean
  text: string
  /** Provider-relative, from the start of the audio sent on this socket. */
  startMs: number
  endMs: number
  /** Capture time of the first audio sent on this socket. */
  baseEpochMs: number
  words: AsrWord[]
  language?: string
  turnEndScore?: number
}

export type AsrErrorKind = 'auth' | 'network' | 'provider' | 'liveness' | 'parse'

export interface AsrError {
  kind: AsrErrorKind
  message: string
  /** HTTP status of a refused upgrade, when there was one. */
  status?: number
  /**
   * The connection cannot recover on its own (the local engine failed to start: a
   * missing or corrupt model, a load timeout). The session fails over at once.
   */
  fatal?: boolean
}

export interface AsrConnectionEvents {
  open: []
  /** `willReconnect` false only after `close()`. */
  close: [info: { willReconnect: boolean }]
  error: [err: AsrError]
  reconnect: [info: { retry: number; downMs: number }]
  result: [result: AsrResult]
  /** Local engine: audio sent before this capture time is transcribed. */
  progress: [info: { savedThroughEpochMs: number }]
}

export interface AsrConnection extends EventEmitter<AsrConnectionEvents> {
  readonly providerId: AsrProviderId
  readonly model: string
  isOpen(): boolean
  /** False when the socket is not open; the session keeps the audio pending. */
  send(pcm: Buffer, captureTimeMs: number): boolean
  updateKeywords(terms: string[]): void
  /** Retries now, skipping the backoff wait (the user's Retry). */
  retryNow(): void
  /**
   * Graceful: AssemblyAI `Terminate` then wait for `Termination`; Deepgram `CloseStream`.
   * Resolves within about `timeoutMs` (default 7 s).
   */
  close(timeoutMs?: number): Promise<void>
  /** Gap between replayed batches; 0 sends a backlog at once. */
  readonly replayIntervalMs: number
}

export interface AsrProvider {
  readonly id: AsrProviderId
  readonly kind: 'cloud' | 'local'
  available(language: string): Promise<{ ok: true } | { ok: false; reason: AsrUnavailableReason }>
  /** The model label for session info and stored sessions. */
  model(language: string): Promise<string>
  connect(opts: AsrConnectOptions): Promise<AsrConnection>
  /** One connection attempt with the stored key, closed at once (`asr:test`). */
  test(): Promise<{ ok: boolean; error?: string }>
}
