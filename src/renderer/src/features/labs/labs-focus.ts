// SPDX-License-Identifier: Apache-2.0
// Deep links into Settings ▸ Labs: `openLabs({ focus })` opens Labs scrolled to one feature's
// row and highlights it, so another page can link to a Labs switch. A focus asked for before
// Labs is on screen waits here until the page subscribes.

import type { LabsSettingKey } from '@shared/types/labs'
import { navigateToSettings } from '../../app/navigation'

let pending: LabsSettingKey | null = null
const listeners = new Set<(key: LabsSettingKey) => void>()

export function openLabs(opts: { focus?: LabsSettingKey } = {}): void {
  const key = opts.focus
  if (key) {
    if (listeners.size) for (const l of listeners) l(key)
    else pending = key
  }
  navigateToSettings('labs')
}

/** For LabsPage: called with each focus, at once with one that was waiting. */
export function subscribeLabsFocus(cb: (key: LabsSettingKey) => void): () => void {
  listeners.add(cb)
  if (pending) {
    const key = pending
    pending = null
    cb(key)
  }
  return () => listeners.delete(cb)
}
