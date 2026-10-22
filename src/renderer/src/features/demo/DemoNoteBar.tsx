// SPDX-License-Identifier: Apache-2.0
// A demo note's dock bar, in place of MeetingControls: while the demo plays, its
// state, Pause / Resume and End demo; afterwards `Replay video`. Demo notes
// never capture, so the bar opens the note's transcript itself.

import { useEffect, useRef, useState, type JSX } from 'react'
import { TranscriptPanel } from '../transcript'
import { useDemoState } from './store'
import './demo.css'

function TranscriptIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h10M4 17h13" />
    </svg>
  )
}

export function DemoBar({ noteId }: { noteId: string }): JSX.Element {
  const s = useDemoState()
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const mine = s.active && s.noteId === noteId
  const live = mine && s.mode === 'live'
  const finished = mine && s.durationMs > 0 && s.elapsedMs >= s.durationMs
  // The script points at the live transcript, so a live run opens it once, unless the
  // side window is too narrow to keep the notepad visible beside it.
  const opened = useRef(false)
  useEffect(() => {
    if (live && !opened.current) {
      opened.current = true
      if (window.innerWidth >= 900) setTranscriptOpen(true)
    }
  }, [live])
  return (
    <>
      <div className="demo-bar" role="group" aria-label="Demo meeting">
        {mine ? (
          <>
            <span className={`demo-bar__status${s.playing ? ' is-live' : ''}`}>
              <span className="demo-bar__dot" aria-hidden="true" />
              {finished ? 'Demo finished' : s.playing ? (live ? 'Demo playing' : 'Replaying') : 'Paused'}
            </span>
            {finished ? null : (
              <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => window.notula.demo.setPlaying({ playing: !s.playing })}>
                {s.playing ? 'Pause' : 'Resume'}
              </button>
            )}
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => window.notula.demo.close()}>
              {live && !finished ? 'End demo' : 'Close video'}
            </button>
          </>
        ) : (
          <button type="button" className="n-btn n-btn--sm" onClick={() => window.notula.demo.join({ noteId, mode: 'replay' })}>
            Replay video
          </button>
        )}
        <span className="n-tooltip" data-tooltip={transcriptOpen ? 'Hide transcript' : 'Show transcript'}>
          <button
            type="button"
            className={`n-icon-btn n-icon-btn--sm${transcriptOpen ? ' is-active' : ''}`}
            aria-label={transcriptOpen ? 'Hide transcript' : 'Show transcript'}
            aria-pressed={transcriptOpen}
            onClick={() => setTranscriptOpen((o) => !o)}
          >
            <TranscriptIcon />
          </button>
        </span>
      </div>
      {transcriptOpen ? (
        <aside className="demo-transcript" aria-label="Transcript">
          <TranscriptPanel noteId={noteId} reveal={null} onClose={() => setTranscriptOpen(false)} />
        </aside>
      ) : null}
    </>
  )
}
