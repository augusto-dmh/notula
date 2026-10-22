// SPDX-License-Identifier: Apache-2.0
// Transcript auto-deletion.

import type { IsoTime } from './common'

export type RetentionHours = 24 | 168 | 720 | 2160 | 4320 | 8760

/** The choices, in menu order. */
export const RETENTION_OPTIONS: readonly { label: string; hours: RetentionHours | null }[] = [
  { label: 'Off', hours: null },
  { label: '1 day', hours: 24 },
  { label: '1 week', hours: 168 },
  { label: '1 month', hours: 720 },
  { label: '3 months', hours: 2160 },
  { label: '6 months', hours: 4320 },
  { label: '1 year', hours: 8760 }
]

export interface RetentionRun {
  id: string
  ran_at: IsoTime
  period_hours: RetentionHours
  notes: number
  sections: number
  recordings: number
  bytes_freed: number
  note_ids: string[]
  errors: string[]
  trigger: 'startup' | 'daily'
}

export interface RetentionState {
  hours: RetentionHours | null
  pendingHours: RetentionHours | null
  effectiveAt: IsoTime | null
  lastRun: RetentionRun | null
}

export interface RetentionPreview {
  notes: number
  recordings: number
  oldest: IsoTime | null
  newest: IsoTime | null
  effectiveAt: IsoTime
}

export const RETENTION_LIMITS = {
  cooldownMs: 604_800_000,
  noticeBeforeMs: 86_400_000,
  everyMs: 86_400_000,
  batchNotes: 200,
  logRuns: 20,
  sectionDeleteMax: 500
} as const
