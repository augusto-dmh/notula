// SPDX-License-Identifier: Apache-2.0
// The off-the-record choice on the note being transcribed, and the notice after a pause for
// privacy. Main owns both (`off-record:prompt`, `off-record:paused`); this only draws them. The
// countdown keeps running while the pointer is over the card: no answer means keep going.

import { useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import type { OffRecordAnswer, OffRecordPaused, OffRecordPrompt } from '@shared/types/off-record'
import { countdownText } from './live'
import './off-record.css'

interface OffRecordState {
  prompt: OffRecordPrompt | null
  paused: OffRecordPaused | null
}

let state: OffRecordState = { prompt: null, paused: null }
let subscribed = false
const listeners = new Set<() => void>()

function set(patch: Partial<OffRecordState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

/** Follows main's pushes for the window's lifetime; the capture store starts it at mount. */
export function watchOffRecord(): void {
  if (subscribed) return
  subscribed = true
  window.notula.offRecord.onPrompt((prompt) => set({ prompt }))
  window.notula.offRecord.onPaused((paused) => set({ paused }))
}

function subscribe(cb: () => void): () => void {
  watchOffRecord()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useOffRecord(): OffRecordState {
  return useSyncExternalStore(subscribe, () => state)
}

/** Hides the paused notice in this window (a new start clears it everywhere). */
export function dismissOffRecordPaused(noteId: string): void {
  if (state.paused?.noteId === noteId) set({ paused: null })
}

const HELD_PREVIEW_CHARS = 240

export function OffRecordCard({ prompt }: { prompt: OffRecordPrompt }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [prompt.promptId])
  const countdown = countdownText(prompt.expiresAt, now)
  const answer = (a: OffRecordAnswer): void => {
    setBusy(true)
    void window.notula.offRecord
      .answer({ noteId: prompt.noteId, promptId: prompt.promptId, answer: a, surface: 'note' })
      .catch(() => undefined)
      .finally(() => setBusy(false))
  }
  const held = prompt.heldText.length > HELD_PREVIEW_CHARS ? `…${prompt.heldText.slice(-HELD_PREVIEW_CHARS)}` : prompt.heldText
  return (
    <div className="nt-prompt nt-offrecord" role="alertdialog" aria-labelledby="nt-offrecord-title" aria-describedby="nt-offrecord-body">
      <div className="nt-prompt__head">
        <span className="nt-prompt__icon" aria-hidden="true">
          <LockIcon />
        </span>
        <h2 className="nt-prompt__title" id="nt-offrecord-title">
          Keep this out of the notes?
        </h2>
        {countdown ? (
          <span className="nt-prompt__badge nt-offrecord__badge" aria-label={`Keeps going in ${countdown}`}>
            {countdown}
          </span>
        ) : null}
      </div>
      <p className="nt-prompt__body" id="nt-offrecord-body">
        Someone asked to go off the record. Notula is holding back what was said since then.
      </p>
      <blockquote className="nt-offrecord__quote">“{prompt.requestText}”</blockquote>
      {held ? <p className="nt-offrecord__held">{held}</p> : null}
      <div className="nt-prompt__actions">
        <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => answer('keep')}>
          Keep going
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy} onClick={() => answer('pause')}>
          Erase and pause
        </button>
      </div>
    </div>
  )
}

function LockIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </svg>
  )
}
