// SPDX-License-Identifier: Apache-2.0
// main → renderer pushes owned by capture. Each function writes its channel literal
// at the send site; none takes a channel parameter.

import type { PushChannel } from '@shared/ipc'
import type {
  CaptureCommand,
  CaptureHealth,
  CaptureSystemState,
  InactivityWarning,
  InputDevice,
  InputSelectionState
} from '@shared/types/capture'
import type { AudioSource, StopReason } from '@shared/types/common'
import type { WindowsApi } from '../context'

export function pushHealth(windows: WindowsApi, p: CaptureHealth): void {
  for (const wc of windows.targets()) wc.send('capture:health' satisfies PushChannel, p)
}

export function pushInactivity(windows: WindowsApi, p: InactivityWarning | null): void {
  for (const wc of windows.targets()) wc.send('capture:inactivity' satisfies PushChannel, p)
}

export function pushSystemState(windows: WindowsApi, p: CaptureSystemState): void {
  for (const wc of windows.targets()) wc.send('capture:system-state' satisfies PushChannel, p)
}

export function pushCommand(windows: WindowsApi, p: CaptureCommand): void {
  for (const wc of windows.targets()) wc.send('capture:command' satisfies PushChannel, p)
}

export function pushVolume(windows: WindowsApi, p: { source: AudioSource; rms: number }): void {
  for (const wc of windows.targets()) wc.send('capture:volume' satisfies PushChannel, p)
}

export function pushSystemSource(windows: WindowsApi, p: { label: string | null }): void {
  for (const wc of windows.targets()) wc.send('capture:system-source-changed' satisfies PushChannel, p)
}

export function pushStopRequested(windows: WindowsApi, p: { reason: StopReason }): void {
  for (const wc of windows.targets()) wc.send('capture:stop-requested' satisfies PushChannel, p)
}

export function pushInputState(windows: WindowsApi, p: InputSelectionState | null): void {
  for (const wc of windows.targets()) wc.send('input:state-changed' satisfies PushChannel, p)
}

export function pushInputDevices(windows: WindowsApi, p: InputDevice[]): void {
  for (const wc of windows.targets()) wc.send('input:devices-changed' satisfies PushChannel, p)
}

export function pushActiveDevice(windows: WindowsApi, p: { deviceId: string | null; label: string | null }): void {
  for (const wc of windows.targets()) wc.send('input:active-device-changed' satisfies PushChannel, p)
}
