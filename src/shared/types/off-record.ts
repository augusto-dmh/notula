// SPDX-License-Identifier: Apache-2.0
// The off-the-record check (Labs `capture.offRecordPrompt`): someone in the meeting asks that
// what follows stay out of the notes, the user's LLM agrees, and the user gets 30 seconds to
// carry on or to remove what was said since the request and pause transcription. No payload
// carries transcript text: the card never quotes the meeting.

import type { IsoTime } from './common'

/** `off-record:prompt` (every window and the main bus); null clears it. */
export interface OffRecordPrompt {
  noteId: string
  promptId: string
  /** When the choice resolves as `keep` on its own. */
  expiresAt: IsoTime
}

/** `off-record:paused`: the note whose transcription paused for privacy; null clears it. */
export interface OffRecordPaused {
  noteId: string
  /** The prompt the pause answered, so a dismiss closes this pause and no later one. */
  promptId: string
}

/** What the privacy card shows: the open choice, or the pause after a removal. */
export type OffRecordCardState = ({ state: 'asking' } & OffRecordPrompt) | ({ state: 'paused' } & OffRecordPaused)

/** `keep` and `pause` answer the open choice; `dismiss` closes the paused card everywhere. */
export type OffRecordAnswer = 'keep' | 'pause' | 'dismiss'

export type OffRecordSurface = 'note' | 'bubble'

export interface OffRecordAnswerRequest {
  noteId: string
  promptId: string
  answer: OffRecordAnswer
  surface: OffRecordSurface
}

export const OFF_RECORD_LIMITS = {
  promptMs: 30_000,
  cooldownMs: 5 * 60_000
} as const
