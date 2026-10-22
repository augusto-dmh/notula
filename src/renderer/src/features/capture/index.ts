// SPDX-License-Identifier: Apache-2.0
// The renderer capture engine, store and meeting controls. This module holds the public
// signatures; the bodies live in the files below.

import { createElement, lazy, Suspense, useEffect, useMemo, type JSX } from 'react'
import type { CaptureSystemState } from '@shared/types/capture'
import type { SourceState, StopReason } from '@shared/types/common'
import { AudioHealthBanner as HealthBanner } from './AudioHealthBanner'
import { MeetingPrompts as Prompts } from './MeetingPrompts'
import {
  mountCapture,
  startTranscription as storeStart,
  stopTranscription as storeStop,
  useCaptureSnapshot
} from './store'

export { MeetingControls } from './MeetingControls'

// ---------- prompts and audio health ----------

/** Above the note dock: "Resume transcript?" and the inactivity card. */
export function MeetingPrompts({ noteId }: { noteId: string }): JSX.Element | null {
  return createElement(Prompts, { noteId })
}

/** At the top of the transcript panel: the audio-health warnings. */
export function AudioHealthBanner({ noteId }: { noteId: string }): JSX.Element | null {
  return createElement(HealthBanner, { noteId })
}

// Lazy: the rows use the Settings primitives, which the bubble windows (they load this
// module through the transcript panel) must not pull in.
const LazyMeetingRows = lazy(() => import('./MeetingPreferencesRows').then((m) => ({ default: m.MeetingPreferencesRows })))

/** Settings ▸ Preferences: the meeting rows (live meeting indicator, inactivity, app-left stop). */
export function MeetingPreferencesRows(): JSX.Element {
  return createElement(Suspense, { fallback: null }, createElement(LazyMeetingRows))
}

export interface CaptureState {
  transcribingNoteId: string | null
  pendingStart: boolean
  ui: SourceState
  system: CaptureSystemState
}

export type StartTranscriptionResult =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'note-missing' | 'no-asr' }

export interface MeetingControlsProps {
  noteId: string
  transcriptOpen: boolean
  onToggleTranscript(): void
}

/** Mounted once, app-wide: the capture engine and the store's subscriptions. */
export function CaptureEngineHost(): null {
  useEffect(() => mountCapture(), [])
  return null
}

export function useCaptureState(): CaptureState {
  const s = useCaptureSnapshot()
  return useMemo(
    () => ({ transcribingNoteId: s.transcribingNoteId, pendingStart: s.pendingStart, ui: s.ui, system: s.system }),
    [s.transcribingNoteId, s.pendingStart, s.ui, s.system]
  )
}

export function startTranscription(noteId: string): Promise<StartTranscriptionResult> {
  return storeStart(noteId)
}

export function stopTranscription(reason: StopReason): void {
  storeStop(reason)
}
