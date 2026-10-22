// SPDX-License-Identifier: Apache-2.0
// Types shared by every area of the contract.

/** ISO-8601 UTC string from `Date.prototype.toISOString()`. */
export type IsoTime = string

export type AudioSource = 'microphone' | 'system'

export type SourceState = 'inactive' | 'starting' | 'active' | 'error'

/** Why capture stopped (sent with `capture:stop-requested`). */
export type StopReason =
  | 'toggle_off'
  | 'note_stop_button'
  | 'indicator_stop_button'
  | 'bubble_stop_button'
  | 'inactivity_prompt_stop'
  | 'idle_timeout'
  | 'view_closed'
  | 'window_closed'
  | 'app_shutdown'
  | 'system_sleep'
  | 'system_wake'
  | 'meeting_app_left_confirmed'
  | 'meeting_app_left_at_event_end'
  | 'document_deleted'
  /** A held start was cancelled. */
  | 'start_cancelled'
  /** A transcription rule blocked or stopped capture. */
  | 'recording_rule'
  /** A source note's video ended or stayed paused (content sources, end of watching). */
  | 'source_ended'

/** Pixels: a window's bounds, a display's work area, or a page region to capture. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface AppInfo {
  name: string
  version: string
  platform: NodeJS.Platform
}

export interface ProviderTestResult {
  ok: boolean
  error?: string
}
