// SPDX-License-Identifier: Apache-2.0
// The pill's snapshot button: main freezes the display
// under the cursor, the user drags a region, and the crop lands on the note and the clipboard.
// Disabled while a capture runs and during the 600 ms success state; a failure other than a
// cancel shows `Couldn’t capture screenshot`.

import { useEffect, useRef, useState, type JSX } from 'react'
import { BUBBLE_SNAPSHOT_LIMITS } from '@shared/types/snapshots'

type Phase = 'idle' | 'capturing' | 'done' | 'failed'

export function BubbleSnapshotButton({ noteId }: { noteId: string | null }): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const settle = (next: Phase, ms: number): void => {
    setPhase(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setPhase('idle'), ms)
  }

  const take = async (): Promise<void> => {
    // Nothing while no note is shown or a capture runs.
    if (!noteId || phase === 'capturing' || phase === 'done') return
    setPhase('capturing')
    try {
      const r = await window.notula.bubble.takeSnapshot({ noteId })
      if (r.status === 'attached') settle('done', BUBBLE_SNAPSHOT_LIMITS.successMs)
      else if (r.status === 'cancelled' || r.error === 'permission-denied') setPhase('idle')
      else settle('failed', 2_400)
    } catch {
      settle('failed', 2_400)
    }
  }

  const label = phase === 'failed' ? 'Couldn’t take the snapshot. Try again.' : 'Take a snapshot'
  return (
    <button
      type="button"
      className={`bubble-snap is-${phase}`}
      aria-label={label}
      title={label}
      disabled={phase === 'capturing' || phase === 'done' || !noteId}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        void take()
      }}
    >
      {phase === 'done' ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 8h3l1.6-2.4h6.8L17 8h3v11H4z" />
          <circle cx="12" cy="13.2" r="3.2" />
        </svg>
      )}
      <span className="bubble-sr" aria-live="polite">
        {phase === 'failed' ? 'Couldn’t take the snapshot. Try again.' : ''}
      </span>
    </button>
  )
}
