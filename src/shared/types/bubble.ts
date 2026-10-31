// SPDX-License-Identifier: Apache-2.0
// The bubble: the floating live-meeting pill and its panels, its cards, and its docked mode.

import type { InactivityWarning } from './capture'
import type { IsoTime, Rect, SourceState } from './common'
import type { CalendarEvent } from './notes'

/**
 * What the bubble shows, computed by the main window's capture store (`bubble:set-document`).
 * `kind` stays a union seam for `chat-consent` (later).
 */
export interface BubbleDocument {
  kind: 'transcribing'
  noteId: string
  title: string | null
  event: CalendarEvent | null
  transcription: SourceState
  warning: string | null
  inactivity: InactivityWarning | null
}

/** `bubble:get-state`, for the calling bubble window. */
export interface BubbleState {
  visible: boolean
  hovered: boolean
  document: BubbleDocument | null
  /** The classic pill's layout inside its window; null while docked. */
  layout: BubbleLayout | null
  /** The docked layout; null for the classic pill. */
  docked: BubbleDocked | null
  /** The off-the-record hold main knows about, for the card's fallback. */
  offRecord: BubbleOffRecord | null
}

/**
 * `bubble:layout`: the classic pill window holds the pill and, while one shows, a card beside it.
 * Window-relative DIP; the pill keeps its place on screen while the window grows.
 */
export interface BubbleLayout {
  pill: Rect
  card: Rect | null
}

/** The off-the-record slice sets this on the bubble hub; the bubble only shows its card. */
export interface BubbleOffRecord {
  noteId: string
  promptId: string
  expiresAt: IsoTime
}

export type BubbleDockSide = 'left' | 'right'

/** The main-only setting `bubble.dockAnchor`: the docked edge, the pill centre's screen y and the display. */
export interface BubbleDockAnchor {
  side: BubbleDockSide
  anchorY: number
  display: Rect
}

/** The main-only setting `bubble.panelSize`: the docked panel's size and its centre's offset from the anchor. */
export interface BubblePanelSize {
  width: number
  height: number
  offsetY: number
}

/**
 * `bubble:docked`: everything the docked strip draws from. The window's top is the work
 * area's top, so `anchorY` (window-relative) only changes when the pill moves.
 */
export interface BubbleDocked {
  side: BubbleDockSide
  anchorY: number
  /** The work area's size: the panel and cards stay inside it. */
  area: { width: number; height: number }
  panel: BubblePanelSize
  /** Main opened the panel (hover). */
  panelOpen: boolean
  /** A resize runs: the panel stays open. */
  resizing: boolean
  /** A move runs: hover is frozen. */
  moving: boolean
}

/** One rectangle the docked strip takes the mouse in, window-relative DIP. */
export interface BubbleDockRect extends Rect {
  part: 'pill' | 'panel' | 'card'
}

export type BubbleDockExtentMode = 'collapsed' | 'panel' | 'held'

/** The room the strip needs: `width` from the docked edge, `below` under the anchor. */
export interface BubbleDockExtent {
  mode: BubbleDockExtentMode
  width: number
  below: number
}

export type BubblePanelEdge = 'top' | 'bottom' | 'outer' | 'top-outer' | 'bottom-outer'

/** The main-only setting `bubble.position`: the pill's bounds and the display they were saved on. */
export interface BubblePosition {
  bounds: Rect
  display: Rect
}

export const BUBBLE_SIZE = { width: 42, height: 70 } as const
export const BUBBLE_PANEL_SIZE = { width: 300, height: 350 } as const
export const BUBBLE_INACTIVITY_WIDTH = 336
/** Every card (inactivity, snapshot notices, off the record) has the inactivity window's old size. */
export const BUBBLE_CARD_SIZE = { width: BUBBLE_INACTIVITY_WIDTH, height: 196 } as const

export const BUBBLE_DOCK = {
  canvas: { width: 476, height: 664 },
  pill: { width: 36, height: 66 },
  /** The anchor stays half a pill plus this inside the work area. */
  anchorMargin: 8,
  /** The pill's centre on first use, as a share of the display height. */
  defaultAnchorRatio: 0.7,
  panel: { width: 326, height: 480, minWidth: 326, minHeight: 223, widthInset: 8, heightInset: 16 },
  /** Between the pill and the panel or a card. */
  gap: 8,
  /** Closeness is 0 this far from the docked edge. */
  closenessPx: 20,
  pollMs: 33
} as const


type DockBox = Pick<BubbleDocked, 'side' | 'anchorY' | 'area' | 'panel'>

const within = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))

/** The docked pill in the strip, window-relative (main and the bubble window share this). */
export function dockPillRect(d: Pick<BubbleDocked, 'side' | 'anchorY'>, canvasWidth: number): Rect {
  const { width, height } = BUBBLE_DOCK.pill
  return { x: d.side === 'right' ? canvasWidth - width : 0, y: Math.round(d.anchorY - height / 2), width, height }
}

/** The docked panel beside the pill, its centre at the anchor plus `offsetY`, kept inside the work area. */
export function dockPanelRect(d: DockBox, canvasWidth: number): Rect {
  const p = BUBBLE_DOCK.panel
  const width = Math.max(1, Math.min(d.panel.width, d.area.width - p.widthInset))
  const height = Math.max(1, Math.min(d.panel.height, d.area.height - p.heightInset))
  const margin = p.heightInset / 2
  const centre = within(d.anchorY + d.panel.offsetY, margin + height / 2, d.area.height - margin - height / 2)
  const room = BUBBLE_DOCK.pill.width + BUBBLE_DOCK.gap
  const edge = p.widthInset / 2
  const x = d.side === 'right' ? Math.max(edge, canvasWidth - room - width) : within(room, edge, canvasWidth - width - edge)
  return { x: Math.round(x), y: Math.round(centre - height / 2), width, height }
}

/** A card beside the docked pill, centred on the anchor, kept inside the work area. */
export function dockCardRect(d: DockBox, canvasWidth: number): Rect {
  const { width, height } = BUBBLE_CARD_SIZE
  const room = BUBBLE_DOCK.pill.width + BUBBLE_DOCK.gap
  const x = d.side === 'right' ? canvasWidth - room - width : room
  const margin = BUBBLE_DOCK.panel.heightInset / 2
  return { x, y: Math.round(within(d.anchorY - height / 2, margin, d.area.height - margin - height)), width, height }
}
