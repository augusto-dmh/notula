// SPDX-License-Identifier: Apache-2.0
// The demo stage window (`#/demo`): "Notula Demo", the line being
// "spoken" as a large caption, a progress bar, Pause / Resume and Close. The window has a hidden
// title bar, so the header is the drag region.

import { useEffect, type JSX } from 'react'
import { useDemoState } from './store'
import './demo.css'

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function DemoStage(): JSX.Element {
  const s = useDemoState()
  useEffect(() => {
    document.documentElement.classList.add('demo-window')
    document.title = 'Demo meeting'
  }, [])
  const finished = s.durationMs > 0 && s.elapsedMs >= s.durationMs
  const progress = s.durationMs > 0 ? Math.min(1, s.elapsedMs / s.durationMs) : 0
  return (
    <div className="demo-stage">
      <header className="demo-stage__bar">
        <span className="demo-stage__brand">
          <span className={`demo-stage__dot${s.playing ? ' is-live' : ''}`} aria-hidden="true" />
          Notula Demo
        </span>
        <span className="demo-stage__mode">{s.mode === 'replay' ? 'Replay' : 'Demo meeting'}</span>
      </header>
      <main className="demo-stage__body">
        <div className="demo-stage__avatar" aria-hidden="true">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 18V6l12 12V6" />
          </svg>
        </div>
        <div className="demo-stage__speaker">{s.speaker ?? 'Notula Demo'}</div>
        <p key={s.lineIndex} className={`demo-stage__caption${s.caption ? '' : ' is-waiting'}`} aria-live="polite">
          {finished ? 'That’s the demo. Your notes are on the right.' : (s.caption ?? 'The demo is about to start…')}
        </p>
      </main>
      <footer className="demo-stage__controls">
        <div className="demo-stage__progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <span style={{ width: `${(progress * 100).toFixed(1)}%` }} />
        </div>
        <div className="demo-stage__row">
          <span className="demo-stage__time">
            {clock(s.elapsedMs)} / {clock(s.durationMs)}
          </span>
          <div className="demo-stage__buttons">
            {finished ? null : (
              <button type="button" className="n-btn n-btn--sm" onClick={() => window.notula.demo.setPlaying({ playing: !s.playing })}>
                {s.playing ? 'Pause' : 'Resume'}
              </button>
            )}
            <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => window.notula.demo.close()}>
              Close
            </button>
          </div>
        </div>
      </footer>
    </div>
  )
}
