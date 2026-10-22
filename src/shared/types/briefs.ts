// SPDX-License-Identifier: Apache-2.0
// Prep briefs. Stored records use
// the `prep_briefs` column names.

import type { IsoTime } from './common'

export type BriefStatus = 'generating' | 'streaming' | 'completed' | 'error'

export interface BriefStep {
  type: 'tool_start' | 'tool_end'
  toolName: string
  statusMessage: string
  toolCallId: string
  success?: boolean
}

export interface BriefReference {
  /** `gmail` / `outlook` for a recent-email thread (the mail context); `link` is ''. */
  source: 'notula' | 'gmail' | 'outlook'
  id: string
  title: string
  /** `meeting://<id>` (MEETING_LINK_SCHEME). */
  link: string
  date: IsoTime
}

export interface PrepBrief {
  id: string
  event_id: string
  document_id: string | null
  status: BriefStatus
  headline: string | null
  content: string | null
  brief_sources: BriefReference[]
  worth_showing: boolean | null
  steps: BriefStep[]
  error_message: string | null
  auto_opened: boolean
  dismissed_at: IsoTime | null
  created_at: IsoTime
  updated_at: IsoTime
}

export type BriefEnsureStatus = 'exists' | 'queued' | 'not-eligible' | 'unavailable' | 'disabled'

export const BRIEF_LIMITS = {
  maxAttendees: 20,
  windowAheadMin: 660,
  lookbackMin: 120,
  passMs: 120_000,
  unavailableRetryMs: 180_000,
  contextNotes: 8,
  perNoteChars: 2_000,
  contextChars: 16_000,
  descriptionChars: 2_000,
  maxRetries: 3,
  retryGapMs: 600_000,
  timeoutMs: 120_000,
  statusCycleMs: 10_000,
  headlineMaxWords: 25,
  bodyMaxWords: 200
} as const

export const MEETING_LINK_SCHEME = 'meeting://'
