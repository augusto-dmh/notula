// SPDX-License-Identifier: Apache-2.0
// The bubble windows' view of main's bubble state (`bubble:get-state`, then `bubble:shown`,
// `bubble:hovered` and `bubble:note`): the first read, then
// the pushes. A push that arrives before the first read wins over it.

import { useSyncExternalStore } from 'react'
import type { BubbleState } from '@shared/types/bubble'

let state: BubbleState = { visible: false, hovered: false, document: null }
let started = false
const pushed = new Set<keyof BubbleState>()
const listeners = new Set<() => void>()

function set(patch: Partial<BubbleState>, fromPush: boolean): void {
  const keys = Object.keys(patch) as (keyof BubbleState)[]
  const next = { ...state }
  for (const k of keys) {
    if (fromPush) pushed.add(k)
    else if (pushed.has(k)) continue
    ;(next as Record<keyof BubbleState, unknown>)[k] = patch[k]
  }
  state = next
  for (const l of listeners) l()
}

function start(): void {
  if (started) return
  started = true
  const api = window.notula.bubble
  api.onVisible(({ visible }) => set({ visible }, true))
  api.onHover(({ hovered }) => set({ hovered }, true))
  api.onDocument((document) => set({ document }, true))
  void api
    .getState()
    .then((s) => set(s, false))
    .catch(() => undefined)
}

export function useBubbleState(): BubbleState {
  return useSyncExternalStore(
    (cb) => {
      start()
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}
