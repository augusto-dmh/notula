// SPDX-License-Identifier: Apache-2.0
// Meeting reminder cards.

import type { IsoTime } from './common'

export type ReminderKind = 'missing_invite' | 'no_meeting_link' | 'attendees_absent' | 'late_for_meeting' | 'followup_drafts'
export type ReminderStatus = 'pending' | 'active' | 'dismissed' | 'resolved'
export type ReminderResolvedReason =
  | 'cancelled'
  | 'expired'
  | 'rsvped'
  | 'ineligible'
  | 'details_added'
  | 'live'
  | 'joined'
  | 'not_transcribing'
  | 'session_ended'
  | 'draft_failed'
export type ReminderVariant = 'default' | 'focus_time' | 'late_for_meeting'
export type ReminderActionKind = 'draft_block' | 'open_chat' | 'open_link' | 'open_email' | 'copy' | 'review_drafts'
export type ReminderDraftState = 'requested' | 'preparing' | 'ready' | 'executing' | 'done' | 'unknown' | 'failed'

/** No Accept/Decline: calendar write builds no respond tool. */
export interface ReminderAction {
  id: string
  kind: ReminderActionKind
  label: string
  state?: ReminderDraftState
  retryable?: boolean
  draft?: { to: string[]; subject: string; body: string } | null
  url?: string | null
  disabledReason?: string | null
}

export interface Reminder {
  id: string
  /** `<kind>:<event identity>`. */
  key: string
  kind: ReminderKind
  status: ReminderStatus
  resolvedReason: ReminderResolvedReason | null
  dueAt: IsoTime | null
  expiresAt: IsoTime | null
  presentation: { variant: ReminderVariant; title: string; summary: string | null }
  actions: ReminderAction[]
  threadId: string | null
  context: { eventId: string | null; noteId: string | null; clash: { title: string; start: IsoTime } | null }
  createdAt: IsoTime
  updatedAt: IsoTime
}

export interface ReminderCardsState {
  /** One at a time, earliest due first. */
  card: Reminder | null
  sending: boolean
}

export const REMINDER_LIMITS = {
  tickMs: 30_000,
  inviteHorizonMs: 86_400_000,
  missingDetailsMs: 1_200_000,
  noShowAfterMs: 120_000,
  noShowChars: 400,
  lateFromMs: 60_000,
  lateUntilMs: 420_000,
  pruneAfterMs: 2_592_000_000,
  draftMaxWords: 120,
  card: { width: 339, height: 280, lateHeight: 319 },
  margins: { top: 16, side: 24, bottom: 24, screen: 16 },
  hideDelayMs: 350,
  doneMs: 10_000,
  draftTimeoutMs: 30_000
} as const
