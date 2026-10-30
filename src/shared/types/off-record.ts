// SPDX-License-Identifier: Apache-2.0
// The off-the-record check (Labs `capture.offRecordPrompt`): someone in the meeting asks that
// what follows stay out of the notes, the user's LLM agrees, and the user gets 30 seconds to
// carry on or to erase what was said since the request and pause transcription.

import type { IsoTime } from './common'

/** `off-record:prompt` (every window and the main bus); null clears it. */
export interface OffRecordPrompt {
  noteId: string
  promptId: string
  /** When the choice resolves as `keep` on its own. */
  expiresAt: IsoTime
  /** The line up to and including the request. */
  requestText: string
  /** What was said since the request, held back from the notes (the last 2,000 characters). */
  heldText: string
}

/** `off-record:paused`: the note whose transcription paused for privacy; null clears it. */
export interface OffRecordPaused {
  noteId: string
}

export type OffRecordAnswer = 'keep' | 'pause'

export type OffRecordSurface = 'note' | 'bubble'

export interface OffRecordAnswerRequest {
  noteId: string
  promptId: string
  answer: OffRecordAnswer
  surface: OffRecordSurface
}

export const OFF_RECORD_LIMITS = {
  promptMs: 30_000,
  cooldownMs: 5 * 60_000,
  heldTextMax: 2_000
} as const
