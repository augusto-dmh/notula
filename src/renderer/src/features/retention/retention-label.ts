// SPDX-License-Identifier: Apache-2.0
// The retention picker's label for a stored hour count. Main accepts presets only, but a stored
// value can still be something else (an older build, a hand-edited file); it then shows as a
// custom entry instead of a blank picker. Pure, with the presets passed in, so
// scripts/dev/retention-label-check.ts runs it under plain Node.

import type { RetentionHours } from '@shared/types/retention'

export interface RetentionLabel {
  /** The picker's text: the preset's label, or the custom entry's. */
  label: string
  /** The period alone, for prose ("older than 2 days"). */
  period: string
  /** No preset matches: the picker adds this as its own entry. */
  custom: boolean
}

const HOURS_PER_DAY = 24

export function retentionLabel(
  hours: number | null,
  options: readonly { label: string; hours: RetentionHours | null }[]
): RetentionLabel {
  const preset = options.find((o) => o.hours === hours)
  if (preset) return { label: preset.label, period: preset.label, custom: false }
  const h = hours ?? 0
  const days = h / HOURS_PER_DAY
  const period = Number.isInteger(days) ? `${days} ${days === 1 ? 'day' : 'days'}` : `${h} ${h === 1 ? 'hour' : 'hours'}`
  return { label: `${period} (custom)`, period, custom: true }
}
