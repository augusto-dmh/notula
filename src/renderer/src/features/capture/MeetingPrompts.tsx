// SPDX-License-Identifier: Apache-2.0
// Above the note dock: the inactivity card and "Resume transcript?" after a sleep stop.
// Main owns both states; this only draws them. The reload notice stays a toast.

import { useEffect, useState, type JSX } from 'react'
import { answerResumePrompt, countdownText, useLiveSignals } from './live'
import { startTranscription, useCaptureSnapshot } from './store'
import './prompts.css'

/** Re-renders once a second while `on`, for the countdown. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

export function InactivityCard({ noteId, autoStopAt, compact }: { noteId: string; autoStopAt: string | null; compact?: boolean }): JSX.Element {
  const now = useNow(autoStopAt !== null)
  const countdown = countdownText(autoStopAt, now)
  const answer = (action: 'keep' | 'stop'): void => window.notula.capture.answerInactivity({ noteId, action })
  return (
    <div className={`nt-prompt${compact ? ' nt-prompt--compact' : ''}`} role="alertdialog" aria-labelledby="nt-inactivity-title">
      <div className="nt-prompt__head">
        <span className="nt-prompt__icon nt-prompt__icon--wait" aria-hidden="true">
          <HourglassIcon />
        </span>
        <h2 className="nt-prompt__title" id="nt-inactivity-title">
          Are you still there?
        </h2>
        {countdown ? (
          <span className="nt-prompt__badge" aria-label={`Stopping in ${countdown}`}>
            {countdown}
          </span>
        ) : null}
      </div>
      <p className="nt-prompt__body">
        {autoStopAt
          ? 'No one has spoken for a while, so transcription will stop when the timer runs out.'
          : 'No one has spoken for a while.'}
      </p>
      <div className="nt-prompt__actions">
        <button type="button" className="n-btn n-btn--sm" onClick={() => answer('stop')}>
          Stop transcribing
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => answer('keep')}>
          I’m still here
        </button>
      </div>
    </div>
  )
}

function ResumePrompt({ noteId }: { noteId: string }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resume = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await startTranscription(noteId)
    setBusy(false)
    if (r.ok) {
      answerResumePrompt(noteId, true)
      return
    }
    setError(
      r.reason === 'busy'
        ? 'Another note is transcribing.'
        : r.reason === 'no-asr'
          ? 'Set up transcription in Settings first.'
          : 'This note no longer exists.'
    )
  }
  return (
    <div className="nt-prompt" role="dialog" aria-labelledby="nt-resume-title">
      <div className="nt-prompt__head">
        <span className="nt-prompt__icon" aria-hidden="true">
          <MoonIcon />
        </span>
        <h2 className="nt-prompt__title" id="nt-resume-title">
          Resume transcript?
        </h2>
      </div>
      <p className="nt-prompt__body">
        {error ?? 'Transcription stopped while your computer was asleep.'}
      </p>
      <div className="nt-prompt__actions">
        <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => answerResumePrompt(noteId, false)}>
          Not now
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy} onClick={() => void resume()}>
          Resume
        </button>
      </div>
    </div>
  )
}

export function MeetingPrompts({ noteId }: { noteId: string }): JSX.Element | null {
  const live = useLiveSignals()
  const capture = useCaptureSnapshot()
  if (live.inactivity?.noteId === noteId && capture.transcribingNoteId === noteId) {
    return (
      <div className="nt-prompt-dock">
        <InactivityCard noteId={noteId} autoStopAt={live.inactivity.autoStopAt} />
      </div>
    )
  }
  if (live.resumed?.suspendedNoteId === noteId && capture.transcribingNoteId !== noteId) {
    return (
      <div className="nt-prompt-dock">
        <ResumePrompt noteId={noteId} />
      </div>
    )
  }
  return null
}

function HourglassIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

function MoonIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
    </svg>
  )
}
