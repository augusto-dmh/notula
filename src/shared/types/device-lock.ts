// SPDX-License-Identifier: Apache-2.0
// The main-enforced device lock.

import type { IsoTime } from './common'

export type DeviceLockMethod = 'windows-hello' | 'touch-id' | 'none'

export type DeviceLockUnavailable =
  | 'device-not-present'
  | 'not-configured'
  | 'disabled-by-policy'
  | 'device-busy'
  | 'no-touch-id'
  | 'helper-failed'
  | 'unsupported-platform'

export type DeviceLockFailure = 'canceled' | 'retries-exhausted' | 'unavailable' | 'timeout' | 'busy'

export type ProtectedTarget =
  | 'notifications.scheduledBlocked'
  | 'notifications.autoDetectedBlocked'
  | 'openAtLogin'
  | 'security.deviceLock'
  | 'privacy.localOnly'

/** The reason shown in the OS prompt. */
export const PROTECTED_REASONS: Record<ProtectedTarget, string> = {
  'notifications.scheduledBlocked': 'turn off scheduled meeting notifications',
  'notifications.autoDetectedBlocked': 'turn off notifications for detected meetings',
  openAtLogin: 'stop opening automatically when you sign in',
  'security.deviceLock': 'turn off the Notula lock',
  'privacy.localOnly': 'let data leave this computer again'
}

export interface DeviceLockStatus {
  supported: boolean
  method: DeviceLockMethod
  unavailableReason: DeviceLockUnavailable | null
  enabled: boolean
  locked: boolean
  lockAfterMinutes: 5 | 15 | 60 | null
  warning: string | null
  lastProtectedChange: { target: ProtectedTarget; applied: boolean; at: IsoTime } | null
}

/** Channels that keep working while locked. Prefix match. */
export const LOCK_ALLOWED_CHANNEL_PREFIXES = [
  'app:',
  'storage:get-status',
  'prefs:get',
  'device-lock:',
  'privacy:local-only-status',
  'capture:',
  'input:',
  'bubble:',
  'notify:',
  'meetings:',
  'power:',
  'permissions:',
  'system:',
  'update:get-state',
  'window:',
  'deeplink:get-pending',
  'asr:get-local-model-state',
  'dictation:'
] as const

/** Checked first: these stay blocked although an allowed prefix matches them. */
export const LOCK_DENIED_CHANNEL_PREFIXES = ['dictation:history-', 'dictation:chat-', 'bubble:take-snapshot'] as const

export const DEVICE_LOCK_LIMITS = { helperTimeoutMs: 60_000 } as const

/** Whether a channel may run while Notula is locked (the IPC guard's rule). */
export function channelAllowedWhileLocked(channel: string): boolean {
  if (LOCK_DENIED_CHANNEL_PREFIXES.some((p) => channel.startsWith(p))) return false
  return LOCK_ALLOWED_CHANNEL_PREFIXES.some((p) => channel.startsWith(p))
}
