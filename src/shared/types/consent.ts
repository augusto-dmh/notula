// SPDX-License-Identifier: Apache-2.0
// The consent notice posted in the meeting chat.
// Main never stores the message text with a post record.

import type { IsoTime } from './common'

export type ConsentChannel = 'zoom' | 'teams' | 'meet'

export type ConsentStatusValue = 'attempted' | 'success' | 'failure' | 'unavailable' | 'copied' | 'confirmed' | 'cancelled'

export type ConsentReason =
  | 'composer-missing'
  | 'composer-not-empty'
  | 'composer-partial-text'
  | 'composer-unreadable'
  | 'several-meeting-windows'
  | 'foreground-lost'
  | 'timeout'
  | 'helper-unavailable'

export interface ConsentStatus {
  noteId: string
  channel: ConsentChannel | null
  /** null: nothing yet. */
  status: ConsentStatusValue | null
  reason: ConsentReason | null
  at: IsoTime | null
  /** Capture is held until the notice is handled. */
  pending: boolean
  waitingFor: 'other-speaker' | 'chat-field' | 'draft' | null
}

export const CONSENT_DEFAULT_MESSAGE = "Heads up: I'm using Notula to transcribe this call and take notes."

export const CONSENT_LIMITS = {
  messageMax: 500,
  fieldPollMs: 1_000,
  openChatHintMs: 15_000,
  budgetMs: 600_000,
  watchdogMs: 780_000,
  stopGraceMs: 5_000,
  restoreClipboardMs: 750,
  appGoneMs: 3_000
} as const
