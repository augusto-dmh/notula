// SPDX-License-Identifier: Apache-2.0
// Gmail and Outlook context, drafts and sends.
// Mail is never stored.

import type { CalendarGrant, OAuthCalendarProvider } from './calendar'
import type { IsoTime } from './common'

export interface MailAccount {
  sourceId: string
  provider: OAuthCalendarProvider
  email: string
  grants: CalendarGrant[]
  state: 'ok' | 'reconnect' | 'missing-grant'
}

export interface MailThread {
  id: string
  subject: string
  participants: string[]
  lastMessageAt: IsoTime
  snippet: string
}

export interface MailDraftInput {
  sourceId: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  html: string
  text: string
  inReplyToThread?: string
  followUpDraftId?: string
}

/** ≤ 3 attendees × 3 threads, 90 days, snippets ≤ 500. */
export interface EmailContext {
  attendeeEmail: string
  threads: MailThread[]
}

export const MAIL_LIMITS = {
  mailtoFallback: true,
  threadsPerPerson: 10,
  searchMax: 20,
  readMessageChars: 4_000,
  readThreadChars: 20_000,
  briefAttendees: 3,
  briefThreads: 3,
  briefDays: 90,
  briefSnippetChars: 500,
  sendUndoMs: 10_000
} as const
