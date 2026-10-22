// SPDX-License-Identifier: Apache-2.0
// Which BrowserWindow is the main window, for the live-meeting window modules (bubble, notify).
// `browser-window-created` fires inside the constructor, before the windows module
// records its main window, so the check waits a tick. A re-created main window
// (after a real close) is picked up the same way.

import { app, nativeTheme, type BrowserWindow } from 'electron'
import type { MainContext } from '../context'

const TRANSPARENT = '#00000000'
const transparentWindows = new Set<BrowserWindow>()
let themeHooked = false

/**
 * These windows draw their own rounded cards on a transparent window. The theme code
 * paints every window's background on theme changes; this puts transparency back
 * (now, after each theme update, and whenever the caller shows the window).
 */
export function keepTransparent(win: BrowserWindow): void {
  // The window keeps its own title (`Bubble`, `Notification`, …), not the page's `<title>`.
  win.on('page-title-updated', (e) => e.preventDefault())
  win.setBackgroundColor(TRANSPARENT)
  transparentWindows.add(win)
  win.on('closed', () => transparentWindows.delete(win))
  if (themeHooked) return
  themeHooked = true
  nativeTheme.on('updated', () =>
    setImmediate(() => {
      for (const w of transparentWindows) if (!w.isDestroyed()) w.setBackgroundColor(TRANSPARENT)
    })
  )
}

export function reapplyTransparent(win: BrowserWindow): void {
  if (!win.isDestroyed()) win.setBackgroundColor(TRANSPARENT)
}

export interface MainWindowHandlers {
  /** A main window exists (once per window). */
  attached(win: BrowserWindow): void
  /** That main window was destroyed. */
  closed(): void
}

export function watchMainWindow(ctx: MainContext, handlers: MainWindowHandlers): void {
  const seen = new WeakSet<BrowserWindow>()
  const adopt = (win: BrowserWindow): void => {
    if (seen.has(win) || win.isDestroyed() || ctx.windows.main() !== win) return
    seen.add(win)
    win.on('closed', () => handlers.closed())
    handlers.attached(win)
  }
  app.on('browser-window-created', (_e, win) => setImmediate(() => adopt(win)))
  const existing = ctx.windows.main()
  if (existing) adopt(existing)
}
