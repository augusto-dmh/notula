// SPDX-License-Identifier: Apache-2.0
// Action items. camelCase, like the generated item shape.

import type { IsoTime } from './common'

export type ActionItemStatus = 'todo' | 'done'
export type ActionItemReview = 'kept' | 'dismissed'

export interface ActionItemAttribution {
  name: string
  identifiers: string[]
}

export interface ActionItemFeedback {
  id: string
  actionItemId: string | null
  direction: 'positive' | 'negative'
  feedback: string | null
  createdAt: IsoTime
  updatedAt: IsoTime
}

export interface ActionItem {
  id: string
  /** Equals `id`. */
  actionItemId: string
  intent: string
  detail: string | null
  status: ActionItemStatus
  archivedAt: IsoTime | null
  sourceNoteId: string | null
  sourcePanelId: string | null
  attribution: ActionItemAttribution[]
  createdAt: IsoTime
  reviewStatus: ActionItemReview | null
  reviewReason: string | null
  reviewedAt: IsoTime | null
  /** Newest first. */
  feedback: ActionItemFeedback[]
}

export interface ActionItemsQuery {
  includeArchived?: boolean
  noteIds?: string[]
  ids?: string[]
  createdAfter?: IsoTime
  createdBefore?: IsoTime
  limit?: number
}

/** Thumbs on a linked item, or on an unlinked summary line under an action heading. */
export type ActionItemFeedbackInput = { direction: 'positive' | 'negative'; feedback: string | null } & (
  | { actionItemId: string }
  | { panelId: string; headingText: string; itemText: string }
)

export interface RegeneratedActionItem {
  sourceNoteId: string
  intent: string
  detail: string | null
  attribution: ActionItemAttribution[]
}

/** `action-items:regenerate-progress`. */
export type ActionItemsRegenerateEvent = { runId: string } & (
  | { type: 'ready'; total: number }
  | { type: 'heartbeat' }
  | { type: 'progress'; completed: number; total: number }
  | { type: 'complete'; sourceNoteIds: string[]; items: RegeneratedActionItem[] }
  | { type: 'error'; message: string }
)

/** Summary headings whose lines count as action items (lower-cased). */
export const ACTION_HEADINGS = ['action items', 'actions', 'next steps', 'follow ups', 'to dos', 'todos'] as const

export const ACTION_ITEMS_LIMITS = {
  perNote: 20,
  intentMaxWords: 15,
  renderIdsMax: 20,
  regenerateInFlight: 2,
  timeoutMs: 60_000
} as const
