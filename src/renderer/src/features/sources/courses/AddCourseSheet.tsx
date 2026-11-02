// SPDX-License-Identifier: Apache-2.0
// The Add course sheet, also Course settings: course, name, where you watch it, the history and
// window switch, lesson list, when a lesson plays, when it ends, audio, captions.
//
// Not drawn yet.

import type { JSX } from 'react'
import type { CourseListItem } from '@shared/types/sources'

export interface AddCourseSheetProps {
  /** `settings`: Course settings for `seriesId`. */
  mode: 'add' | 'settings'
  /** Settings, or Add for a series already in Sources (a chip menu, the importer). */
  seriesId?: string | null
  /** Opened from a card or Recently played. */
  playbackId?: string | null
  /** A course or lesson URL typed into the link field. */
  url?: string | null
  /** The course added or saved; null when cancelled. */
  onClose(result: CourseListItem | null): void
}

export function AddCourseSheet(_props: AddCourseSheetProps): JSX.Element | null {
  return null
}
