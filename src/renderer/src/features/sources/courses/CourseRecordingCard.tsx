// SPDX-License-Identifier: Apache-2.0
// The `course-recording` card's body and buttons (Undo, Stop, Open note, and Set up when nothing
// can transcribe), drawn under the card's title in place of the generic actions row. Clicks go
// through `act('course:<action>')`.
//
// The card's own title and body carry *Recording <lesson>* and *<course> · video audio*; this
// part adds why nothing transcribes (plan `none`) and the buttons. It never takes focus.

import type { JSX } from 'react'
import type { NotificationAction, NotificationPayload } from '@shared/types/notify'
import type { CourseCardPayload } from '@shared/types/sources'
import '../note/source-card.css'
import './courses.css'

function blockedLine(c: CourseCardPayload): string | null {
  if (c.plan !== 'none') return null
  if (c.blocked === 'local-only') return 'Transcription is blocked in local-only mode.'
  return 'Nothing transcribes yet. Set up transcription to get a transcript.'
}

export function CourseRecordingCard({ payload, act }: { payload: NotificationPayload; act: (action: NotificationAction) => void }): JSX.Element | null {
  const c = payload.course
  if (!c) return null
  const blocked = blockedLine(c)
  return (
    <div className="src-card course-card">
      {blocked ? (
        <p className="course-card__blocked" role="status">
          {blocked}
        </p>
      ) : null}
      <div className="src-card__actions">
        <button type="button" id="course-card-undo" className="src-card__btn" onClick={() => act('course:undo')}>
          Undo
        </button>
        <button type="button" id="course-card-stop" className="src-card__btn" onClick={() => act('course:stop')}>
          Stop
        </button>
        <button type="button" id="course-card-open" className="src-card__btn src-card__btn--primary" onClick={() => act('course:open-note')}>
          Open note
        </button>
        {blocked ? (
          <button type="button" id="course-card-set-up" className="src-card__btn" onClick={() => act('course:set-up')}>
            Set up
          </button>
        ) : null}
      </div>
    </div>
  )
}
