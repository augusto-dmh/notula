// SPDX-License-Identifier: Apache-2.0
// The bubble: the floating live-meeting pill and its panels.

import type { InactivityWarning } from './capture'
import type { Rect, SourceState } from './common'
import type { CalendarEvent } from './notes'

/**
 * What the bubble shows, computed by the main window's capture store (`bubble:set-document`).
 * `kind` stays a union seam for `chat-consent` (later).
 */
export interface BubbleDocument {
  kind: 'transcribing'
  noteId: string
  title: string | null
  event: CalendarEvent | null
  transcription: SourceState
  warning: string | null
  inactivity: InactivityWarning | null
}

/** `bubble:get-state`, for the calling bubble window. */
export interface BubbleState {
  visible: boolean
  hovered: boolean
  document: BubbleDocument | null
}

/** The main-only setting `bubble.position`: the pill's bounds and the display they were saved on. */
export interface BubblePosition {
  bounds: Rect
  display: Rect
}

export const BUBBLE_SIZE = { width: 42, height: 70 } as const
export const BUBBLE_PANEL_SIZE = { width: 300, height: 350 } as const
export const BUBBLE_INACTIVITY_WIDTH = 336
