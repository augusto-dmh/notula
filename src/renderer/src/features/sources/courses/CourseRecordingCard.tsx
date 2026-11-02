// SPDX-License-Identifier: Apache-2.0
// The `course-recording` card's body and buttons (Undo, Stop, Open note, and Set up when nothing
// can transcribe), drawn under the card's title in place of the generic actions row. Clicks go
// through `act('course:<action>')`.
//
// Not drawn yet.

import type { JSX } from 'react'
import type { NotificationAction, NotificationPayload } from '@shared/types/notify'

export function CourseRecordingCard(_props: { payload: NotificationPayload; act: (action: NotificationAction) => void }): JSX.Element | null {
  return null
}
