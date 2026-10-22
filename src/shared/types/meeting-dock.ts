// SPDX-License-Identifier: Apache-2.0
// The meeting dock window.

import type { IsoTime } from './common'

export type MeetingDockView = 'chat' | 'notes' | 'transcript'

export interface MeetingDockState {
  noteId: string | null
  captureState: 'starting' | 'on' | 'paused' | 'off'
  expanded: boolean
  view: MeetingDockView
  localOnlyBlocked: boolean
}

export interface MeetingDockExchange {
  id: string
  question: string
  answer: string
  status: 'done' | 'error' | 'interrupted'
  at: IsoTime
  sources: { noteId: string; title: string | null; kind: 'transcript' | 'note' }[]
}

export interface MeetingDockHistory {
  noteId: string
  exchanges: MeetingDockExchange[]
  pending: { question: string; startedAt: IsoTime } | null
  input: string
}

export const MEETING_DOCK_GEOMETRY = {
  minWidth: 251,
  minHeight: 162,
  grownWidth: 272,
  grownHeight: 296,
  margin: 24,
  answerTimeoutMs: 60_000,
  recipesCacheMs: 60_000
} as const
