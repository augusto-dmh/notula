// SPDX-License-Identifier: Apache-2.0
// The performance trace's state and toasts: a trace can start
// from the page, the Help menu or the Windows tray, so one listener in App shows `Recording
// started`, `Trace saved` (with the path) and `Couldn’t save trace`.

import { useEffect, useSyncExternalStore } from 'react'
import { showToast } from '../../app/toast'

let recording = false
const listeners = new Set<() => void>()
let started = false

function start(): void {
  if (started) return
  started = true
  window.notula.diag.onTraceState(({ state, path }) => {
    recording = state === 'started'
    for (const l of listeners) l()
    if (state === 'started') showToast({ id: 'trace', kind: 'info', title: 'Recording started', description: 'Notula records for 10 seconds.' })
    else if (state === 'stopped') showToast({ id: 'trace', kind: 'success', title: 'Trace saved', ...(path ? { description: path } : {}) })
    else showToast({ id: 'trace', kind: 'error', title: 'Couldn’t save the trace. Try recording again.' })
  })
}

export function useTraceRecording(): boolean {
  return useSyncExternalStore(
    (cb) => {
      start()
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => recording
  )
}

/** Mounted once in App: subscribes before any trace can start. */
export function DiagnosticsToasts(): null {
  useEffect(() => start(), [])
  return null
}
