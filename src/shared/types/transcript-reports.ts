// SPDX-License-Identifier: Apache-2.0
// Local "report a transcript problem" records.

import type { IsoTime } from './common'

export type TranscriptReportCategory = 'misheard_words' | 'gaps' | 'language_wrong' | 'speaker_errors' | 'other'

/** The problem labels, in menu order. */
export const TRANSCRIPT_REPORT_CATEGORIES: readonly { value: TranscriptReportCategory; label: string }[] = [
  { value: 'misheard_words', label: 'Wrong words or spellings' },
  { value: 'gaps', label: "Parts of the conversation are missing" },
  { value: 'language_wrong', label: 'Wrong language' },
  { value: 'speaker_errors', label: 'Incorrect speaker' },
  { value: 'other', label: 'Something else' }
]

export interface TranscriptReportInput {
  noteId: string
  category: TranscriptReportCategory
  comments: string
  /** A selection; main derives the range and the excerpt from finalized chunks. */
  chunkIds?: string[]
}

export interface TranscriptReport {
  id: string
  note_id: string
  category: TranscriptReportCategory
  comments: string
  start_timestamp: IsoTime | null
  end_timestamp: IsoTime | null
  excerpt_text: string
  asr_provider: string | null
  asr_model: string | null
  asr_language: string | null
  asr_local: boolean
  created_at: IsoTime
}

export const TRANSCRIPT_REPORT_LIMITS = { noRangeExcerptChars: 2_000, commentsMax: 5_000 } as const
