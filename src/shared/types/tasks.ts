// SPDX-License-Identifier: Apache-2.0
// The Tasks page over summary checkboxes.

import type { IsoTime } from './common'

export interface TaskItem {
  documentId: string
  panelId: string
  nodePath: number[]
  text: string
  checked: boolean
  description: string | null
  context: string
}

export interface TaskGroup {
  documentId: string
  title: string | null
  meetingAt: IsoTime
  items: TaskItem[]
}

export interface ManualTask {
  id: string
  text: string
  checked: boolean
  created_at: IsoTime
}

export interface TasksList {
  manual: ManualTask[]
  groups: TaskGroup[]
  olderCount: number
  openCount: number
}

/** A Tasks page checkbox toggle: an item in a meeting summary, or a manual task. */
export type TaskToggle =
  | { kind: 'meeting'; documentId: string; panelId: string; nodePath: number[]; checked: boolean }
  | { kind: 'manual'; id: string; checked: boolean }

export const TASKS_LIMITS = { windowMs: 604_800_000, textMax: 500 } as const
