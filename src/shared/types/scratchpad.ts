// SPDX-License-Identifier: Apache-2.0
// The daily scratchpad.

import type { IsoTime } from './common'

export interface ScratchpadDaySummary {
  /** `YYYY-MM-DD`, local. */
  date: string
  hasText: boolean
}

export interface ScratchpadDay {
  date: string
  /** The day's bullets, ProseMirror JSON. */
  content: unknown
  updatedAt: IsoTime | null
}

export const SCRATCHPAD_SAVE_DEBOUNCE_MS = 500
