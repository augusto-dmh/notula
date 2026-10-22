// SPDX-License-Identifier: Apache-2.0
// The window-mode bounds, as pure functions of a work
// area, so every number sits in one place.

import { WINDOW_GEOMETRY as G } from '@shared/types/window-modes'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Wide: min(1,200, work-area width) × min(840, work-area height), centred. */
export function wideBounds(wa: Box): Box {
  const width = Math.min(G.wideMax.width, wa.width)
  const height = Math.min(G.wideMax.height, wa.height)
  return {
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
    width,
    height
  }
}

/** Side: max(500, round(31.5 %)) wide, full height, flush right and top. */
export function sideBounds(wa: Box): Box {
  const width = Math.min(wa.width, Math.max(G.sideMin, Math.round(G.sideFraction * wa.width)))
  return { x: wa.x + wa.width - width, y: wa.y, width, height: wa.height }
}

/** Mini: 320 × 480, 24 px below the top and 24 px from the right edge. */
export function miniBounds(wa: Box): Box {
  const { width, height } = G.mini
  return { x: wa.x + wa.width - width - G.inset, y: wa.y + G.inset, width, height }
}

/** Mini bottom-left: 324 × 420, 24 px from the left and bottom edges. */
export function miniBottomLeftBounds(wa: Box): Box {
  const { width, height } = G.miniBottomLeft
  return { x: wa.x + G.inset, y: wa.y + wa.height - height - G.inset, width, height }
}

/**
 * The preview window: 8 px beside the main window on the side with more free
 * work-area width (the right on a tie), scaled by min(1, free / width, work height /
 * height), bottom-aligned with the main window and clamped to the work area. Null when
 * there is no room at all.
 */
export function previewBounds(main: Box, wa: Box, request: { width: number; height: number }): Box | null {
  const freeLeft = main.x - wa.x - G.preview.gap
  const freeRight = wa.x + wa.width - (main.x + main.width) - G.preview.gap
  const right = freeRight >= freeLeft
  const free = Math.max(freeLeft, freeRight)
  if (free <= 0) return null
  const scale = Math.min(1, free / request.width, wa.height / request.height)
  const width = Math.max(1, Math.round(request.width * scale))
  const height = Math.max(1, Math.round(request.height * scale))
  const rawX = right ? main.x + main.width + G.preview.gap : main.x - G.preview.gap - width
  const rawY = main.y + main.height - height
  const x = Math.min(Math.max(rawX, wa.x), wa.x + wa.width - width)
  const y = Math.min(Math.max(rawY, wa.y), wa.y + wa.height - height)
  return { x, y, width, height }
}
