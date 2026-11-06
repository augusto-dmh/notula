// SPDX-License-Identifier: Apache-2.0
// The view of off the record that the note and the bubble both read: main's `off-record:prompt`
// and `off-record:paused` pushes, for the window's lifetime. Main owns both states; the bubble
// also has the hub's copy (`bubble:get-state`) for a window that opened after a push.

import { useSyncExternalStore } from 'react'
import type { OffRecordAnswer, OffRecordPaused, OffRecordPrompt, OffRecordSurface } from '@shared/types/off-record'

export interface OffRecordView {
  prompt: OffRecordPrompt | null
  paused: OffRecordPaused | null
}

let view: OffRecordView = { prompt: null, paused: null }
let started = false
const listeners = new Set<() => void>()

function set(patch: Partial<OffRecordView>): void {
  view = { ...view, ...patch }
  for (const l of listeners) l()
}

/** Follows main's pushes; the capture store starts it at mount, the first reader otherwise. */
export function watchOffRecord(): void {
  if (started) return
  started = true
  window.notula.offRecord.onPrompt((prompt) => set({ prompt }))
  window.notula.offRecord.onPaused((paused) => set({ paused }))
}

function subscribe(cb: () => void): () => void {
  watchOffRecord()
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useOffRecord(): OffRecordView {
  return useSyncExternalStore(subscribe, () => view)
}

/** False when main refused it (a stale prompt, the module missing) or the call failed. */
export async function answerOffRecord(
  noteId: string,
  promptId: string,
  answer: OffRecordAnswer,
  surface: OffRecordSurface
): Promise<boolean> {
  try {
    const r = await window.notula.offRecord.answer({ noteId, promptId, answer, surface })
    return r.ok
  } catch {
    return false
  }
}
