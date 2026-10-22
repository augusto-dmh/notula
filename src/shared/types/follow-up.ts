// SPDX-License-Identifier: Apache-2.0
// Follow-up email drafts. Stored records use
// the `followup_drafts` column names, plus the note title for the home list.

import type { IsoTime } from './common'

export type FollowUpStatus = 'generating' | 'completed' | 'error'
export type FollowUpOutcome = 'opened' | 'copied' | 'discarded' | 'handed_off'
export type FollowUpConfidence = 'low' | 'medium' | 'high'

export interface FollowUpDraft {
  id: string
  document_id: string
  note_title: string | null
  status: FollowUpStatus
  outcome: FollowUpOutcome | null
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  /** Markdown. */
  body: string
  previous_body: string | null
  follow_up_need: FollowUpConfidence | null
  error_message: string | null
  feedback_direction: 'positive' | 'negative' | null
  feedback_text: string | null
  created_at: IsoTime
  updated_at: IsoTime
}

export type FollowUpDraftPatch = Partial<
  Pick<FollowUpDraft, 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'feedback_direction' | 'feedback_text'>
> & { outcome?: 'opened' }

export interface FollowUpHandoffResult {
  outcome: 'handed_off' | 'copied'
  bodyOnClipboard: boolean
}

export const FOLLOW_UP_LIMITS = {
  mailtoMaxChars: 2_000,
  removeAfterMs: 3 * 86_400_000,
  timeoutMs: 90_000,
  relatedNotes: 3
} as const

export const FOLLOW_UP_REFRESH_INSTRUCTION = 'Rewrite the draft using the meeting’s latest notes.'
