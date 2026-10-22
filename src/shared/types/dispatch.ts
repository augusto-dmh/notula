// SPDX-License-Identifier: Apache-2.0
// The dispatcher: action items turned into started chats.

import type { IsoTime } from './common'

export type DispatchType = 'email' | 'slack' | 'calendar'
export type DispatchTodoType = DispatchType | 'todo'
export type DispatchTodoStatus = 'open' | 'done' | 'dismissed'
export type DispatchStatus = 'open' | 'done' | 'archived'

export interface DispatchTodo {
  id: string
  action_item_id: string
  document_id: string | null
  type: DispatchTodoType
  confidence: 'high' | 'low' | null
  title: string
  task: string
  status: DispatchTodoStatus
  meeting_title: string | null
  meeting_at: IsoTime | null
  created_at: IsoTime
  updated_at: IsoTime
}

export interface Dispatch {
  id: string
  /** D1, D2 … within open dispatches. */
  label: string
  todo_id: string | null
  title: string
  type: DispatchType
  task: string
  source: string
  /** YYYY-MM-DD, local. */
  run_day: string
  reason: string | null
  thread_id: string | null
  status: DispatchStatus
  created_at: IsoTime
  updated_at: IsoTime
}

export type DispatchRunStatus = 'classifying' | 'starting' | 'done' | 'discarded' | 'error' | 'interrupted' | 'paused'

export interface DispatchList {
  view: 'today' | 'archived' | 'todos'
  todos: DispatchTodo[]
  dispatches: Dispatch[]
  status: {
    todos: 'extracting' | 'ready' | 'waiting' | 'unavailable'
    failedNotes: { noteId: string; title: string | null }[]
    lastRun: { day: string; status: DispatchRunStatus; reason: string | null; archived: number } | null
  }
}

export const DISPATCH_LIMITS = {
  maxPerRun: 5,
  todoWindowMs: 604_800_000,
  keepRunDays: 7,
  repairAttempts: 1,
  classifyTimeoutMs: 60_000,
  selectTimeoutMs: 90_000
} as const
