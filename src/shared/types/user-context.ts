// SPDX-License-Identifier: Apache-2.0
// The "About me" wiki.

import type { IsoTime } from './common'

export type UserContextSectionId =
  | 'identity'
  | 'current-work'
  | 'relationships'
  | 'teams'
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
  { id: 'teams', title: 'Your teams and routines', drafted: true },
  { id: 'work-habits', title: 'How you like to work', drafted: true },
  { id: 'communication', title: 'Communication', drafted: true },
  { id: 'calendar', title: 'Your meetings and calendar', drafted: true },
  { id: 'reference', title: 'Where your notes go', drafted: true },
  { id: 'assistant-guide', title: 'How Notula should help you', drafted: false }
]

export interface UserContextSection {
  section_id: UserContextSectionId
  content: string
  origin: 'user' | 'drafted'
  drafted_at: IsoTime | null
  updated_at: IsoTime
}

/** A row of the terms or projects table. Terms: name and meaning. Projects: name, summary and the user's part (`role`). */
export type UserContextEntryKind = 'term' | 'project'

export interface UserContextEntry {
  id: string
  kind: UserContextEntryKind
  name: string
  body: string
  role: string | null
  origin: 'user' | 'drafted'
  position: number
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
  terms: UserContextEntry[]
  projects: UserContextEntry[]
  people: UserContextPerson[]
  /**
   * `lastAt`: the last refresh, else the newest drafted section or row (profiles drafted before
   * refreshes existed). `drafted`: drafted at least once, so the button refreshes and the unlock
   * no longer applies.
   */
  refresh: { lastAt: IsoTime | null; drafted: boolean }
  settings: { enabled: boolean; inSummaries: boolean; inChat: boolean }
  /** "Draft from my meetings" turns on once `recorded` reaches `needed`. */
  unlock: { recorded: number; needed: number }
}

export type UserContextDraftStage = 'notes' | 'people' | 'writing'

export type UserContextDraftEvent = { runId: string } & (
  | { type: 'started'; sectionIds: UserContextSectionId[] }
  | { type: 'stage'; stage: UserContextDraftStage }
  | { type: 'done'; updated: UserContextSectionId[]; skippedUser: UserContextSectionId[]; rows: number; refreshedAt: IsoTime | null }
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
  draftTimeoutMs: 120_000,
  termMax: 60,
  termBodyMax: 300,
  termsMax: 200,
  projectNameMax: 80,
  projectBodyMax: 400,
  projectRoleMax: 200,
  projectsMax: 30
} as const
