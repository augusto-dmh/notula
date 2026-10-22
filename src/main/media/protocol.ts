// SPDX-License-Identifier: Apache-2.0
// The main ↔ notula-media messages (the passive provider's reader). Types only, so the worker
// and main share them without runtime code.

export interface MediaReaderArgs {
  /** `resources/media/session.ps1`, resolved by main (the worker has no `app`). */
  scriptPath: string
  /** The OS app ids to report (the measured browsers). */
  apps: string[]
}

export type MainToMedia =
  | { type: 'start'; args: MediaReaderArgs }
  | { type: 'stop' }
  /** A tab-strip read; the answer is a `record` with `ev: 'locate'` and the same id. */
  | { type: 'locate'; id: number; process: string; title: string; address: boolean }

/** The reader's life cycle as the worker sees it. */
export type MediaReaderState = 'starting' | 'running' | 'restarting' | 'failed' | 'unavailable' | 'stopped'

export type MediaToMain =
  /** One parsed JSON line of the reader (`ready`, `sessions`, `locate`, `unavailable`). */
  | { type: 'record'; record: Record<string, unknown> }
  | { type: 'state'; state: MediaReaderState; detail: string | null; pid: number | null }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; event: string; data?: Record<string, unknown> }

/** Restarts after 1 s, doubling, at most 5; the count resets after 30 s healthy. */
export const MEDIA_READER_LIMITS = {
  restartDelayMs: 1_000,
  maxRestarts: 5,
  restartResetMs: 30_000,
  killGraceMs: 1_000,
  locateTimeoutMs: 4_000
} as const

/** The delay before restart number `n` (1-based). */
export function restartDelay(n: number): number {
  return MEDIA_READER_LIMITS.restartDelayMs * 2 ** Math.max(0, n - 1)
}
