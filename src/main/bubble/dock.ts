// SPDX-License-Identifier: Apache-2.0
// The docked bubble (Labs `bubble.dock`): the bubble window as a transparent strip along one
// edge of a display's work area, with the pill centred on a vertical anchor and the live
// transcript panel beside it, in the same window.
//
// - The strip's top is the work area's top, so the anchor's place in the window only moves
//   with the pill. Its width and height follow the renderer's extent; `held` (a card, a
//   resize or a move) takes the whole work area.
// - The window ignores the mouse except in the rectangles the renderer reports. Main polls
//   the cursor every 33 ms, only while docked and visible, to switch click-through, to
//   compute hover (pill or panel) and to push the edge closeness.
// - The panel opens 150 ms into a hover and closes 100 ms after it ends; never with a card
//   or during a move. A resize keeps it open.
// - The anchor lives in `bubble.dockAnchor`, the panel size in `bubble.panelSize` (both
//   main-only); the caller saves them, throttled.

import { screen, type BrowserWindow, type Display, type Point, type Rectangle } from 'electron'
import type { PushChannel } from '@shared/ipc'
import {
  BUBBLE_DOCK as D,
  dockPanelRect,
  type BubbleDockAnchor,
  type BubbleDocked,
  type BubbleDockExtent,
  type BubbleDockRect,
  type BubblePanelEdge,
  type BubblePanelSize
} from '@shared/types/bubble'
import { log } from '../log'
import { contains, sameRect } from './position'

const PANEL_OPEN_DELAY_MS = 150
const PANEL_CLOSE_DELAY_MS = 100
const DEFAULT_PANEL: BubblePanelSize = { width: D.panel.width, height: D.panel.height, offsetY: 0 }

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))

export interface DockHost {
  window(): BrowserWindow | null
  visible(): boolean
  /** A card shows: no panel, and the strip takes the whole work area. */
  cardUp(): boolean
  /** The pill or the panel gained or lost the pointer. */
  hovered(hovered: boolean): void
  saveAnchor(anchor: BubbleDockAnchor): void
  savePanel(panel: BubblePanelSize | null): void
}

/** Half a pill plus 8 px inside the work area. */
function clampAnchor(y: number, area: Rectangle): number {
  const inset = D.pill.height / 2 + D.anchorMargin
  return Math.round(clamp(y, area.y + inset, area.y + area.height - inset))
}

/** The primary display's right edge, the pill's centre at 70 % of the display height. */
function defaultAnchor(): BubbleDockAnchor {
  const d = screen.getPrimaryDisplay()
  return { side: 'right', anchorY: clampAnchor(d.bounds.y + D.defaultAnchorRatio * d.bounds.height, d.workArea), display: { ...d.bounds } }
}

export class BubbleDock {
  private saved: BubbleDockAnchor | null = null
  private restoreTried = false
  private anchor: BubbleDockAnchor | null = null
  private panel: BubblePanelSize = { ...DEFAULT_PANEL }
  private extent: BubbleDockExtent = { mode: 'collapsed', width: 0, below: 0 }
  private rects: BubbleDockRect[] = []
  private panelOpen = false
  private hover = false
  private move: { start: number; moved: boolean } | null = null
  private resize: { edge: BubblePanelEdge; base: BubblePanelSize } | null = null
  private closeness = 0
  private ignoring: boolean | null = null
  private poller: ReturnType<typeof setInterval> | null = null
  private openTimer: ReturnType<typeof setTimeout> | null = null
  private closeTimer: ReturnType<typeof setTimeout> | null = null
  private bounds: Rectangle | null = null

  constructor(private readonly host: DockHost) {}

  /** The saved anchor and panel size, once read from settings. */
  restore(anchor: BubbleDockAnchor | null, panel: BubblePanelSize | null): void {
    this.saved = anchor
    if (panel) this.panel = { ...panel }
  }

  hovered(): boolean {
    return this.hover
  }

  // ---------- geometry ----------

  /** The display the anchor sits on: the saved bounds when still connected, else the nearest. */
  private display(): Display {
    const a = this.anchor as BubbleDockAnchor
    const match = screen.getAllDisplays().find((d) => sameRect(d.bounds, a.display))
    if (match) return match
    const x = a.side === 'right' ? a.display.x + a.display.width - 1 : a.display.x
    return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(a.anchorY) })
  }

  private ensureAnchor(): void {
    if (this.anchor) return
    if (!this.restoreTried) {
      this.restoreTried = true
      const s = this.saved
      const d = s ? screen.getAllDisplays().find((x) => sameRect(x.bounds, s.display)) : undefined
      if (s && d) {
        this.anchor = { side: s.side, anchorY: clampAnchor(s.anchorY, d.workArea), display: { ...d.bounds } }
        return
      }
    }
    this.anchor = defaultAnchor()
  }

  /** Re-clamps after a display change, like `bubble.position`. */
  reclamp(): void {
    if (!this.anchor) return
    const d = this.display()
    const next: BubbleDockAnchor = { side: this.anchor.side, anchorY: clampAnchor(this.anchor.anchorY, d.workArea), display: { ...d.bounds } }
    const changed = next.anchorY !== this.anchor.anchorY || !sameRect(next.display, this.anchor.display)
    this.anchor = next
    if (changed) this.host.saveAnchor(next)
    this.apply()
  }

  layout(): BubbleDocked | null {
    if (!this.anchor) return null
    const wa = this.display().workArea
    return {
      side: this.anchor.side,
      anchorY: this.anchor.anchorY - wa.y,
      area: { width: wa.width, height: wa.height },
      panel: { ...this.panel },
      panelOpen: this.panelOpen,
      resizing: this.resize !== null,
      moving: this.move !== null
    }
  }

  private held(): boolean {
    return this.host.cardUp() || this.move !== null || this.resize !== null || this.extent.mode === 'held'
  }

  /** The strip in screen DIP: from the work area's top, against the docked edge. */
  canvas(): Rectangle {
    this.ensureAnchor()
    const wa = this.display().workArea
    const layout = this.layout() as BubbleDocked
    let width: number = wa.width
    let height: number = wa.height
    if (!this.held()) {
      let needWidth: number = D.canvas.width
      let below: number = D.canvas.height / 2
      if (this.panelOpen || this.extent.mode === 'panel') {
        const box = dockPanelRect(layout, wa.width)
        needWidth = Math.max(needWidth, D.pill.width + D.gap + box.width + D.panel.widthInset / 2)
        below = Math.max(below, box.y + box.height - layout.anchorY)
      }
      needWidth = Math.max(needWidth, this.extent.width)
      below = Math.max(below, this.extent.below)
      width = Math.min(wa.width, Math.round(needWidth))
      height = Math.min(wa.height, Math.max(D.canvas.height, Math.round(layout.anchorY + below)))
    }
    const x = layout.side === 'right' ? wa.x + wa.width - width : wa.x
    return { x, y: wa.y, width, height }
  }

  /** Sizes the strip and pushes the layout. */
  apply(): void {
    const win = this.host.window()
    if (!win || win.isDestroyed()) return
    const next = this.canvas()
    if (!this.bounds || !sameRect(this.bounds, next)) {
      this.bounds = next
      win.setBounds(next)
    }
    this.pushLayout()
  }

  private pushLayout(): void {
    const win = this.host.window()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('bubble:docked' satisfies PushChannel, this.layout())
  }

  // ---------- show and hide ----------

  show(): void {
    this.ensureAnchor()
    this.bounds = null
    this.ignoring = null
    this.apply()
    this.setIgnore(true)
    if (!this.poller) this.poller = setInterval(() => this.poll(), D.pollMs)
  }

  hide(): void {
    if (this.poller) clearInterval(this.poller)
    this.poller = null
    this.clearTimers()
    this.move = null
    this.resize = null
    this.panelOpen = false
    if (this.hover) {
      this.hover = false
      this.host.hovered(false)
    }
    this.pushCloseness(0)
  }

  /** A card came or went: the panel closes for it, and the strip takes the work area. */
  syncCard(): void {
    if (this.host.cardUp()) this.closePanel(false)
    this.apply()
  }

  // ---------- renderer reports ----------

  setRegion(rects: BubbleDockRect[]): void {
    this.rects = rects
  }

  setExtent(extent: BubbleDockExtent): void {
    const same = extent.mode === this.extent.mode && extent.width === this.extent.width && extent.below === this.extent.below
    this.extent = extent
    if (!same) this.apply()
  }

  // ---------- pointer ----------

  private setIgnore(ignore: boolean): void {
    const win = this.host.window()
    if (ignore === this.ignoring || !win || win.isDestroyed()) return
    this.ignoring = ignore
    win.setIgnoreMouseEvents(ignore)
  }

  private pushCloseness(c: number): void {
    if (c === this.closeness) return
    // Small steps are not worth a push; the ends always are.
    if (Math.abs(c - this.closeness) < 0.02 && c !== 0 && c !== 1) return
    this.closeness = c
    const win = this.host.window()
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('bubble:edge-closeness' satisfies PushChannel, c)
  }

  private poll(): void {
    const win = this.host.window()
    if (!this.host.visible() || !win || win.isDestroyed() || !this.anchor) return
    let p: Point
    try {
      p = screen.getCursorScreenPoint()
    } catch (err) {
      log('warn', 'bubble:dock-cursor-read-failed', { err })
      return
    }
    const b = win.getBounds()
    const rel = { x: p.x - b.x, y: p.y - b.y }
    const hit = contains(b, p) ? this.rects.find((r) => contains(r, rel)) : undefined
    const busy = this.move !== null || this.resize !== null
    this.setIgnore(!busy && !hit)
    // Hover is frozen during a move or a resize.
    if (!busy) {
      const over = !!hit && hit.part !== 'card'
      if (over !== this.hover) {
        this.hover = over
        this.host.hovered(over)
        this.clearTimers()
        if (over) this.openTimer = setTimeout(() => this.openPanel(), PANEL_OPEN_DELAY_MS)
        else this.closeTimer = setTimeout(() => this.closePanel(true), PANEL_CLOSE_DELAY_MS)
      }
    }
    const wa = this.display().workArea
    if (!contains(wa, p)) {
      this.pushCloseness(0)
    } else {
      const d = this.anchor.side === 'right' ? wa.x + wa.width - 1 - p.x : p.x - wa.x
      this.pushCloseness(Math.round(clamp(1 - d / D.closenessPx, 0, 1) * 100) / 100)
    }
  }

  private clearTimers(): void {
    if (this.openTimer) clearTimeout(this.openTimer)
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.openTimer = null
    this.closeTimer = null
  }

  private openPanel(): void {
    this.openTimer = null
    if (!this.host.visible() || !this.hover || this.move || this.host.cardUp() || this.panelOpen) return
    this.panelOpen = true
    this.apply()
  }

  private closePanel(fromHover: boolean): void {
    if (fromHover) this.closeTimer = null
    // A resize keeps the panel open whatever the pointer does.
    if (!this.panelOpen || this.resize) return
    this.panelOpen = false
    this.apply()
  }

  // ---------- move ----------

  moveEvent(phase: 'start' | 'move' | 'end', dy: number): void {
    if (!this.anchor || !this.host.visible()) return
    if (phase === 'start') {
      if (this.move) return
      this.move = { start: this.anchor.anchorY, moved: false }
      this.clearTimers()
      this.panelOpen = false
      this.apply()
      return
    }
    const m = this.move
    if (!m) return
    if (phase === 'move') {
      m.moved = true
      this.anchor = { ...this.anchor, anchorY: clampAnchor(m.start + dy, this.display().workArea) }
      this.pushLayout()
      return
    }
    this.move = null
    if (m.moved) {
      // The display under the pointer, docked to its nearer edge.
      const p = screen.getCursorScreenPoint()
      const d = screen.getDisplayNearestPoint(p)
      const wa = d.workArea
      const same = sameRect(d.bounds, this.display().bounds)
      this.anchor = {
        side: p.x < wa.x + wa.width / 2 ? 'left' : 'right',
        anchorY: clampAnchor(same ? this.anchor.anchorY : p.y, wa),
        display: { ...d.bounds }
      }
      this.host.saveAnchor(this.anchor)
    }
    this.apply()
    this.poll()
  }

  // ---------- resize ----------

  resizeEvent(phase: 'start' | 'move' | 'end' | 'reset', edge: BubblePanelEdge, dx: number, dy: number): void {
    const layout = this.layout()
    if (!layout || !this.host.visible()) return
    if (phase === 'reset') {
      this.resize = null
      this.panel = { ...DEFAULT_PANEL }
      this.host.savePanel(null)
      this.apply()
      return
    }
    if (phase === 'start') {
      // From what is on screen: a clamped panel resizes from where it is drawn.
      const box = dockPanelRect(layout, layout.area.width)
      this.resize = { edge, base: { width: box.width, height: box.height, offsetY: box.y + box.height / 2 - layout.anchorY } }
      this.clearTimers()
      this.panelOpen = true
      this.apply()
      return
    }
    const r = this.resize
    if (!r) return
    if (phase === 'move') {
      const { base } = r
      const maxW = layout.area.width - D.panel.widthInset
      const maxH = layout.area.height - D.panel.heightInset
      let { width, height, offsetY } = base
      if (r.edge === 'outer' || r.edge.endsWith('-outer')) {
        width = Math.round(clamp(base.width + (layout.side === 'right' ? -dx : dx), D.panel.minWidth, maxW))
      }
      if (r.edge.startsWith('top')) {
        height = Math.round(clamp(base.height - dy, D.panel.minHeight, maxH))
        offsetY = base.offsetY + (base.height - height) / 2
      } else if (r.edge.startsWith('bottom')) {
        height = Math.round(clamp(base.height + dy, D.panel.minHeight, maxH))
        offsetY = base.offsetY + (height - base.height) / 2
      }
      this.panel = { width, height, offsetY: Math.round(offsetY) }
      this.pushLayout()
      return
    }
    this.resize = null
    this.host.savePanel({ ...this.panel })
    this.apply()
    this.poll()
    if (!this.hover) this.closeTimer = setTimeout(() => this.closePanel(true), PANEL_CLOSE_DELAY_MS)
  }

  /** While a move or a resize runs, a drag of the classic kind never starts. */
  busy(): boolean {
    return this.move !== null || this.resize !== null
  }
}
