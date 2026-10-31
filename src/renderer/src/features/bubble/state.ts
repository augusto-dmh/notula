// SPDX-License-Identifier: Apache-2.0
// The bubble windows' view of main's bubble state (`bubble:get-state`, then `bubble:shown`,
// `bubble:hovered`, `bubble:note`, `bubble:layout`, `bubble:docked`, `bubble:off-record` and
// `bubble:edge-closeness`): the first read, then the pushes. A push that arrives before the
// first read wins over it.

import { useSyncExternalStore } from 'react'
import type { BubbleState } from '@shared/types/bubble'

export type BubbleView = BubbleState & {
  /** Docked only: 1 with the pointer at the docked edge, 0 from 20 px. */
  closeness: number
}

let state: BubbleView = { visible: false, hovered: false, document: null, layout: null, docked: null, offRecord: null, closeness: 0 }
let started = false
const pushed = new Set<keyof BubbleView>()
const listeners = new Set<() => void>()

function set(patch: Partial<BubbleView>, fromPush: boolean): void {
  const keys = Object.keys(patch) as (keyof BubbleView)[]
  const next = { ...state }
  for (const k of keys) {
    if (fromPush) pushed.add(k)
    else if (pushed.has(k)) continue
    ;(next as Record<keyof BubbleView, unknown>)[k] = patch[k]
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
  api.onLayout((layout) => set({ layout }, true))
  api.onDocked((docked) => set({ docked }, true))
  api.onOffRecord((offRecord) => set({ offRecord }, true))
  api.onEdgeCloseness((closeness) => set({ closeness }, true))
  void api
    .getState()
    .then((s) => set(s, false))
    .catch(() => undefined)
}

export function useBubbleState(): BubbleView {
  return useSyncExternalStore(
    (cb) => {
      start()
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state
  )
}
