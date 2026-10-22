// SPDX-License-Identifier: Apache-2.0
// Renderer-side platform facts and small shared helpers.

import type { Note, NoteListItem } from '@shared/types/notes'

export const isMac = /Mac/i.test(navigator.userAgent)

/** Key chips: ⌘ and ⇧ on macOS, Ctrl and ⇧ elsewhere. */
export const NEW_NOTE_SHORTCUT = isMac ? '⇧ ⌘ N' : 'Ctrl ⇧ N'

/** Mod = ⌘ on macOS, Ctrl elsewhere. */
export function isMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

/**
 * The ownership seam. The renderer has no identity channel; today every listable
 * note belongs to the implicit local user, so "own" means "not shared". A future
 * multi-user build compares `owner_id` with the signed-in identity here.
 */
export function isOwnNote(note: Pick<Note | NoteListItem, 'is_shared'>): boolean {
  return !note.is_shared
}

/** True when keyboard focus is in something that takes text. */
export function isTextTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
  }
  return false
}

/** Local debug lines only: nothing is ever sent anywhere. */
export function debugLog(event: string, data?: Record<string, unknown>): void {
  if (import.meta.env.DEV) console.debug(`[notula] ${event}`, data ?? '')
}
