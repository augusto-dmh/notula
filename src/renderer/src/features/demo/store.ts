// SPDX-License-Identifier: Apache-2.0
// The demo state mirror (`demo:get-state`, `demo:state-changed`): the first read, then the
// pushes; and the start
// path shared by the home row and the palette.

import { useSyncExternalStore } from 'react'
import type { DemoState } from '@shared/types/demo'
import { navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'

const IDLE: DemoState = {
  active: false,
  noteId: null,
  mode: null,
  playing: false,
  lineIndex: 0,
  lineCount: 0,
  caption: null,
  speaker: null,
  elapsedMs: 0,
  durationMs: 0
}

let state: DemoState = IDLE
let started = false
let pushed = false
const listeners = new Set<() => void>()

function set(next: DemoState, fromPush: boolean): void {
  if (!fromPush && pushed) return
  if (fromPush) pushed = true
  state = next
  for (const l of listeners) l()
}

function start(): void {
  if (started) return
  started = true
  window.notula.demo.onStateChanged((s) => set(s, true))
  void window.notula.demo
    .getState()
    .then((s) => set(s, false))
    .catch(() => undefined)
}

export function useDemoState(): DemoState {
  return useSyncExternalStore(
    (cb) => {
      start()
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}

let starting = false

/** Main creates the note; the renderer opens it and joins live. */
export async function startDemo(openSource: string): Promise<void> {
  if (starting) return
  starting = true
  try {
    const { noteId } = await window.notula.demo.start()
    navigate(`/meeting/${encodeURIComponent(noteId)}?opened_from=${encodeURIComponent(openSource)}`)
    window.notula.demo.join({ noteId, mode: 'live' })
  } catch (err) {
    // Logged, with a quiet toast so the click is not lost.
    debugLog('demo-live-start-failed', { err: String(err) })
    showToast({ id: 'demo-start-failed', kind: 'error', title: 'Couldn’t start the demo meeting' })
  } finally {
    starting = false
  }
}
