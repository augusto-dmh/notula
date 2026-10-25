// SPDX-License-Identifier: Apache-2.0
// The "About me" wiki.

import type { IsoTime } from './common'

export type UserContextSectionId =
  | 'identity'
  | 'current-work'
  | 'relationships'
  | 'work-habits'
  | 'communication'
  | 'calendar'
  | 'reference'
  | 'assistant-guide'

/**
 * The section titles, in their usual order. `drafted: false` sections are only ever written by
 * the user: "Draft from my meetings" never fills them, and the page lists them only while they
 * hold text.
 */
export const USER_CONTEXT_SECTIONS: readonly { id: UserContextSectionId; title: string; drafted: boolean }[] = [
  { id: 'identity', title: 'Who you are', drafted: true },
  { id: 'current-work', title: 'What you’re working on', drafted: true },
  { id: 'relationships', title: 'People you work with', drafted: true },
  { id: 'work-habits', title: 'How you like to work', drafted: true },
  { id: 'communication', title: 'Communication', drafted: true },
  { id: 'calendar', title: 'Your meetings and calendar', drafted: true },
  { id: 'reference', title: 'Words you use and where notes are sent', drafted: true },
  { id: 'assistant-guide', title: 'How Notula should help you', drafted: false }
]

export interface UserContextSection {
  section_id: UserContextSectionId
  content: string
  origin: 'user' | 'drafted'
  drafted_at: IsoTime | null
  updated_at: IsoTime
}

export interface UserContextPerson {
  email: string
  name: string
  count: number
  lastSeenAt: IsoTime
  score: number
}

export interface UserContextState {
  sections: UserContextSection[]
  nameDictionary: string[]
  people: UserContextPerson[]
  settings: { enabled: boolean; inSummaries: boolean; inChat: boolean }
  /** "Draft from my meetings" turns on once `recorded` reaches `needed`. */
  unlock: { recorded: number; needed: number }
}

export type UserContextDraftStage = 'notes' | 'people' | 'writing'

export type UserContextDraftEvent = { runId: string } & (
  | { type: 'started'; sectionIds: UserContextSectionId[] }
  | { type: 'stage'; stage: UserContextDraftStage }
  | { type: 'done'; updated: UserContextSectionId[]; skippedUser: UserContextSectionId[] }
  | { type: 'error'; message: string }
)

/** An app connected to Notula's MCP server that has read the profile (`user-context:agents`). */
export interface UserContextAgent {
  tokenId: string
  name: string
  lastReadAt: IsoTime
  paused: boolean
}

export const USER_CONTEXT_LIMITS = {
  /** The user's own notes with a transcript before drafting turns on; demo notes don't count. */
  unlockMeetings: 10,
  draftPeople: 15,
  sectionMax: 4_000,
  namesMax: 50,
  nameMax: 50,
  draftDays: 60,
  draftNotes: 40,
  draftChars: 60_000,
  injectChars: 6_000,
  peopleDecayDays: 21,
  peopleMax: 100,
  draftTimeoutMs: 120_000
} as const
