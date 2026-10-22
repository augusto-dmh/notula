// SPDX-License-Identifier: Apache-2.0
// The renderer mirror of the preferences.
// Read with `prefs.get`, kept current by `prefs.onChanged`, written per key with
// `prefs.set`. A change shows at once; main answers with `prefs:changed` for the
// keys it wrote. A key main drops (invalid) keeps its value here until the next load.

import { useSyncExternalStore } from 'react'
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '@shared/types/settings'
import { debugLog } from '../../app/platform'

const listeners = new Set<() => void>()
let snapshot: Settings | null = null
let started = false
let loadSeq = 0

function emit(): void {
  for (const l of listeners) l()
}

function load(): void {
  const seq = ++loadSeq
  window.notula.prefs
    .get()
    .then((s) => {
      if (seq !== loadSeq) return
      snapshot = s
      emit()
    })
    .catch((err: unknown) => {
      debugLog('prefs:get-failed', { err: String(err) })
      if (seq !== loadSeq || snapshot) return
      snapshot = structuredClone(DEFAULT_SETTINGS)
      emit()
    })
}

/** Starts the mirror once: the first load, then every change from main. */
export function startPrefs(): void {
  if (started) return
  started = true
  window.notula.prefs.onChanged(({ settings }) => {
    loadSeq++
    snapshot = settings
    emit()
  })
  // While storage needs recovery, prefs:get serves the defaults; read again once it is ready.
  window.notula.storage.onStatusChanged((s) => {
    if (s.state === 'ready') load()
  })
  load()
}

export function getPrefs(): Settings | null {
  return snapshot
}

export function subscribePrefs(cb: () => void): () => void {
  startPrefs()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The preferences, or null until the first load. */
export function usePrefs(): Settings | null {
  return useSyncExternalStore(subscribePrefs, getPrefs)
}

/** A per-key change: shown at once, then sent to main. */
export function setPrefs(patch: SettingsPatch): void {
  if (snapshot) {
    snapshot = { ...snapshot, ...patch }
    emit()
  }
  window.notula.prefs.set(patch)
}
