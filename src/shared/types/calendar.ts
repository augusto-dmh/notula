// SPDX-License-Identifier: Apache-2.0
// Calendar sync without a server: sources, calendars, the Coming up page and known
// participants.
// Events keep the Google event JSON shape (`CalendarEvent`, notes.ts).
//
// Feed URLs and OAuth tokens are secrets (`calendar.source.<id>`): they never
// appear in these types, so they never reach the renderer.

import type { IsoTime } from './common'
import type { CalendarEvent } from './notes'

export type CalendarSourceKind = 'ics' | 'google' | 'microsoft'
export type OAuthCalendarProvider = 'google' | 'microsoft'

export type CalendarErrorType =
  | 'invalid_feed'
  | 'fetch_failed'
  | 'missing_token'
  | 'missing_scopes'
  | 'calendar_list_failed'
  | 'timeout'
  | 'access_denied'

/** One ICS feed or OAuth account. */
export interface CalendarSource {
  id: string
  kind: CalendarSourceKind
  label: string
  /** OAuth accounts. */
  accountEmail: string | null
  /** ICS: "Your email in this calendar" (optional). */
  myEmail: string | null
  /** ICS only, for the masked display; the URL itself is a secret. */
  urlHost: string | null
  /** ICS over plain http. */
  insecure: boolean
  status: 'ok' | 'syncing' | 'error'
  errorType: CalendarErrorType | null
  lastSyncedAt: IsoTime | null
  lastError: string | null
  createdAt: IsoTime
  /** The held incremental grants, read from the token response's granted scopes. */
  grants: CalendarGrant[]
}

/** Incremental grants on the user's calendar OAuth account. */
export type CalendarGrant = 'calendar-write' | 'mail-read' | 'mail-send' | 'files-read'

/** The OAuth scopes each grant adds. `calendar-write` on Microsoft replaces `Calendars.Read`. */
export const CALENDAR_GRANT_SCOPES: Record<CalendarGrant, { google: string[]; microsoft: string[] }> = {
  'calendar-write': { google: ['https://www.googleapis.com/auth/calendar.events'], microsoft: ['Calendars.ReadWrite'] },
  'mail-read': { google: ['https://www.googleapis.com/auth/gmail.readonly'], microsoft: ['Mail.Read'] },
  'mail-send': { google: ['https://www.googleapis.com/auth/gmail.compose'], microsoft: ['Mail.ReadWrite', 'Mail.Send'] },
  'files-read': { google: ['https://www.googleapis.com/auth/drive.readonly'], microsoft: ['Files.Read'] }
}

export type CalendarGrantError = 'missing_scopes' | 'missing_token' | 'google_account_missing'

/** `calendar:sources`. `oauthClients`: whether a client id is set; the values never come back. */
export interface CalendarSourcesState {
  sources: CalendarSource[]
  oauthClients: Record<OAuthCalendarProvider, boolean>
}

export interface CalendarInfo {
  /** `<kind>:<sourceId>:<native id>`. */
  id: string
  sourceId: string
  name: string
  color: string | null
  primary: boolean
  accessRole: string | null
  visible: boolean
}

/** A Coming up row. */
export interface UpcomingEvent {
  event: CalendarEvent
  /** The calendar colour, else `CALENDAR_COLOR_DEFAULT`. */
  color: string
  /** The user's own note for this event, if any. */
  noteId: string | null
}

/** `calendar:upcoming`. */
export interface UpcomingPage {
  page: number
  /** `date` is the local calendar date, `YYYY-MM-DD`. */
  dayGroups: { date: string; events: UpcomingEvent[] }[]
  hasNextPage: boolean
  anyEarlierToday: boolean
  hasAnyEvents: boolean
  calendarError: boolean
  hasSources: boolean
}

/** A known person (`people:participants`). */
export interface Participant {
  name: string
  email: string
  lastSeenAt: IsoTime
  isAttendee: boolean
}

/** Sync timing and limits. */
export const CALENDAR_SYNC = {
  pollMs: 600_000,
  windowBackMs: 86_400_000,
  windowAheadMs: 14 * 86_400_000,
  onlinePollMs: 30_000,
  icsTimeoutMs: 30_000,
  icsMaxBytes: 20 * 1024 * 1024,
  icsMaxRedirects: 5,
  maxInstancesPerSeries: 1_000,
  oauthTimeoutMs: 300_000,
  tokenRefreshLeadMs: 60_000,
  zoomAppCacheMs: 600_000
} as const

/** Meeting reminders. */
export const REMINDER = {
  windowMs: 600_000,
  leadMs: 58_000,
  lateLimitMs: 240_000,
  lifetimeMs: 240_000,
  passMs: 600_000
} as const

/** Coming up paging. */
export const UPCOMING_PAGE = { firstWithToday: 5, firstWithoutToday: 4, later: 10, soonMs: 600_000 } as const

/** A calendar without a colour of its own: a lighter tint of the indigo accent, at least 3.8:1 on light and dark surfaces. */
export const CALENDAR_COLOR_DEFAULT = '#6470dc'
/** The reminder card without a calendar colour. */
export const REMINDER_COLOR_DEFAULT = '#9fe1e7'
