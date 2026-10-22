// SPDX-License-Identifier: Apache-2.0
// Live context cards.

import type { IsoTime } from './common'

export type LiveContextMode = 'off' | 'search' | 'calendar'

export interface LiveContextCard {
  id: string
  noteId: string
  kind: 'calendar' | 'search'
  status: 'loading' | 'ready' | 'answered' | 'error'
  trigger: 'intent' | 'meeting-ending'
  confidence: 'high' | 'low' | null
  question: string | null
  query: string | null
  answer: string | null
  sources: { noteId: string; title: string | null; snippet: string }[]
  slot: { title: string; start: IsoTime; end: IsoTime; attendees: string[] } | null
  errorMessage: string | null
  createdAt: IsoTime
}

export const LIVE_CONTEXT_LIMITS = {
  turnGapMs: 800,
  completionThreshold: 0.8,
  contextTurns: 10,
  bufferTurns: 12,
  classifyTimeoutMs: 12_000,
  answerTimeoutMs: 22_000,
  stickyCalendarMs: 90_000,
  loadingExpiryMs: 10_000,
  hideDelayMs: 400,
  window: { width: 400, height: 400 },
  meetingEndingMs: 300_000,
  slotMinMin: 15,
  slotMaxMin: 180,
  slotMinDays: 1,
  slotMaxDays: 7,
  followUpMin: 30,
  followUpDays: 7,
  workHours: { start: '09:00', end: '17:00' },
  searchResults: 8
} as const

export const GOOGLE_CALENDAR_TEMPLATE_URL = 'https://calendar.google.com/calendar/render'
