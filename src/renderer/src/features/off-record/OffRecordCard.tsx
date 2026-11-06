// SPDX-License-Identifier: Apache-2.0
// The privacy card, one component for the note and the bubble: the off-the-record choice, then
// the paused card after a removal. It never quotes the meeting. Main owns both states and the
// 30 s timer; the ring only shows the time left and keeps running under the pointer, because no
// answer means keep going.

import { useEffect, useId, useState, type JSX } from 'react'
import { OFF_RECORD_LIMITS, type OffRecordAnswer, type OffRecordCardState, type OffRecordSurface } from '@shared/types/off-record'
import { answerOffRecord } from './store'
import './off-record-card.css'

const SEND_FAILED = 'Couldn’t send your answer. Try again.'
const KEEP_LABEL = 'Continue the transcript without removing anything'

export interface OffRecordCardProps {
  surface: OffRecordSurface
  card: OffRecordCardState
  /** The paused card's primary action; resolves to an error line, or null once it worked. */
  onResume(): Promise<string | null>
  /** The paused card's primary label: the bubble resumes from the note. */
  resumeLabel?: string
}

export function OffRecordCard({ surface, card, onResume, resumeLabel = 'Resume' }: OffRecordCardProps): JSX.Element {
  const id = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const asking = card.state === 'asking'

  const answer = async (a: OffRecordAnswer): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const ok = await answerOffRecord(card.noteId, card.promptId, a, surface)
    setBusy(false)
    if (!ok && a !== 'dismiss') setError(SEND_FAILED)
  }
  const resume = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    const failed = await onResume().catch(() => SEND_FAILED)
    setBusy(false)
    setError(failed)
  }

  return (
    <div
      className={`nt-offcard nt-offcard--${surface}`}
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
    >
      <div className="nt-offcard__head">
        <span className="nt-offcard__icon" aria-hidden="true">
          <ShieldIcon />
        </span>
        <h2 className="nt-offcard__title" id={`${id}-title`}>
          {asking ? 'Privacy request heard' : 'Transcript paused for privacy'}
        </h2>
        {!asking ? (
          <button
            type="button"
            className="nt-offcard__dismiss"
            aria-label="Dismiss"
            title="Dismiss"
            disabled={busy}
            onClick={() => void answer('dismiss')}
          >
            <CloseMark size={10} />
          </button>
        ) : null}
      </div>
      <p className="nt-offcard__body" id={`${id}-body`}>
        {error ??
          (asking
            ? 'Remove what was said since then and pause the transcript?'
            : 'Notula removed what was said after the request.')}
      </p>
      <div className="nt-offcard__actions">
        {asking ? (
          <>
            <button type="button" className="nt-offcard__primary" disabled={busy} onClick={() => void answer('pause')}>
              Remove and pause
            </button>
            <KeepRing key={card.promptId} expiresAt={card.expiresAt} disabled={busy} onKeep={() => void answer('keep')} />
          </>
        ) : (
          <button type="button" className="nt-offcard__primary" disabled={busy} onClick={() => void resume()}>
            {resumeLabel}
          </button>
        )}
      </div>
    </div>
  )
}

const RING_R = 14
const RING_C = 2 * Math.PI * RING_R

/** Keep going: a round button whose ring empties as the choice runs out. */
function KeepRing({ expiresAt, disabled, onKeep }: { expiresAt: string; disabled: boolean; onKeep(): void }): JSX.Element {
  const end = Date.parse(expiresAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [end])
  const left = Number.isFinite(end) ? Math.min(1, Math.max(0, (end - now) / OFF_RECORD_LIMITS.promptMs)) : 0
  return (
    <button type="button" className="nt-offcard__keep" aria-label={KEEP_LABEL} title={KEEP_LABEL} disabled={disabled} onClick={onKeep}>
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
        <circle className="nt-offcard__ring-track" cx="17" cy="17" r={RING_R} />
        <circle
          className="nt-offcard__ring"
          cx="17"
          cy="17"
          r={RING_R}
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - left)}
          transform="rotate(-90 17 17)"
        />
      </svg>
      <span className="nt-offcard__keep-mark" aria-hidden="true">
        <CloseMark size={10} />
      </span>
    </button>
  )
}

function CloseMark({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

function ShieldIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5 5 6.2v5.3c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6.2Z" />
      <path d="M9.5 12h5" />
    </svg>
  )
}
