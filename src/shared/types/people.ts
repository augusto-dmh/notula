// SPDX-License-Identifier: Apache-2.0
// People and companies. The maps are derived in the storage worker;
// `src/shared/lib/people.ts` holds the shared name and domain functions.

import type { IsoTime } from './common'
import type { CalendarAttendee, NotePerson } from './notes'

/** `voice`: people with a remembered voice. */
export type PeopleFilter = 'all' | 'met' | 'voice'

export interface PeopleQuery {
  filter: PeopleFilter
  folderId?: string
  query?: string
}

/**
 * A derived row (keyed by email) or a persisted speaker person (`personId`), joined by email.
 * A person without an email opens `/person/p:<personId>`.
 */
export interface PersonRow {
  email?: string
  personId?: string
  hasVoice: boolean
  name: string
  domain: string | null
  lastSeenAt: IsoTime
  count: number
  isMine: boolean
  isSelf: boolean
}

export interface PersonDetail {
  email: string
  name: string
  domain: string | null
  lastSeenAt: IsoTime | null
  noteIds: string[]
  latestAttendee: CalendarAttendee | NotePerson | null
}

export interface CompaniesQuery {
  filter: PeopleFilter
  folderId?: string
  query?: string
}

export interface CompanyRow {
  domain: string
  name: string
  lastSeenAt: IsoTime
  count: number
  uniqueAttendees: number
  isMine: boolean
}

export interface CompanyDetail {
  domain: string
  name: string
  lastSeenAt: IsoTime | null
  noteIds: string[]
  people: { email: string; name: string; noteIds: string[] }[]
}

/** `companies:icon`: a cached favicon (opt-in, `companies.faviconsEnabled`). */
export interface CompanyIcon {
  mimeType: string
  bytes: Uint8Array
}

/** `companies.favorites` entries. */
export interface CompanyFavorite {
  domain: string
  name: string
}

export const PEOPLE_LIMITS = { rebuildMinMs: 60_000, idleWaitMs: 5_000, smallListRows: 5 } as const

export const COMPANY_ICON_LIMITS = {
  timeoutMs: 5_000,
  maxRedirects: 3,
  maxBytes: 102_400,
  refreshOkMs: 30 * 86_400_000,
  retryFailedMs: 7 * 86_400_000,
  concurrency: 4
} as const
