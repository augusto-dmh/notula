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

/** The section titles, plus "How to work with me". */
export const USER_CONTEXT_SECTIONS: readonly { id: UserContextSectionId; title: string }[] = [
  { id: 'identity', title: 'Who you are' },
  { id: 'current-work', title: 'What you’re working on' },
  { id: 'relationships', title: 'People you work with' },
  { id: 'work-habits', title: 'How you like to work' },
  { id: 'communication', title: 'Communication' },
  { id: 'calendar', title: 'Your meetings and calendar' },
  { id: 'reference', title: 'Words you use and where notes are sent' },
  { id: 'assistant-guide', title: 'How Notula should help you' }
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
}

export type UserContextDraftEvent = { runId: string } & (
  | { type: 'started'; sectionIds: UserContextSectionId[] }
  | { type: 'done'; updated: UserContextSectionId[]; skippedUser: UserContextSectionId[] }
  | { type: 'error'; message: string }
)

export const USER_CONTEXT_LIMITS = {
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
