// SPDX-License-Identifier: Apache-2.0
// Screen-share context, bubble snapshots, the region overlay and the macOS
// screen-recording guide.

import type { IsoTime, Rect } from './common'

export interface ScreenSource {
  id: string
  name: string
  appName: string | null
  kind: 'window' | 'screen'
  /** A data URL. */
  thumbnail: string
}

export type ScreenSnapshotsPhase = 'off' | 'offered' | 'starting' | 'capturing' | 'paused' | 'failed' | 'disabled'

export type ScreenSnapshotsNotice =
  | 'capture-offer'
  | 'permission-checking'
  | 'capture-enabled'
  | 'paused'
  | 'capture-failed'
  | 'too-large'

export interface ScreenSnapshotsState {
  noteId: string
  state: ScreenSnapshotsPhase
  notice: ScreenSnapshotsNotice | null
  sourceName: string | null
  snapshots: { attachmentId: string; capturedAt: IsoTime; description: string | null }[]
}

export interface BubbleSnapshotResult {
  status: 'attached' | 'cancelled' | 'failed'
  attachmentId?: string
  error?: 'permission-denied' | 'capture-failed' | 'storage-failed' | 'busy'
}

export interface ScreenGuideLayout {
  phase: 'permission' | 'dragging' | 'restart'
  settings: Rect | null
  panel: Rect
  direction: 'left' | 'right' | 'inside'
  restartSheet: Rect | null
}

export const SCREEN_SNAPSHOT_LIMITS = {
  everyMs: 10_000,
  captureTimeoutMs: 20_000,
  maxBase64: 4_700_000,
  resendUnchangedMs: 30_000,
  queueMax: 6,
  analysisMaxSide: 1_600,
  analysisJpegQuality: 0.85,
  storedMaxSide: 2_560,
  storedJpegQuality: 0.9,
  fingerprint: { width: 64, height: 36 },
  blackLuma: 2,
  evaluateTimeoutMs: 30_000,
  evaluateAttempts: 2,
  descriptionMaxWords: 100,
  permissionPollMs: 1_000,
  permissionPollMaxMs: 120_000,
  noticeAutoHideMs: 5_000
} as const

export const SCREEN_SNAPSHOT_FIRST_TEXT = 'A snapshot of your screen. Its description is on the way.'

export const BUBBLE_SNAPSHOT_LIMITS = {
  maxSide: 2_000,
  successMs: 600,
  pillHeight: 130,
  regionTimeoutMs: 60_000,
  minRegionPx: 4
} as const

export const SCREEN_GUIDE = {
  panel: { width: 264, height: 280 },
  sidebarMax: 190,
  pollMs: 1_000,
  pollMaxMs: 120_000,
  watcherMs: 250,
  restartSheetWaitMs: 3_000,
  settingsUrl: 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture'
} as const
