// SPDX-License-Identifier: Apache-2.0
// Delivery:
// 1. wait for held modifiers to be released (up to 1 s with the helper; 300 ms without);
// 2. snapshot the clipboard's text, HTML, RTF and image;
// 3. write the text; 4. synthesize the paste (Ctrl+V / Cmd+V through notula-desk);
// 5. after 750 ms restore the snapshot, unless the clipboard changed meanwhile.
// `no_focus` and `secure_input` skip the keystroke and leave the text on the clipboard.

import { clipboard } from 'electron'
import { DICTATION_LIMITS, type DictationDeliveryFailure } from '@shared/types/dictation'
import { log } from '../log'
import type { Desk, DeskContext } from './desk'

export type Delivery = { outcome: 'pasted' } | { outcome: 'clipboard'; reason: DictationDeliveryFailure } | { outcome: 'delivery_failed' }

/** Every flavour on the clipboard (text, HTML, RTF, image …), as the OS reports them. */
type Snapshot = Electron.ClipboardItem[]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function snapshot(): Promise<Snapshot> {
  try {
    return await clipboard.read()
  } catch {
    return []
  }
}

async function restore(s: Snapshot): Promise<void> {
  if (s.length) await clipboard.write(s)
  else clipboard.clear()
}

async function waitForModifiers(desk: Desk): Promise<boolean> {
  const first = await desk.modifiersHeld()
  if (first === null) {
    await sleep(300)
    return true
  }
  const deadline = Date.now() + DICTATION_LIMITS.modifiersWaitMs
  let held = first
  while (held && Date.now() < deadline) {
    await sleep(50)
    held = (await desk.modifiersHeld()) ?? false
  }
  return !held
}

/** `field` is the focused-field reading taken at release, when there is one. */
export async function deliver(desk: Desk, text: string, field: DeskContext | null, isCurrent: () => boolean): Promise<Delivery> {
  const skip: DictationDeliveryFailure | null =
    field?.result === 'secure_input' ? 'secure_input' : field && field.result !== 'timeout' && field.result !== 'unsupported' && field.field === null ? 'no_focus' : null
  if (!desk.supported) {
    try {
      await clipboard.writeText(text)
      return { outcome: 'clipboard', reason: 'platform' }
    } catch {
      return { outcome: 'delivery_failed' }
    }
  }
  const released = skip ? true : await waitForModifiers(desk)
  let before: Snapshot
  try {
    before = await snapshot()
    await clipboard.writeText(text)
  } catch (err) {
    log('warn', 'dictation:clipboard-failed', { err: err instanceof Error ? err.name : 'error' })
    return { outcome: 'delivery_failed' }
  }
  if (skip) return { outcome: 'clipboard', reason: skip }
  if (!released) return { outcome: 'clipboard', reason: 'modifiers_held' }
  if (!isCurrent()) return { outcome: 'clipboard', reason: 'not_pasted' }
  let sent = false
  try {
    sent = await desk.paste()
  } catch {
    sent = false
  }
  if (!sent) return { outcome: 'clipboard', reason: 'not_pasted' }
  setTimeout(() => {
    void clipboard
      .readText()
      .then((now) => (now === text ? restore(before) : undefined))
      .catch(() => undefined)
  }, DICTATION_LIMITS.restoreClipboardMs)
  return { outcome: 'pasted' }
}
