// SPDX-License-Identifier: Apache-2.0
// The pill's face, for the classic pill and the docked tab: the app glyph, live audio bars
// from the normalized meter (or a spinner while starting or in error, a pause mark while off
// the record), the snapshot button when asked, and a "!" badge for a warning.

import { useEffect, useState, type JSX } from 'react'
import { useMeterLevels } from '../capture/store'
import { BubbleSnapshotButton } from './BubbleSnapshot'
import { useOffRecord } from './off-record'
import { useBubbleState } from './state'

/** A release within this many px of the press is a click. */
export const CLICK_SLOP_PX = 3
const BAR_SHAPE = [0.62, 1, 0.78] as const
/** At rest the bars still read as a meter, not as dots. */
const BAR_REST = [4, 7, 5] as const
const BAR_MAX = 16

/** A little independent motion per bar, so a steady level still looks alive. */
function useWobble(active: boolean): number {
  const [t, setT] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setT((x) => x + 1), 140)
    return () => clearInterval(id)
  }, [active])
  return t
}

/** The glyph, the meter (or spinner, or pause mark) and the warning badge. */
export function PillFace({ snapshotButton }: { snapshotButton: boolean }): JSX.Element {
  const { document: doc } = useBubbleState()
  const { paused } = useOffRecord()
  const levels = useMeterLevels()
  const transcription = doc?.transcription ?? 'starting'
  const busy = transcription === 'starting' || transcription === 'error'
  const offRecord = !!doc && paused?.noteId === doc.noteId
  const level = Math.max(levels.microphone, levels.system)
  const tick = useWobble(!busy && !offRecord && level > 0.02)
  return (
    <>
      <span className="bubble-glyph" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 18V6l12 12V6" />
        </svg>
      </span>
      <span className="bubble-center" aria-hidden="true">
        {offRecord ? (
          <span className="bubble-paused" title="Notes on hold for privacy">
            <span />
            <span />
          </span>
        ) : busy ? (
          <span className={`bubble-spinner${transcription === 'error' ? ' is-error' : ''}`} />
        ) : (
          <span className="bubble-bars">
            {BAR_SHAPE.map((shape, i) => {
              const wobble = level > 0.02 ? 0.82 + 0.18 * Math.sin(tick * 1.7 + i * 2.1) : 1
              const rest = BAR_REST[i] ?? 4
              const h = rest + (BAR_MAX - rest) * Math.min(1, level * shape * wobble)
              return <span key={i} className="bubble-bar" style={{ height: `${h.toFixed(1)}px` }} />
            })}
          </span>
        )}
      </span>
      {snapshotButton ? <BubbleSnapshotButton noteId={doc?.noteId ?? null} /> : null}
      {doc?.warning ? (
        <span className="bubble-badge" title={doc.warning}>
          !
        </span>
      ) : null}
      {offRecord ? <span className="bubble-sr">Notes on hold for privacy</span> : null}
    </>
  )
}

