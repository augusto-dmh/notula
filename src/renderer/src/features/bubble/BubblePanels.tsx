// SPDX-License-Identifier: Apache-2.0
// The bubble's side windows: the hover transcript panel (the transcript feature's
// TranscriptPanel, variant "bubble") and the inactivity window.
//
// - the hover panel carries the per-meeting captions toggle while `captions.alwaysOn` is
//   on; while captions are active it shows only its controls,
//   because the captions replace the hover transcript;
// - it shows the screen-snapshot panel while snapshots run;
// - the inactivity window doubles as the side card for the snapshot notices.

import { useEffect, useState, type JSX } from 'react'
import type { ScreenSnapshotsNotice, ScreenSnapshotsState } from '@shared/types/snapshots'
import { AttachmentImage } from '../attachments'
import { usePrefs } from '../calendar/store'
import { useCaptionsState } from '../captions'
import { InactivityCard } from '../capture/MeetingPrompts'
import { useLiveSignals } from '../capture/live'
import { mountCaptureMirror } from '../capture/store'
import { useScreenSnapshots } from '../snapshots'
import { TranscriptPanel } from '../transcript'
import { useSecondaryWindow } from './secondary'
import { useBubbleState } from './state'
import './bubble.css'

const noop = (): void => undefined

function CaptionsToggle({ noteId }: { noteId: string }): JSX.Element | null {
  const prefs = usePrefs()
  const captions = useCaptionsState()
  if (prefs?.['captions.alwaysOn'] !== true) return null
  const on = captions.active && captions.noteId === noteId
  return (
    <button
      type="button"
      className={`bubble-chip${on ? ' is-on' : ''}`}
      aria-pressed={on}
      onClick={() => void window.notula.captions.setEnabled({ noteId, enabled: !on })}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="M7 13h4M13 13h4M7 16h7" />
      </svg>
      {on ? 'Captions on' : 'Live captions'}
    </button>
  )
}

function SnapshotPanel({ state }: { state: ScreenSnapshotsState }): JSX.Element | null {
  if (state.state !== 'capturing' && state.state !== 'paused' && state.state !== 'starting') return null
  const paused = state.state === 'paused'
  const shots = [...state.snapshots].reverse()
  return (
    <section className="bubble-snaps" aria-label="Screen snapshots">
      <div className="bubble-snaps__head">
        <span className="bubble-snaps__title">{paused ? 'Paused snapshots' : 'Taking snapshots'}</span>
        {shots.length > 0 ? <span className="bubble-snaps__count">{shots.length}</span> : null}
      </div>
      {paused ? <div className="bubble-snaps__hint">No new snapshots until you resume them.</div> : null}
      {shots.length === 0 ? (
        <div className="bubble-snaps__empty">No images yet</div>
      ) : (
        <div className="bubble-snaps__strip">
          {shots.slice(0, 12).map((s) => (
            <AttachmentImage key={s.attachmentId} attachmentId={s.attachmentId} alt={s.description ?? 'Screen snapshot'} className="bubble-snaps__img" />
          ))}
        </div>
      )}
      <button type="button" className="bubble-snaps__off" onClick={() => void window.notula.screenSnapshots.stop({ noteId: state.noteId, reason: 'user' })}>
        Turn off for this meeting
      </button>
    </section>
  )
}

export function BubbleTranscript(): JSX.Element {
  useSecondaryWindow('bubble-transcript')
  useEffect(() => mountCaptureMirror(), [])
  const { document: doc } = useBubbleState()
  const captions = useCaptionsState()
  const snaps = useScreenSnapshots(doc?.noteId ?? null)
  const captionsActive = !!doc && captions.active && captions.noteId === doc.noteId
  if (!doc) {
    return (
      <div className="bubble-panel">
        <div className="bubble-panel__empty">Transcript paused</div>
      </div>
    )
  }
  const extras = (
    <>
      <div className="bubble-panel__bar">
        <CaptionsToggle noteId={doc.noteId} />
      </div>
      {snaps ? <SnapshotPanel state={snaps} /> : null}
    </>
  )
  if (captionsActive) {
    return <div className="bubble-panel bubble-panel--compact">{extras}</div>
  }
  return (
    <div className="bubble-panel bubble-panel--stack">
      {extras}
      <div className="bubble-panel__transcript">
        <TranscriptPanel noteId={doc.noteId} reveal={null} onClose={noop} variant="bubble" />
      </div>
    </div>
  )
}

const NOTICE: Record<ScreenSnapshotsNotice, { title: string; body: string | null; action: 'choose' | 'off' | null }> = {
  'capture-offer': {
    title: 'Take snapshots',
    body: 'Notula can capture slides or a shared screen during the meeting and add the images to your notes.',
    action: 'choose'
  },
  'permission-checking': {
    title: 'Did you allow screen recording?',
    body: 'Notula is checking the permission now…',
    action: null
  },
  'capture-enabled': {
    title: 'All set up',
    body: 'Notula will take snapshots of what you picked and add them to your notes.',
    action: null
  },
  paused: { title: 'Paused snapshots', body: 'No new snapshots until you resume them.', action: null },
  'capture-failed': { title: 'Notula couldn’t take the snapshot', body: 'Pick the window or screen again to retry.', action: 'choose' },
  'too-large': { title: 'Notula couldn’t take the snapshot', body: 'That window is too large to snapshot.', action: null }
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

export function BubbleInactivity(): JSX.Element {
  useSecondaryWindow('bubble-inactivity')
  useEffect(() => mountCaptureMirror(), [])
  const { inactivity } = useLiveSignals()
  const { document: doc } = useBubbleState()
  const snaps = useScreenSnapshots(doc?.noteId ?? null)
  return (
    <div className="bubble-inactivity">
      {inactivity ? (
        <InactivityCard noteId={inactivity.noteId} autoStopAt={inactivity.autoStopAt} compact />
      ) : snaps ? (
        <SnapshotNotice state={snaps} />
      ) : null}
    </div>
  )
}
