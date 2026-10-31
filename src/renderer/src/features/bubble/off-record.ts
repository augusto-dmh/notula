// SPDX-License-Identifier: Apache-2.0
// The bubble's adapter to off the record: the prompt and the paused note from the
// `off-record:*` pushes, and the answer. Main's bubble hub decides when the card shows; the
// pushed prompt gives its text. While the prompt push is missing (it was sent before this
// window loaded), the card falls back to the hub's hold and plain wording.

import { useSyncExternalStore } from 'react'
import type { BubbleOffRecord } from '@shared/types/bubble'
import type { OffRecordAnswer, OffRecordPaused, OffRecordPrompt } from '@shared/types/off-record'

interface OffRecordView {
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

function start(): void {
  if (started) return
  started = true
  window.notula.offRecord.onPrompt((prompt) => set({ prompt }))
  window.notula.offRecord.onPaused((paused) => set({ paused }))
}

export function useOffRecord(): OffRecordView {
  return useSyncExternalStore(
    (cb) => {
      start()
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => view
  )
}

/** The card's content: the pushed prompt for the hub's hold, else the hold alone. */
export function cardPrompt(
  hold: BubbleOffRecord | null,
  prompt: OffRecordPrompt | null
): (BubbleOffRecord & { requestText: string | null; heldText: string | null }) | null {
  if (!hold) return null
  if (prompt && prompt.promptId === hold.promptId) {
    return { ...hold, expiresAt: prompt.expiresAt, requestText: prompt.requestText, heldText: prompt.heldText }
  }
  return { ...hold, requestText: null, heldText: null }
}

/** False when main has no answer for it (the off-the-record module isn't there) or it failed. */
export async function answerOffRecord(noteId: string, promptId: string, answer: OffRecordAnswer): Promise<boolean> {
  try {
    const r = await window.notula.offRecord.answer({ noteId, promptId, answer, surface: 'bubble' })
    return r.ok
  } catch {
    return false
  }
}
