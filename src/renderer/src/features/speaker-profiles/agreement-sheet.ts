// SPDX-License-Identifier: Apache-2.0
// The agreement sheet: attached to the window, not inside the
// popover. It blocks until the box is checked and a method chosen; an outside click doesn't
// close it, and its fields survive until Cancel or a decision. From a naming it opens before
// any name is written, so its outcome decides the naming and the Undo window starts after it.
//
// One sheet at a time: a second request waits until the first is decided. The sheet renders
// in its own root on `document.body` (`AgreementSheet.tsx`), so it survives route changes,
// which Pick the moment needs.

import { useSyncExternalStore } from 'react'

export interface AgreementSheetRequest {
  personId: string
  name: string
  /** The speaker being named when the sheet opened from a naming; absent from the person page. */
  noteId?: string
  identityKey?: string
  /** Ask <name> first: offered from a naming unless the speaker is known to have no voice sample. */
  canAskFirst: boolean
  /**
   * The sheet opened before a naming, which waits for it: Cancel reads "Name without
   * remembering", and so does Esc on an untouched sheet.
   */
  naming?: boolean
}

/**
 * `recorded`: the agreement is recorded (the caller then names with Remember voice on).
 * `ask-first`: a pending request was made, nothing biometric recorded, and the speaker stays
 * unnamed. `cancel`: name without remembering; the switch returns to off.
 */
export type AgreementSheetResult = { outcome: 'recorded' } | { outcome: 'ask-first' } | { outcome: 'cancel' }

interface Open {
  id: number
  req: AgreementSheetRequest
  resolve(r: AgreementSheetResult): void
}

let queue: Open[] = []
let nextId = 1
const listeners = new Set<() => void>()
let mounted = false

function emit(): void {
  for (const l of listeners) l()
}

/** Opens the sheet; resolves when the user decides. */
export function openAgreementSheet(req: AgreementSheetRequest): Promise<AgreementSheetResult> {
  return new Promise((resolve) => {
    queue = [...queue, { id: nextId++, req, resolve }]
    emit()
    if (mounted) return
    mounted = true
    // Loaded on first use. If it can't load, nothing is remembered: every request cancels.
    import('./AgreementSheet')
      .then((m) => m.mountAgreementSheet())
      .catch(() => {
        mounted = false
        for (const o of queue) settleSheet(o.id, { outcome: 'cancel' })
      })
  })
}

/** The sheet shown now, if any. */
export function useOpenSheet(): Open | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => queue[0] ?? null
  )
}

/** The user's decision on the sheet `id`. */
export function settleSheet(id: number, result: AgreementSheetResult): void {
  const open = queue.find((o) => o.id === id)
  if (!open) return
  queue = queue.filter((o) => o.id !== id)
  emit()
  open.resolve(result)
}
