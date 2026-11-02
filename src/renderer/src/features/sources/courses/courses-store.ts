// SPDX-License-Identifier: Apache-2.0
// The renderer's course list, shared by the sidebar section, the folder list (which hides course
// folders), the source chip, the lesson picker's Another course and Settings ▸ Sources. One
// `sources:list-courses` per change, never one call per row. It follows `sources:courses-changed`
// and `sources:changed` (counts move as notes are linked), debounced.
//
// Also the Add course sheet's opener, for entry points that live outside a mounted view (the
// sidebar's Add course row). The host that draws it is mounted by the Courses section.

import { useSyncExternalStore } from 'react'
import type { CourseListItem } from '@shared/types/sources'
import type { AddCourseSheetProps } from './AddCourseSheet'
import { trySources } from '../note/source-store'

const REFRESH_DELAY_MS = 250

function emitter(): { subscribe(cb: () => void): () => void; emit(): void } {
  const listeners = new Set<() => void>()
  return {
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    emit() {
      for (const l of listeners) l()
    }
  }
}

// ---------- the course list ----------

const listEvents = emitter()
let courses: CourseListItem[] | null = null
let started = false
let timer: ReturnType<typeof setTimeout> | null = null
let seq = 0

function load(): void {
  const mine = ++seq
  void trySources('sources:list-courses-failed', () => window.notula.sources.listCourses()).then((list) => {
    if (mine !== seq) return
    courses = list ?? []
    listEvents.emit()
  })
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    load()
  }, REFRESH_DELAY_MS)
}

function start(): void {
  if (started) return
  started = true
  window.notula.sources.onCoursesChanged(schedule)
  window.notula.sources.onChanged(schedule)
  load()
}

/** Reloads now (after an add, a save or a removal, before the push arrives). */
export function refreshCourses(): void {
  if (started) load()
}

/** Courses, last watched first; null until the first load. */
export function useCourses(): CourseListItem[] | null {
  return useSyncExternalStore((cb) => {
    start()
    return listEvents.subscribe(cb)
  }, () => courses)
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
let folderIds: { from: CourseListItem[] | null; ids: ReadonlySet<string> } = { from: null, ids: EMPTY_IDS }

function courseFolderIds(): ReadonlySet<string> {
  if (folderIds.from !== courses) {
    folderIds = { from: courses, ids: new Set((courses ?? []).flatMap((c) => (c.folder_id ? [c.folder_id] : []))) }
  }
  return folderIds.ids
}

/** The folders of courses, which show under Courses and not under the folders; empty while `enabled` is off. */
export function useCourseFolderIds(enabled: boolean): ReadonlySet<string> {
  return useSyncExternalStore(
    (cb) => {
      if (!enabled) return () => undefined
      start()
      return listEvents.subscribe(cb)
    },
    () => (enabled ? courseFolderIds() : EMPTY_IDS)
  )
}

/** Last watched first; never watched by name. */
export function byLastWatched(list: readonly CourseListItem[]): CourseListItem[] {
  return [...list].sort((a, b) => {
    const at = a.lastWatchedAt ?? ''
    const bt = b.lastWatchedAt ?? ''
    if (at !== bt) return at < bt ? 1 : -1
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  })
}

// ---------- the Add course sheet ----------

export type SheetRequest = Omit<AddCourseSheetProps, 'onClose'> & { onClose?(result: CourseListItem | null): void }

const sheetEvents = emitter()
let sheet: SheetRequest | null = null

/** Opens the Add course sheet (or Course settings) in the window's host. */
export function openAddCourseSheet(req: SheetRequest): void {
  sheet = req
  sheetEvents.emit()
}

export function closeAddCourseSheet(): void {
  sheet = null
  sheetEvents.emit()
}

export function useSheetRequest(): SheetRequest | null {
  return useSyncExternalStore(sheetEvents.subscribe, () => sheet)
}
