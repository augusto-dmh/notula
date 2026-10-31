// SPDX-License-Identifier: Apache-2.0
// The docked bubble (Labs `bubble.dock`): the strip main lays along a display edge. It
// draws the pill as a slim tab that widens as the pointer nears the edge, the live
// transcript panel beside it while main says the panel is open, and a card when one shows.
//
// - It reports where it takes the mouse (`bubble:dock-region`) and how much room it needs
//   (`bubble:dock-extent`); main sizes the window and switches click-through.
// - A vertical drag on the pill moves it (`bubble:dock-move`, after the 3 px click
//   threshold); a click opens the note.
// - The panel resizes from its top, bottom, outer side and outer corners
//   (`bubble:panel-resize`); a double-click on an edge goes back to the default size.

import { useEffect, useRef, useState, type CSSProperties, type JSX, type PointerEvent } from 'react'
import {
  BUBBLE_DOCK as D,
  dockCardRect,
  dockPanelRect,
  dockPillRect,
  type BubbleDocked,
  type BubbleDockExtent,
  type BubbleDockRect,
  type BubblePanelEdge
} from '@shared/types/bubble'
import type { Rect } from '@shared/types/common'
import { useScreenSnapshots } from '../snapshots'
import { BubbleCard } from './BubbleCards'
import { TranscriptBody } from './BubblePanels'
import { CLICK_SLOP_PX, PillFace } from './PillFace'
import { useBubbleState } from './state'

const box = (r: Rect): CSSProperties => ({ position: 'absolute', left: r.x, top: r.y, width: r.width, height: r.height })

function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = (): void => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

/** Sends `value` when its JSON changes. */
function useReport<T>(value: T, send: (v: T) => void): void {
  const last = useRef('')
  const json = JSON.stringify(value)
  useEffect(() => {
    if (json === last.current) return
    last.current = json
    send(JSON.parse(json) as T)
  }, [json, send])
}

const sendRegion = (rects: BubbleDockRect[]): void => window.notula.bubble.dockRegion({ rects })
const sendExtent = (extent: BubbleDockExtent): void => window.notula.bubble.dockExtent(extent)

function DockPill({ docked, expanded, closeness }: { docked: BubbleDocked; expanded: boolean; closeness: number }): JSX.Element {
  const { hovered, document: doc } = useBubbleState()
  const press = useRef<{ y: number; moved: boolean; id: number } | null>(null)
  const [pressed, setPressed] = useState(false)

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    press.current = { y: e.screenY, moved: false, id: e.pointerId }
    setPressed(true)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const p = press.current
    if (!p || p.id !== e.pointerId) return
    const dy = e.screenY - p.y
    if (!p.moved) {
      if (Math.abs(dy) <= CLICK_SLOP_PX) return
      p.moved = true
      window.notula.bubble.dockMove({ phase: 'start', dy: 0 })
    }
    window.notula.bubble.dockMove({ phase: 'move', dy })
  }

  const finish = (e: PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const p = press.current
    if (!p || p.id !== e.pointerId) return
    press.current = null
    setPressed(false)
    if (p.moved) window.notula.bubble.dockMove({ phase: 'end', dy: e.screenY - p.y })
    // A move is never a click.
    else if (!cancelled && doc) window.notula.bubble.openNote({ noteId: doc.noteId })
  }

  // From a slim tab at rest to the full pill at the edge, on hover, or while anything is open.
  const c = expanded || hovered ? 1 : closeness
  const style = { '--dock-open': c } as CSSProperties
  return (
    <div
      className={`bubble-dock-pill is-${docked.side}${hovered || expanded ? ' is-hovered' : ''}${pressed ? ' is-pressed' : ''}`}
      style={style}
      role="button"
      aria-label="Open Notula"
      title="Open Notula"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
    >
      <span className="bubble-dock-pill__face">
        <PillFace snapshotButton={false} />
      </span>
    </div>
  )
}

const EDGE_CURSOR: Record<BubblePanelEdge, string> = {
  top: 'ns-resize',
  bottom: 'ns-resize',
  outer: 'ew-resize',
  'top-outer': 'nwse-resize',
  'bottom-outer': 'nesw-resize'
}

function ResizeHandle({ edge, side }: { edge: BubblePanelEdge; side: BubbleDocked['side'] }): JSX.Element {
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  // The outer corners mirror on the left edge.
  const cursor = side === 'left' && edge.endsWith('-outer') ? (edge === 'top-outer' ? 'nesw-resize' : 'nwse-resize') : EDGE_CURSOR[edge]
  const send = (phase: 'start' | 'move' | 'end', e: PointerEvent<HTMLDivElement>): void => {
    const s = start.current
    if (!s) return
    window.notula.bubble.panelResize({ phase, edge, dx: e.screenX - s.x, dy: e.screenY - s.y })
  }
  return (
    <div
      className={`bubble-dock-resize is-${edge}`}
      style={{ cursor }}
      aria-hidden="true"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.screenX, y: e.screenY, id: e.pointerId }
        send('start', e)
      }}
      onPointerMove={(e) => {
        if (start.current?.id === e.pointerId) send('move', e)
      }}
      onPointerUp={(e) => {
        if (start.current?.id !== e.pointerId) return
        send('end', e)
        start.current = null
      }}
      onPointerCancel={(e) => {
        if (start.current?.id !== e.pointerId) return
        send('end', e)
        start.current = null
      }}
      onDoubleClick={() => window.notula.bubble.panelResize({ phase: 'reset', edge, dx: 0, dy: 0 })}
    />
  )
}

const EDGES: readonly BubblePanelEdge[] = ['top', 'bottom', 'outer', 'top-outer', 'bottom-outer']

export function DockedBubble({ docked }: { docked: BubbleDocked }): JSX.Element {
  const { document: doc, offRecord, closeness } = useBubbleState()
  const snaps = useScreenSnapshots(doc?.noteId ?? null)
  const width = useWindowWidth()
  const hasCard = offRecord !== null || !!doc?.inactivity || !!snaps?.notice
  const showPanel = docked.panelOpen && !hasCard

  const pill = dockPillRect(docked, width)
  const panel = dockPanelRect(docked, width)
  const card = dockCardRect(docked, width)

  const rects: BubbleDockRect[] = [{ ...pill, part: 'pill' }]
  if (showPanel) rects.push({ ...panel, part: 'panel' })
  if (hasCard) rects.push({ ...card, part: 'card' })
  useReport(rects, sendRegion)

  const held = hasCard || docked.moving || docked.resizing
  const extent: BubbleDockExtent = held
    ? { mode: 'held', width: 0, below: 0 }
    : showPanel
      ? { mode: 'panel', width: D.pill.width + D.gap + panel.width + D.panel.widthInset / 2, below: panel.y + panel.height - docked.anchorY }
      : { mode: 'collapsed', width: 0, below: 0 }
  useReport(extent, sendExtent)

  return (
    <div className="bubble-dock">
      {showPanel ? (
        <div className={`bubble-dock-panel is-${docked.side}`} style={box(panel)}>
          <TranscriptBody doc={doc} />
          {EDGES.map((edge) => (
            <ResizeHandle key={edge} edge={edge} side={docked.side} />
          ))}
        </div>
      ) : null}
      {hasCard ? (
        <div className="bubble-card" style={box(card)}>
          <BubbleCard />
        </div>
      ) : null}
      <div style={box(pill)}>
        <DockPill docked={docked} expanded={showPanel || hasCard || docked.moving} closeness={closeness} />
      </div>
    </div>
  )
}
