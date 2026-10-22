// SPDX-License-Identifier: Apache-2.0
// The "This device" card.

import type { IsoTime } from './common'

export interface DeviceInfo {
  deviceName: string
  os: string
  osVersion: string
  appVersion: string
  dataFolder: string
  encrypted: boolean
  firstRunAt: IsoTime | null
  deviceLockEnabled: boolean
}
