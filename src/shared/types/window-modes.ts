// SPDX-License-Identifier: Apache-2.0
// The main window's modes, the screen corner and the preview window. Main owns the
// geometry; the renderer asks and is told.

export type WindowMode = 'wide' | 'side' | 'mini' | 'mini-bottom-left'

export type WindowModeReason = 'join' | 'demo' | 'guide' | 'oauth' | 'user'

export const WINDOW_GEOMETRY = {
  minWidth: 500,
  minHeight: 400,
  wideMax: { width: 1_200, height: 840 },
  sideFraction: 0.315,
  sideMin: 500,
  mini: { width: 320, height: 480 },
  miniBottomLeft: { width: 324, height: 420 },
  inset: 24,
  focusDelayMs: 100,
  fullScreenExitMs: 750,
  preview: { requestWidth: 900, gap: 8, thumbMaxHeight: 120 }
} as const

/** The after-meeting reset. */
export const WINDOW_RESET = { firstCheckMs: 300_000, recheckMs: 60_000 } as const

export const SCREEN_CORNER = {
  pollMs: 80,
  triggerPx: 32,
  window: { width: 260, height: 260 },
  button: 220,
  hideDelayMs: 220,
  slideMs: 200
} as const
