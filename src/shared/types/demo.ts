// SPDX-License-Identifier: Apache-2.0
// The bundled demo meeting.

import { DEMO_MEETING_PREFIX, type Note } from './notes'

export type DemoMode = 'live' | 'replay'

export interface DemoState {
  active: boolean
  noteId: string | null
  mode: DemoMode | null
  playing: boolean
  lineIndex: number
  lineCount: number
  caption: string | null
  speaker: string | null
  elapsedMs: number
  durationMs: number
}

/** A demo note's event id is `demo_meeting_<UUID>`; DEMO_MEETING_PREFIX stays the test. */
export const DEMO_EVENT_ID_PREFIX = 'demo_meeting_'

export const DEMO_ATTENDEE = { email: 'demo@notula.invalid', displayName: 'Notula Demo', organizer: true } as const

export const DEMO_LIMITS = { maxNotes: 5, durationMs: 180_000, sideMinPx: 500, sideFraction: 0.315 } as const

/** A demo note's id, or its event's id, starts with `demo_meeting`. */
export function isDemoNote(note: Pick<Note, 'id' | 'event_id'>): boolean {
  return note.id.startsWith(DEMO_MEETING_PREFIX) || (note.event_id ?? '').startsWith(DEMO_MEETING_PREFIX)
}
