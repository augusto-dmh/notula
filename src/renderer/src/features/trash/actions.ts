// SPDX-License-Identifier: Apache-2.0
// Trash actions: moving notes to Trash
// with the Undo toast (5 s), restoring from the Trash popover, and the confirmed
// permanent delete. Bulk actions call `notes:trash` once per note, then show one toast.

import { parseError } from '@shared/errors'
import { navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { confirmDeletePermanently } from './dialog'

/** The Undo toast and its follow-up stay 3 s. */
const UNDO_TOAST_MS = 3_000
/**
 * The Undo toast itself stays 5 s, not 3 s: it shows only once the
 * trash round trip is done (about 0.7 s), which left too short a window to undo.
 */
const UNDO_ACTION_TOAST_MS = 5_000
const TRASH_TOAST_ID = 'notes-moved-to-trash'
const DELETE_TOAST_ID = 'note-delete-permanently'

async function restoreAll(ids: string[]): Promise<void> {
  const results = await Promise.allSettled(ids.map((id) => window.notula.notes.restore({ id })))
  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length) {
    debugLog('trash-undo-failed', { failed: failed.length })
    showToast({ id: TRASH_TOAST_ID, kind: 'error', title: 'Couldn’t restore from trash', durationMs: UNDO_TOAST_MS })
    return
  }
  const plural = ids.length > 1
  showToast({
    id: TRASH_TOAST_ID,
    kind: 'success',
    title: plural ? 'Notes restored from trash' : 'Note restored from trash',
    durationMs: UNDO_TOAST_MS
  })
}

/**
 * Moves notes to Trash, then shows "Note moved to trash" / "Notes moved to trash" with
 * Undo for 3 s. `alwaysPlural`: the selection bar's wording. Resolves
 * with the ids that moved.
 */
export async function trashNotes(ids: string[], opts: { alwaysPlural?: boolean } = {}): Promise<string[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const results = await Promise.allSettled(unique.map((id) => window.notula.notes.trash({ id })))
  const moved = unique.filter((_id, i) => results[i]?.status === 'fulfilled')
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) {
    debugLog('trash-failed', { failed: unique.length - moved.length, err: parseError(failed.reason) })
  }
  if (moved.length === 0) {
    showToast({
      id: TRASH_TOAST_ID,
      kind: 'error',
      title: unique.length > 1 ? 'Couldn’t move the notes to trash' : 'Couldn’t move the note to trash',
      description: failed ? parseError(failed.reason).message : undefined
    })
    return []
  }
  const plural = opts.alwaysPlural === true || moved.length > 1
  showToast({
    id: TRASH_TOAST_ID,
    title: plural ? 'Notes moved to trash' : 'Note moved to trash',
    ...(moved.length < unique.length ? { description: 'Some notes couldn’t be moved.' } : {}),
    action: { label: 'Undo', onClick: () => void restoreAll(moved) },
    durationMs: UNDO_ACTION_TOAST_MS
  })
  return moved
}

/** Restore from the Trash popover, with "Open". */
export async function restoreFromTrash(id: string): Promise<void> {
  try {
    await window.notula.notes.restore({ id })
    debugLog('trash-note-restored', { id })
    showToast({
      id: `note-restored-${id}`,
      kind: 'success',
      title: 'Note restored',
      action: { label: 'Open', onClick: () => navigate(`/meeting/${encodeURIComponent(id)}`) }
    })
  } catch (err) {
    showToast({ kind: 'error', title: 'Couldn’t restore the note', description: parseError(err).message })
  }
}

/**
 * Nothing happens until the dialog is confirmed. Then one storage
 * transaction removes the note; the toast goes "Deleting note..." → "Note deleted
 * successfully" or "Couldn’t delete note". Resolves true when the note is gone.
 */
export async function deletePermanently(id: string): Promise<boolean> {
  if (!(await confirmDeletePermanently())) return false
  showToast({ id: DELETE_TOAST_ID, title: 'Deleting note...', durationMs: Number.POSITIVE_INFINITY })
  try {
    await window.notula.notes.deletePermanently({ id, confirmed: true })
    debugLog('trash-note-purged', { id })
    showToast({ id: DELETE_TOAST_ID, kind: 'success', title: 'Note deleted' })
    return true
  } catch (err) {
    debugLog('trash-delete-permanently-failed', { id, err: parseError(err) })
    showToast({ id: DELETE_TOAST_ID, kind: 'error', title: 'Couldn’t delete the note', description: parseError(err).message })
    return false
  }
}
