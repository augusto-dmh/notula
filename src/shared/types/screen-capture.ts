// SPDX-License-Identifier: Apache-2.0
// Screen capture (Labs): a global shortcut grabs a region or a window, and a small panel
// keeps up to 4 images and an optional note until Save adds them to a note as images.
// The images stay in main's memory until Save; the panel sees small previews only.

export type ScreenCaptureMode = 'region' | 'window'

/** A grabbed image as the panel shows it. */
export interface ScreenCaptureThumb {
  /** A small JPEG data URL. */
  preview: string
  width: number
  height: number
  mode: ScreenCaptureMode
}

export interface ScreenCaptureState {
  captureId: string
  images: ScreenCaptureThumb[]
}

/** `screen-capture:take`. */
export interface ScreenCaptureTakeResult {
  status: 'added' | 'cancelled' | 'full' | 'failed' | 'permission-denied'
  state: ScreenCaptureState
}

/** `screen-capture:save`. */
export type ScreenCaptureSaveResult =
  | { status: 'saved'; noteId: string; title: string; created: boolean }
  | { status: 'limit'; room: number }
  | { status: 'failed' }

export const SCREEN_CAPTURE_LIMITS = {
  images: 4,
  maxSide: 1_600,
  jpegQuality: 85,
  previewSide: 240,
  hideDelayMs: 200,
  panel: { width: 560, height: 140, bottomInset: 16 }
} as const
