// SPDX-License-Identifier: Apache-2.0
// The bubble window: the pill and, while one shows, a card beside it; while docked, the
// strip (BubbleDock.tsx). The pill is the app glyph, live audio bars from the normalized
// meter (or a spinner while starting or in error, a pause mark while off the record), and
// a "!" badge for a warning. A press starts main's window drag; a release within 3 px is
// a click that opens the note.

import { useEffect, useRef, useState, type CSSProperties, type JSX, type PointerEvent } from 'react'
import type { Rect } from '@shared/types/common'
import { usePrefs } from '../calendar/store'
import { mountCaptureMirror } from '../capture/store'
import { TranscriptionRulesBubbleBanner } from '../transcription-rules'
import { BubbleCard } from './BubbleCards'
import { DockedBubble } from './BubbleDock'
import { CLICK_SLOP_PX, PillFace } from './PillFace'
import { useSecondaryWindow } from './secondary'
import { useBubbleState } from './state'
import './bubble.css'

function ClassicPill(): JSX.Element {
  const { hovered, document: doc } = useBubbleState()
  // The snapshot button, and main's 130 px pill.
  const snapshots = usePrefs()?.['bubbleSnapshots.enabled'] === true
  const press = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null)
  const [pressed, setPressed] = useState(false)

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
      <PillFace snapshotButton={snapshots} />
    </div>
  )
}

const box = (r: Rect): CSSProperties => ({ position: 'absolute', left: r.x, top: r.y, width: r.width, height: r.height })

/** The classic window: the pill alone, or the pill and a card where main placed them. */
function ClassicBubble(): JSX.Element {
  const { layout } = useBubbleState()
  if (!layout?.card) {
    return (
      <div className="bubble-stage">
        <ClassicPill />
        {/* The transcription-rules banner beside the pill. */}
        <TranscriptionRulesBubbleBanner />
      </div>
    )
  }
  return (
    <div className="bubble-frame">
      <div className="bubble-stage" style={box(layout.pill)}>
        <ClassicPill />
      </div>
      <div className="bubble-card" style={box(layout.card)}>
        <BubbleCard />
      </div>
    </div>
  )
}

export function BubblePill(): JSX.Element {
  useSecondaryWindow('bubble')
  useEffect(() => mountCaptureMirror(), [])
  const { docked } = useBubbleState()
  return docked ? <DockedBubble docked={docked} /> : <ClassicBubble />
}
