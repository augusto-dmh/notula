// SPDX-License-Identifier: Apache-2.0
// The renderer's view of the local-only status (`privacy:local-only-status`,
// `privacy:local-only-changed`): one shared subscription.

import { useEffect, useState } from 'react'
import type { LocalOnlyStatus } from '@shared/types/local-only'
import { navigateToSettings } from '../../app/navigation'

let current: LocalOnlyStatus | null = null
const listeners = new Set<(s: LocalOnlyStatus | null) => void>()
let started = false

function set(s: LocalOnlyStatus | null): void {
  current = s
  for (const l of listeners) l(s)
}

/** Re-reads the status from main (after an action whose push may lag). */
export function refreshLocalOnly(): void {
  void window.notula.privacy
    .localOnlyStatus()
    .then(set)
    .catch(() => undefined)
}

function start(): void {
  if (started) return
  started = true
  window.notula.privacy.onLocalOnlyChanged(set)
  refreshLocalOnly()
}

export function useLocalOnly(): LocalOnlyStatus | null {
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

/** Opens Preferences ▸ Your data at the switch. */
export function openLocalOnlySetting(): void {
  navigateToSettings('preferences')
  window.setTimeout(() => document.getElementById('local-only-switch')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120)
}
