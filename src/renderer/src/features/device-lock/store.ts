// SPDX-License-Identifier: Apache-2.0
// The renderer's view of the device lock (`device-lock:get-status`, `device-lock:changed`):
// one shared subscription.

import { useEffect, useState } from 'react'
import type { DeviceLockStatus } from '@shared/types/device-lock'

let current: DeviceLockStatus | null = null
const listeners = new Set<(s: DeviceLockStatus | null) => void>()
let started = false

export function setDeviceLockStatus(s: DeviceLockStatus | null): void {
  current = s
  for (const l of listeners) l(s)
}

function start(): void {
  if (started) return
  started = true
  window.notula.deviceLock.onChanged(setDeviceLockStatus)
  const read = (attempt: number): void => {
    void window.notula.deviceLock
      .getStatus()
      .then(setDeviceLockStatus)
      .catch(() => {
        if (attempt < 5) window.setTimeout(() => read(attempt + 1), 300 * (attempt + 1))
      })
  }
  read(0)
}

export function useDeviceLock(): DeviceLockStatus | null {
  const [s, setS] = useState(current)
  useEffect(() => {
    start()
    listeners.add(setS)
    setS(current)
    return () => {
      listeners.delete(setS)
    }
  }, [])
  return s
}

export function methodName(s: DeviceLockStatus | null): string {
  return s?.method === 'touch-id' ? 'Touch ID' : 'Windows Hello'
}
