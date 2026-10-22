// SPDX-License-Identifier: Apache-2.0
// Notula-drawn notification windows.

import type { IsoTime } from './common'
import type { SourceCardAction, SourceCardPayload } from './sources'

/**
 * `info` is a Notula info card: title, body, at most 3 buttons, close. `source-detected` offers
 * a note on the video or lesson playing (content sources), with its own gates and menu.
 */
export type NotificationVariant = 'scheduled-meeting' | 'detected-meeting' | 'info' | 'source-detected'

export type NotificationAction =
  | 'click'
  | 'join_meeting'
  | 'start_note'
  | 'hide'
  | 'block'
  | 'unblock'
  | 'mute_app_notifications'
  | 'open_settings'
  /** `info:<NotificationInfoAction.id>`. */
  | `info:${string}`
  /** A `source-detected` card's buttons and menu items. */
  | `source:${SourceCardAction}`

/**
 * The normalized conference provider name (for example `Zoom`, `Google Meet`,
 * `Microsoft Teams`), from `detectConferenceLink`.
 */
export type ConferenceProvider = string

/** `notify:get-payload`, for the calling notification window. */
export interface NotificationPayload {
  id: string
  variant: NotificationVariant
  title: string
  body: string
  calendarEventId: string | null
  joinUrl: string | null
  conferenceProvider: ConferenceProvider | null
  micAppId: string | null
  micAppName: string | null
  autoStart: boolean
  countdownMs: number | null
  calendarColor: string | null
  location: string | null
  shownAt: IsoTime
  /** The card's detail line, e.g. a meaningful brief's headline. */
  detail: string | null
  /** The recurring-meeting recap. */
  lastTime: LastTimeRecap | null
  /** The `info` variant's buttons. */
  infoActions: NotificationInfoAction[]
  /** The `source-detected` variant's content; null for every other variant. */
  source: SourceCardPayload | null
}

/** A button on an `info` card. */
export interface NotificationInfoAction {
  id: string
  label: string
}

/** The recap of last time on a scheduled-meeting card: raw lines first, then the AI title and bullets. */
export interface LastTimeRecap {
  status: 'raw' | 'ready'
  title: string | null
  /** "EEE d MMM". */
  dateLabel: string
  meetingAt: IsoTime
  bullets: string[]
}

export const RECAP_LIMITS = {
  candidates: 5,
  displayChars: 420,
  modelChars: 6_000,
  titleMax: 58,
  bulletsMin: 2,
  bulletsMax: 3,
  bulletMax: 88,
  timeoutMs: 30_000,
  keepVersions: 2,
  decorateWaitMs: 300
} as const

export const NOTIFICATION_WIDTH = 404
export const NOTIFICATION_GAP = 12
