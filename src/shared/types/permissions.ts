// SPDX-License-Identifier: Apache-2.0
// Microphone and system-audio permissions.

/** The record values: unknown, granted or denied. */
export type PermissionState = 'unknown' | 'granted' | 'denied'

/** Electron's `systemPreferences.getMediaAccessStatus` values. */
export type OsMediaStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

/** Interop literal. */
export type TccStatus = 'authorized' | 'denied' | 'unknown' | 'process-error'

export interface SystemAudioCheck {
  audioCapture: TccStatus
  screenCapture: TccStatus
}

/** Stored under the main-only setting `permissions.record`. */
export interface PermissionRecord {
  microphone: PermissionState
  systemAudio: PermissionState
  requestingSystemAudio: boolean
}

export interface PermissionsState extends PermissionRecord {
  platform: NodeJS.Platform
  osMicrophone: OsMediaStatus
  systemAudioCheck: SystemAudioCheck | null
}

/** Brackets the renderer's system-audio probe. */
export type SystemAudioRequest =
  | { stage: 'begin' }
  | { stage: 'result'; granted: boolean; errorName?: string }

/** `accessibility`: macOS only. */
export type PrivacySettingsTarget = 'microphone' | 'screen-recording' | 'accessibility'
