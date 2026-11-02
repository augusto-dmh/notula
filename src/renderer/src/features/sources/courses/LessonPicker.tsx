// SPDX-License-Identifier: Apache-2.0
// The lesson picker on a note's lesson label: the course's lessons in order, a search field, Not a
// lesson of this course, and Another course.
//
// Not drawn yet.

import type { JSX } from 'react'

export interface LessonPickerProps {
  noteId: string
  seriesId: string
  /** The label it opens from; the picker is placed under it. */
  anchor: HTMLElement | null
  onClose(): void
}

export function LessonPicker(_props: LessonPickerProps): JSX.Element | null {
  return null
}
