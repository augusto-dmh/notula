// SPDX-License-Identifier: Apache-2.0
// The main ↔ notula-media messages (the passive provider's reader). Types only, so the worker
// and main share them without runtime code.

import type { LessonReadSite } from '../../shared/types/sources'

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
  /** The browsers' installed web apps; the answer is `ev: 'apps'`. */
  | { type: 'apps'; id: number }
  /** A browser window's title by handle; the answer is `ev: 'window-title'`. */
  | { type: 'window-title'; id: number; hwnd: string }
  /**
   * The window read. The worker parses the reader's nodes itself and answers `ev: 'lesson-read'`
   * with only the lesson fields (`read`), or `read: null` and a reason.
   */
  | { type: 'lesson-read'; id: number; hwnd: string; site: LessonReadSite }
  /** Seeks the session of an app id; the answer is `ev: 'seek'` with `result`. */
  | { type: 'seek'; id: number; app: string; ms: number }

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
  locateTimeoutMs: 4_000,
  /** A first scan reads every shortcut once; later ones only new or changed files. */
  appsTimeoutMs: 15_000,
  windowTitleTimeoutMs: 2_000,
  seekTimeoutMs: 6_000,
  /** The worker's budget is `SOURCES_LIMITS.windowReadBudgetMs`; main waits a little longer. */
  lessonReadGraceMs: 500,
  /** A sparse first read (Chromium turning page accessibility on) is read again this long after the start. */
  lessonReadRetryMs: 1_500
} as const

/** The delay before restart number `n` (1-based). */
export function restartDelay(n: number): number {
  return MEDIA_READER_LIMITS.restartDelayMs * 2 ** Math.max(0, n - 1)
}
