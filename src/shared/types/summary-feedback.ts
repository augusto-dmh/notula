// SPDX-License-Identifier: Apache-2.0
// Summary ratings that tune templates. Local only.

import type { IsoTime } from './common'

export type SummaryFeedbackDirection = 'positive' | 'negative'

export interface SummaryFeedback {
  id: string
  panel_id: string
  document_id: string
  template_key: string
  direction: SummaryFeedbackDirection | null
  comment: string | null
  dismissed_at: IsoTime | null
  created_at: IsoTime
  updated_at: IsoTime
}

export interface SummaryFeedbackList {
  counts: { positive: number; negative: number }
  items: (SummaryFeedback & { note_title: string | null })[]
}

export type TemplateEditSuggestion =
  | { ok: true; sections: { heading: string; before: string; after: string }[] }
  | { ok: false; error: string }

export const SUMMARY_FEEDBACK_LIMITS = {
  sampleRate: 0.1,
  cooldownMs: 604_800_000,
  minOwnNotes: 10,
  dismissedMax: 1_000,
  thanksMs: 1_500,
  suggestMinComments: 3,
  suggestComments: 20
} as const
