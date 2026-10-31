// SPDX-License-Identifier: Apache-2.0
// The bubble's hover transcript panel (the transcript feature's TranscriptPanel, variant
// "bubble"): its own window beside the classic pill, or inside the docked strip.
//
// - it carries the per-meeting captions toggle while `captions.alwaysOn` is on; while
//   captions are active it shows only its controls, because the captions replace the hover
//   transcript;
// - it shows the screen-snapshot panel while snapshots run;
// - its bar carries the speakers' quiet line once the meeting's speakers wait for names.

import { useEffect, type JSX } from 'react'
import type { BubbleDocument } from '@shared/types/bubble'
import type { ScreenSnapshotsState } from '@shared/types/snapshots'
import { AttachmentImage } from '../attachments'
import { usePrefs } from '../calendar/store'
import { useCaptionsState } from '../captions'
import { mountCaptureMirror } from '../capture/store'
import { useScreenSnapshots } from '../snapshots'
import { SpeakerQuietLine, TranscriptPanel } from '../transcript'
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
  return <TranscriptBody doc={doc} />
}

/** The panel's content, for the classic panel window and the docked strip. */
export function TranscriptBody({ doc }: { doc: BubbleDocument | null }): JSX.Element {
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
        {/* "<n> speakers to name": the card can't show here. */}
        <SpeakerQuietLine noteId={doc.noteId} />
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
