// SPDX-License-Identifier: Apache-2.0
// The cards inside the bubble window, one at a time: off the record first (it has a
// 30 s clock), then the inactivity warning, then a screen-snapshot notice. Main grows the
// classic window, or holds the docked strip, while one shows; this only draws it.

import { useEffect, useState, type JSX } from 'react'
import type { ScreenSnapshotsNotice, ScreenSnapshotsState } from '@shared/types/snapshots'
import { InactivityCard } from '../capture/MeetingPrompts'
import { countdownText } from '../capture/live'
import { useScreenSnapshots } from '../snapshots'
import { answerOffRecord, cardPrompt, useOffRecord } from './off-record'
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

/** Re-renders four times a second while `on`: the countdown never pauses, hover or not. */
function useClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [on])
  return now
}

function OffRecordCard({
  noteId,
  promptId,
  expiresAt,
  requestText,
  heldText
}: {
  noteId: string
  promptId: string
  expiresAt: string
  requestText: string | null
  heldText: string | null
}): JSX.Element {
  const now = useClock(true)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const countdown = countdownText(expiresAt, now)
  const answer = async (a: 'keep' | 'pause'): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailed(false)
    const ok = await answerOffRecord(noteId, promptId, a)
    setBusy(false)
    if (!ok) setFailed(true)
  }
  // The prompt's own text when it came; plain wording when only the hold is known.
  const body = requestText?.trim() || 'Someone may have asked to go off the record. Pause transcription for now?'
  const held = heldText?.trim()
  return (
    <div className="nt-prompt nt-prompt--compact bubble-offrecord" role="alertdialog" aria-labelledby="bubble-offrecord-title" aria-describedby="bubble-offrecord-body">
      <div className="nt-prompt__head">
        <h2 className="nt-prompt__title" id="bubble-offrecord-title">
          Leave what comes next out of the notes?
        </h2>
        {countdown ? (
          <span className="nt-prompt__badge" aria-label={`${countdown} left to answer`}>
            {countdown}
          </span>
        ) : null}
      </div>
      <p className="nt-prompt__body" id="bubble-offrecord-body">
        {failed ? 'Couldn’t send your answer. Try again, or answer in the note.' : body}
      </p>
      {held && !failed ? <p className="bubble-offrecord__held">{held}</p> : null}
      <div className="nt-prompt__actions">
        <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => void answer('keep')}>
          Transcribe as usual
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy} onClick={() => void answer('pause')}>
          Pause
        </button>
      </div>
    </div>
  )
}

/** Whichever card applies now, or null. */
export function BubbleCard(): JSX.Element | null {
  const { document: doc, offRecord: hold } = useBubbleState()
  const { prompt } = useOffRecord()
  const snaps = useScreenSnapshots(doc?.noteId ?? null)
  const offRecord = cardPrompt(hold, prompt)
  if (offRecord) {
    return (
      <OffRecordCard
        key={offRecord.promptId}
        noteId={offRecord.noteId}
        promptId={offRecord.promptId}
        expiresAt={offRecord.expiresAt}
        requestText={offRecord.requestText}
        heldText={offRecord.heldText}
      />
    )
  }
  if (doc?.inactivity) return <InactivityCard noteId={doc.inactivity.noteId} autoStopAt={doc.inactivity.autoStopAt} compact />
  return snaps ? <SnapshotNotice state={snaps} /> : null
}
