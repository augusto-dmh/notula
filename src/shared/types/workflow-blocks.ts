// SPDX-License-Identifier: Apache-2.0
// The draft-block store behind chat cards.

import type { IsoTime } from './common'

export type WorkflowBlockType = 'calendar_event' | 'email' | 'slack_message' | 'crm_update' | 'google_doc' | 'markdown'

export interface BlockExecution {
  /** 'creating' | 'sending' | 'updating' | 'created' | 'sent' | 'updated' | 'failed' | 'unknown'. */
  status: string
  executionId: string
  startedAt: IsoTime
  completedAt?: IsoTime
  errorCode?: string
  error?: string
  [field: string]: unknown
}

export interface WorkflowBlock {
  id: string
  type: WorkflowBlockType
  source_type: 'chat_thread'
  source_id: string
  assistant_message_id: string | null
  tool_call_id: string | null
  /** The type's content shape (CalendarEventDraft, EmailDraftBlock, …). */
  content: unknown
  execution: BlockExecution | null
  dismissed_at: IsoTime | null
  created_at: IsoTime
  updated_at: IsoTime
}

export type BlockUpdate =
  | { blockId: string; type: WorkflowBlockType; expectedUpdatedAt?: IsoTime; content: unknown }
  | { blockId: string; type: WorkflowBlockType; dismiss: true }

export interface BlockExecuteOptions {
  /** Email. */
  mode?: 'draft' | 'send'
  /** Calendar "Add to". */
  targetSourceId?: string
}

/** One end of a time option: timed, or all-day. */
export type CalendarDraftTime = { dateTime: string; timeZone: string } | { date: string }

/** A `calendar_event` block's content. */
export interface CalendarEventDraft {
  eventType?: 'default' | 'focusTime' | 'outOfOffice'
  autoDeclineMode?: 'declineNone' | 'declineOnlyNewConflictingInvitations' | 'declineAllConflictingInvitations'
  /** ≤ 1,000 characters. */
  declineMessage?: string
  summary: string
  /** 1–3 options. */
  timeOptions: { start: CalendarDraftTime; end: CalendarDraftTime }[]
  selectedTime?: { start: CalendarDraftTime; end: CalendarDraftTime }
  conference: { kind: 'none' } | { kind: 'googleMeet' } | { kind: 'custom'; url: string }
  location?: string
  /** Default true: the user's email is the first attendee. */
  addMeAsGuest?: boolean
  attendees: { email: string; resource?: boolean }[]
  description: string
  /** New events only: `RRULE:`, `EXRULE:`, `RDATE`, `EXDATE` lines. */
  recurrenceRules?: string[]
  fromEvent?: { calendarId: string; eventId: string; scope: 'occurrence' | 'series' }
  execution: BlockExecution | null
  dismissedAt: IsoTime | null
  existingEvent?: {
    calendarId: string
    eventId: string
    scope: 'occurrence' | 'series'
    etag: string
    original: Omit<CalendarEventDraft, 'existingEvent' | 'execution' | 'dismissedAt'>
  }
}

/** An `email` block's content. */
export interface EmailDraftBlock {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  /** A Gmail thread id. */
  inReplyToThread?: string
  /** ≤ 10. */
  attachmentIds?: string[]
}

export const BLOCK_LIMITS = { autosaveMs: 750, creatingExpiresMs: 60_000, sendUndoMs: 10_000 } as const
