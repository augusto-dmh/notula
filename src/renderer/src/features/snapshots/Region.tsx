// SPDX-License-Identifier: Apache-2.0
// The bubble snapshot's region overlay (`#/snapshot-region`): the frozen
// display still, dimmed, with a crosshair. A drag selects a rectangle (shown undimmed with its pixel
// size); releasing sends it in display DIPs. Escape, a right click or a region under 4 × 4 px cancels.

import { useEffect, useRef, useState, type JSX, type PointerEvent } from 'react'
import { BUBBLE_SNAPSHOT_LIMITS } from '@shared/types/snapshots'
import './snapshots.css'

interface Drag {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function Region(): JSX.Element {
  const [image, setImage] = useState<{ dataUrl: string; scaleFactor: number } | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const sent = useRef(false)

  useEffect(() => {
    document.documentElement.classList.add('snap-region-window')
    const off = window.notula.snapshotRegion.onImage((p) => setImage(p))
    window.notula.snapshotRegion.ready()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  function cancel(): void {
    if (sent.current) return
    sent.current = true
    window.notula.snapshotRegion.cancel()
  }

  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button === 2) {
      cancel()
      return
    }
    if (e.button !== 0 || !image) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY })
  }
  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag) setDrag({ ...drag, x1: e.clientX, y1: e.clientY })
  }
  const onUp = (): void => {
    if (!drag || sent.current) return
    const rect = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }
    setDrag(null)
    if (rect.width < BUBBLE_SNAPSHOT_LIMITS.minRegionPx || rect.height < BUBBLE_SNAPSHOT_LIMITS.minRegionPx) {
      cancel()
      return
    }
    sent.current = true
    window.notula.snapshotRegion.done(rect)
  }

  const r = drag
    ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }
    : null
  const scale = image?.scaleFactor ?? 1
  return (
    <div
      className="snap-region"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onContextMenu={(e) => {
        e.preventDefault()
        cancel()
      }}
      style={image ? { backgroundImage: `url(${image.dataUrl})` } : undefined}
    >
      {/* Without a selection the whole still is dimmed; the selection box dims the rest with its shadow. */}
      {r ? null : <div className="snap-region__dim" />}
      {r ? (
        <div className="snap-region__box" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
          <span className="snap-region__size">
            {Math.round(r.w * scale)} × {Math.round(r.h * scale)}
          </span>
        </div>
      ) : (
        <div className="snap-region__hint">Drag to snapshot part of the screen · Esc to cancel</div>
      )}
    </div>
  )
}
