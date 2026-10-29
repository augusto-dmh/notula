// SPDX-License-Identifier: Apache-2.0
// Pick the moment: the agreement sheet steps aside and the transcript
// enters a pick mode with a banner. A click on a turn returns it to the sheet; Esc returns
// nothing. Only the note id and the time go to main later: main extracts the excerpt itself.

import { useSyncExternalStore } from 'react'

/** The turn the user clicked, from the transcript the renderer already shows. */
export interface PickedTurn {
  noteId: string
  chunkId: string
  /** The turn's start, epoch ms (`record-agreement`'s `evidenceAtMs`). */
  atMs: number
  /** Display only, for the sheet: the turn's label and text as shown. Never sent to main. */
  speaker?: string
  text?: string
}

export type PickModeState = { active: false } | { active: true; noteId: string; personName: string }

let state: PickModeState = { active: false }
let settle: ((t: PickedTurn | null) => void) | null = null
const listeners = new Set<() => void>()

function set(next: PickModeState): void {
  state = next
  for (const l of listeners) l()
}

/** Enters pick mode on a note; resolves with the clicked turn, or null on Esc or a new start. */
export function startPickMode(req: { noteId: string; personName: string }): Promise<PickedTurn | null> {
  settle?.(null)
  set({ active: true, noteId: req.noteId, personName: req.personName })
  return new Promise((resolve) => {
    settle = resolve
  })
}

/** The transcript's click handler while pick mode is on. A turn of another note is ignored. */
export function pickTurn(turn: PickedTurn): void {
  if (!state.active || turn.noteId !== state.noteId) return
  const done = settle
  settle = null
  set({ active: false })
  done?.(turn)
}

/** Esc, or the sheet closing. */
export function cancelPickMode(): void {
  if (!state.active) return
  const done = settle
  settle = null
  set({ active: false })
  done?.(null)
}

export function getPickMode(): PickModeState {
  return state
}

export function subscribePickMode(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function usePickMode(): PickModeState {
  return useSyncExternalStore(subscribePickMode, getPickMode)
}
