// SPDX-License-Identifier: Apache-2.0
// Small helpers the Courses views share: the study-vault picker's bridge, lesson labels, Open
// lesson, and failure text.

import { parseError } from '@shared/errors'
import type { BrowserId, SourceSeries } from '@shared/types/sources'
import { showToast } from '../../../app/toast'
import { isMissingHandler } from '../note/source-store'
import { refreshCourses } from './courses-store'

// ---------- the study vault ----------

export interface VaultCourse {
  /** The course folder's handle, for `{ kind: 'vault', handle }`. */
  folder: string
  title: string
  /** Lesson folders found. */
  items: number
  /** Lessons with a lesson URL. */
  urls: number
}

/** Picks the study vault (or a folder in it); null when cancelled. */
export function pickVaultFolder(): Promise<{ handle: string; name: string } | null> {
  return window.notula.sources.pickVaultFolder()
}

/** The course folders in a picked folder. */
export function listVaultCourses(handle: string): Promise<VaultCourse[]> {
  return window.notula.sources.listVaultCourses(handle)
}

// ---------- words ----------

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** A lesson's label: the list's own ("Aula 53"), else "Lesson 53", else null. */
export function lessonLabel(label: string | null, number: number | null): string | null {
  if (label?.trim()) return label.trim()
  return number !== null ? `Lesson ${number}` : null
}

export const BROWSER_NAME: Partial<Record<BrowserId, string>> = { chrome: 'Chrome', edge: 'Edge', brave: 'Brave' }

/** Failure text: main's own message for input errors, else a plain retry line. */
export function failure(err: unknown, action: string): string {
  if (isMissingHandler(err)) return 'Courses isn’t available in this build yet.'
  const { code, message } = parseError(err)
  if ((code === 'invalid-input' || code === 'busy' || code === 'not-found') && message) return message
  return `Couldn’t ${action}. Try again.`
}

// ---------- Open lesson ----------

/** Opens a lesson in its course app, else the default browser. */
export async function openLesson(seriesId: string, catalogItemId: string): Promise<void> {
  try {
    const r = await window.notula.sources.openLesson({ seriesId, catalogItemId })
    if (r.opened === 'none') {
      showToast({ kind: 'error', title: 'Couldn’t open this lesson', description: 'Its link isn’t known yet. Play it once in the course to add it.' })
    }
  } catch (err) {
    showToast({ kind: 'error', title: 'Couldn’t open this lesson', description: failure(err, 'open the lesson') })
  }
}

// ---------- Remove from Courses ----------

/**
 * Removes a course (notes, folder and lesson list stay). The toast's Undo adds it back with the
 * same behavior and match; its lesson list was never touched.
 */
export async function removeCourseWithUndo(course: Pick<SourceSeries, 'id' | 'title' | 'on_play' | 'on_end' | 'match'>): Promise<boolean> {
  try {
    await window.notula.sources.removeCourse({ seriesId: course.id })
  } catch (err) {
    showToast({ kind: 'error', title: 'Couldn’t remove this course', description: failure(err, 'remove the course') })
    return false
  }
  refreshCourses()
  showToast({
    kind: 'success',
    title: `Removed “${course.title}” from Courses`,
    description: 'Its notes, folder and lesson list stay.',
    durationMs: 10_000,
    action: {
      label: 'Undo',
      onClick: () =>
        void window.notula.sources
          .addCourse({
            seriesId: course.id,
            draft: null,
            title: course.title,
            behavior: { onPlay: course.on_play, onEnd: course.on_end },
            match: course.match ?? { apps: [], hosts: [], titles: [], keys: [], windowRead: false },
            lessonList: { kind: 'later' },
            captions: false,
            playbackId: null
          })
          .then(refreshCourses)
          .catch((err: unknown) => showToast({ kind: 'error', title: 'Couldn’t undo', description: failure(err, 'add the course back') }))
    }
  })
  return true
}
