// SPDX-License-Identifier: Apache-2.0
// The cards inside the bubble window, one at a time: the privacy card first (off the record:
// the choice with its 30 s clock, then the paused card), then the inactivity warning, then a
// screen-snapshot notice. Main grows the classic window, or holds the docked strip, while one
// shows; this only draws it.

import { useState, type JSX } from 'react'
import type { ScreenSnapshotsNotice, ScreenSnapshotsState } from '@shared/types/snapshots'
import { InactivityCard } from '../capture/MeetingPrompts'
import { OffRecordCard } from '../off-record'
import { useScreenSnapshots } from '../snapshots'
import { useBubbleState } from './state'

const NOTICE: Record<ScreenSnapshotsNotice, { title: string; body: string | null; action: 'choose' | 'off' | null }> = {
  'capture-offer': {
    title: 'Add screen snapshots?',
    body: 'Pick a window or screen, and Notula adds images of only that source to this note.',
    action: 'choose'
  },
  'permission-checking': {
    title: 'Checking screen access',
    body: 'Notula is looking for screen recording access…',
    action: null
  },
  'capture-enabled': {
    title: 'Snapshots are on',
    body: 'Only the source you picked goes into this note.',
    action: null
  },
  paused: { title: 'Snapshots on hold', body: 'Resume them to add more images to this note.', action: null },
  'capture-failed': { title: 'Couldn’t take a snapshot', body: 'To try again, pick a source again.', action: 'choose' },
  'too-large': { title: 'Couldn’t take a snapshot', body: 'The source you picked is too large for a snapshot.', action: null }
}

/** Informational notices hide on their own after 5 s; closing one only hides it here. */
const INFORMATIONAL: ReadonlySet<ScreenSnapshotsNotice> = new Set(['capture-enabled', 'paused', 'too-large'])

function SnapshotNotice({ state }: { state: ScreenSnapshotsState }): JSX.Element | null {
  const [hidden, setHidden] = useState<ScreenSnapshotsNotice | null>(null)
  const n = state.notice
  if (!n || hidden === n) return null
  const copy = NOTICE[n]
  // Dismissing the offer (or a failure) turns snapshots off for this meeting.
  const hide = (): void => {
    if (INFORMATIONAL.has(n)) setHidden(n)
    else void window.notula.screenSnapshots.stop({ noteId: state.noteId, reason: 'user' })
  }
  return (
    <div className="bubble-notice" role="status">
      <button type="button" className="bubble-notice__close" aria-label="Hide snapshot notice" onClick={hide}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
      <div className="bubble-notice__title">{copy.title}</div>
      {copy.body ? <div className="bubble-notice__body">{copy.body}</div> : null}
      {n === 'permission-checking' ? (
        <button type="button" className="bubble-notice__btn" onClick={() => window.notula.screenGuide.open()}>
          Open settings
        </button>
      ) : copy.action === 'choose' ? (
        <button type="button" className="bubble-notice__btn" onClick={() => window.notula.screenSnapshots.openPicker({ noteId: state.noteId })}>
          {n === 'capture-offer' ? 'Choose' : 'Choose again'}
        </button>
      ) : null}
    </div>
  )
}

/**
 * The bubble can't start capture (the main window runs it), so its Resume opens the note,
 * where the same card offers Resume.
 */
async function resumeInNote(noteId: string): Promise<null> {
  window.notula.bubble.openNote({ noteId })
  return null
}

/** Whichever card applies now, or null. */
export function BubbleCard(): JSX.Element | null {
  const { document: doc, offRecord } = useBubbleState()
  const snaps = useScreenSnapshots(doc?.noteId ?? null)
  if (offRecord) {
    return (
      <OffRecordCard
        key={`${offRecord.state}:${offRecord.promptId}`}
        surface="bubble"
        card={offRecord}
        onResume={() => resumeInNote(offRecord.noteId)}
        resumeLabel="Resume in note"
      />
    )
  }
  if (doc?.inactivity) return <InactivityCard noteId={doc.inactivity.noteId} autoStopAt={doc.inactivity.autoStopAt} compact />
  return snaps ? <SnapshotNotice state={snaps} /> : null
}
