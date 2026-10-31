// SPDX-License-Identifier: Apache-2.0
// Bubble geometry: the default spot, the clamp, where the transcript panel and a card sit
// beside the pill, and the pill window grown to hold a card. Pure functions over Electron's
// `screen`, in DIPs.

import { screen, type Display, type Point, type Rectangle } from 'electron'
import type { BubblePosition } from '@shared/types/bubble'
import { BUBBLE_CARD_SIZE, BUBBLE_PANEL_SIZE, BUBBLE_SIZE } from '@shared/types/bubble'

/** 130 px with the bubble snapshot button, else BUBBLE_SIZE.height. */
let pillHeight: number = BUBBLE_SIZE.height

export function setPillHeight(h: number): void {
  pillHeight = h
}

export function currentPillHeight(): number {
  return pillHeight
}

/** The default top sits at 70 % of (display height − 37) below the display's top. */
const DEFAULT_TOP_RATIO = 0.7
const DEFAULT_TOP_INSET = 37
/** The panel overlaps the bubble by 4 px and needs 308 px on the left. */
const PANEL_OVERLAP = 4
const PANEL_SIDE_ROOM = 308
const PANEL_RISE = 200
/** A card keeps 24 px inside the screen. */
const CARD_MARGIN = 24
const CARD_GAP = 8

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))

export function contains(r: Rectangle, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
}

export const sameRect = (a: Rectangle, b: Rectangle): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

function centre(r: Rectangle): Point {
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
}

export function displayOf(r: Rectangle): Display {
  return screen.getDisplayNearestPoint(centre(r))
}

/** Flush with the display's right edge, top at 70 % of (height − 37). */
export function defaultBounds(display: Display): Rectangle {
  const d = display.bounds
  return {
    x: d.x + d.width - BUBBLE_SIZE.width,
    y: d.y + Math.round(DEFAULT_TOP_RATIO * (d.height - DEFAULT_TOP_INSET)),
    width: BUBBLE_SIZE.width,
    height: pillHeight
  }
}

/** Kept inside the full bounds (not the work area) of the display nearest its centre. */
export function clampToDisplay(r: Rectangle): Rectangle {
  const d = displayOf(r).bounds
  return {
    x: clamp(r.x, d.x, d.x + d.width - r.width),
    y: clamp(r.y, d.y, d.y + d.height - r.height),
    width: r.width,
    height: r.height
  }
}

/** The saved bounds, when the display they were saved on is still connected unchanged. */
export function restoredBounds(saved: BubblePosition | null): Rectangle | null {
  if (!saved) return null
  const match = screen.getAllDisplays().some((d) => sameRect(d.bounds, saved.display))
  if (!match) return null
  return clampToDisplay({ ...saved.bounds, width: BUBBLE_SIZE.width, height: pillHeight })
}

/** Left of the bubble (4 px overlap), or right when the left lacks 308 px; top − 200, clamped. */
export function panelBounds(bubble: Rectangle): Rectangle {
  const area = displayOf(bubble).workArea
  const { width, height } = BUBBLE_PANEL_SIZE
  const left = bubble.x - area.x >= PANEL_SIDE_ROOM
  const x = left ? bubble.x - width + PANEL_OVERLAP : bubble.x + bubble.width - PANEL_OVERLAP
  return {
    x: clamp(x, area.x, area.x + area.width - width),
    y: clamp(bubble.y - PANEL_RISE, area.y, area.y + area.height - height),
    width,
    height
  }
}

/** A card beside the pill (left when it fits with the 24 px margin), centred on it, 24 px inside. */
export function cardBounds(pill: Rectangle): Rectangle {
  const area = displayOf(pill).workArea
  const { width, height } = BUBBLE_CARD_SIZE
  const left = pill.x - area.x >= width + CARD_MARGIN + CARD_GAP
  const x = left ? pill.x - width - CARD_GAP : pill.x + pill.width + CARD_GAP
  const y = Math.round(pill.y + pill.height / 2 - height / 2)
  return {
    x: clamp(x, area.x + CARD_MARGIN, area.x + area.width - width - CARD_MARGIN),
    y: clamp(y, area.y + CARD_MARGIN, area.y + area.height - height - CARD_MARGIN),
    width,
    height
  }
}

/** The smallest rectangle holding both. */
export function union(a: Rectangle, b: Rectangle): Rectangle {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

/** `r` relative to `origin`'s top-left. */
export function relative(r: Rectangle, origin: Rectangle): Rectangle {
  return { x: r.x - origin.x, y: r.y - origin.y, width: r.width, height: r.height }
}
