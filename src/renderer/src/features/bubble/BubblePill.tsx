// SPDX-License-Identifier: Apache-2.0
// The pill: the app glyph, live audio bars from the normalized
// meter (or a spinner while starting or in error), and a "!" badge for a warning. A
// press starts main's window drag; a release within 3 px is a click that opens the
// note.

import { useEffect, useRef, useState, type JSX, type PointerEvent } from 'react'
import { usePrefs } from '../calendar/store'
import { mountCaptureMirror, useMeterLevels } from '../capture/store'
import { TranscriptionRulesBubbleBanner } from '../transcription-rules'
import { BubbleSnapshotButton } from './BubbleSnapshot'
import { useSecondaryWindow } from './secondary'
import { useBubbleState } from './state'
import './bubble.css'

const CLICK_SLOP_PX = 3
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

export function BubblePill(): JSX.Element {
  useSecondaryWindow('bubble')
  useEffect(() => mountCaptureMirror(), [])
  const { hovered, document: doc } = useBubbleState()
  // The snapshot button, and main's 130 px pill.
  const snapshots = usePrefs()?.['bubbleSnapshots.enabled'] === true
  const levels = useMeterLevels()
  const press = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null)
  const [pressed, setPressed] = useState(false)

  const transcription = doc?.transcription ?? 'starting'
  const busy = transcription === 'starting' || transcription === 'error'
  const level = Math.max(levels.microphone, levels.system)
  const tick = useWobble(!busy && level > 0.02)

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    press.current = { x: e.screenX, y: e.screenY, moved: false, id: e.pointerId }
    setPressed(true)
    window.notula.bubble.dragStart()
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const p = press.current
    if (!p || p.moved) return
    if (Math.hypot(e.screenX - p.x, e.screenY - p.y) > CLICK_SLOP_PX) p.moved = true
  }

  const finish = (e: PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const p = press.current
    if (!p || p.id !== e.pointerId) return
    press.current = null
    setPressed(false)
    window.notula.bubble.dragEnd()
    // A drag is never a click.
    if (!cancelled && !p.moved && doc) window.notula.bubble.openNote({ noteId: doc.noteId })
  }

  return (
    <div className="bubble-stage">
      <div
        className={`bubble-pill${hovered ? ' is-hovered' : ''}${pressed ? ' is-pressed' : ''}${snapshots ? ' has-snapshot' : ''}`}
        role="button"
        aria-label="Open Notula"
        title="Open Notula"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
      >
        <span className="bubble-glyph" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 18V6l12 12V6" />
          </svg>
        </span>
        <span className="bubble-center" aria-hidden="true">
          {busy ? (
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
        {snapshots ? <BubbleSnapshotButton noteId={doc?.noteId ?? null} /> : null}
        {doc?.warning ? (
          <span className="bubble-badge" title={doc.warning}>
            !
          </span>
        ) : null}
      </div>
      {/* The transcription-rules banner beside the pill. */}
      <TranscriptionRulesBubbleBanner />
    </div>
  )
}
