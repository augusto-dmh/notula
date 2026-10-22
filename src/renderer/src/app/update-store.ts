// SPDX-License-Identifier: Apache-2.0
// The renderer mirror of main's update state: one
// `update:get-state` read, then `update:state` pushes. It also answers "is this a
// packaged build?" for the dev-only Settings page.

import { useSyncExternalStore } from 'react'
import type { UpdateState } from '@shared/types/app'
import { debugLog } from './platform'

const listeners = new Set<() => void>()
let snapshot: UpdateState | null = null
let started = false

function emit(): void {
  for (const l of listeners) l()
}

function start(): void {
  if (started) return
  started = true
  window.notula.update.onState((s) => {
    snapshot = s
    emit()
  })
  void reloadUpdateState()
}

/** Reads the state again (after a failed install). */
export async function reloadUpdateState(): Promise<UpdateState | null> {
  try {
    snapshot = await window.notula.update.getState()
    emit()
  } catch (err) {
    debugLog('update:get-state-failed', { err: String(err) })
  }
  return snapshot
}

function subscribe(cb: () => void): () => void {
  start()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Main's update state, or null until the first read. */
export function useUpdateState(): UpdateState | null {
  return useSyncExternalStore(subscribe, () => snapshot)
}
