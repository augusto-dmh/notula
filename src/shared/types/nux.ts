// SPDX-License-Identifier: Apache-2.0
// One-time tips and "What's new".
// The tip copy lives in the renderer's features/nux/tips.ts.

export type NuxTipBase =
  | 'live-transcript'
  | 'slash-menu'
  | 'recipes'
  | 'demo-meeting'
  | 'folder-empty'
  | 'ai-setup'
  | 'labs'
  | 'retention-first-purge'
  | 'calendar-error'

export type NuxTipId = NuxTipBase | `folder-empty:${string}` | `retention-first-purge:${string}` | `whats-new:${string}`

export const NUX_COUNTER_LIMITS = { 'slash-menu': 3 } as const

export interface WhatsNewEntry {
  version: string
  title: string
  /** At most 3. */
  lines: string[]
}
