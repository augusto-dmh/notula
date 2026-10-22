// SPDX-License-Identifier: Apache-2.0
// Folder writes with their toasts. Local writes have no network to fail on, so the
// failure toasts show only on a storage error.

import { parseError } from '@shared/errors'
import type { Folder, FolderNoteSource } from '@shared/types/folders'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { getFolders, refreshFolders } from './store'
import { folderTitle } from './tree'

const OWN_NOTES_ONLY = 'Only notes you own can go in folders'

/** Adds notes to a folder, with the toast. Resolves with how many notes were added (0 on failure). */
export async function addNotesToFolder(
  folderId: string,
  noteIds: string[],
  source: FolderNoteSource,
  opts: { toast?: boolean } = {}
): Promise<number> {
  const ids = [...new Set(noteIds)]
  if (ids.length === 0) return 0
  const name = folderTitle(getFolders()?.byId.get(folderId))
  try {
    const { added } = await window.notula.folders.addNotes({ folderId, noteIds: ids, source })
    refreshFolders()
    debugLog('folder-notes-added', { folderId, added, source })
    if (opts.toast !== false) {
      showToast({
        id: `folder-added-${folderId}`,
        kind: 'success',
        title: ids.length > 1 ? `Added ${ids.length} notes to ${name}` : `Added to ${name}`,
        durationMs: 3_000
      })
    }
    return added
  } catch (err) {
    const e = parseError(err)
    showToast({
      kind: 'error',
      title: e.message === OWN_NOTES_ONLY ? OWN_NOTES_ONLY : ids.length > 1 ? 'Couldn’t add the notes to the folder' : 'Couldn’t add the note to the folder',
      ...(e.message !== OWN_NOTES_ONLY && e.message ? { description: e.message } : {})
    })
    return 0
  }
}

/** Removes a note from a folder, with the toast. */
export async function removeNoteFromFolder(folderId: string, noteId: string): Promise<boolean> {
  try {
    await window.notula.folders.removeNote({ folderId, noteId })
    refreshFolders()
    return true
  } catch (err) {
    showToast({ kind: 'error', title: 'Couldn’t remove note from folder', description: parseError(err).message })
    return false
  }
}

/** The toggle applies to the folder and all its descendants (main cascades). */
export async function setFavourite(folder: Folder, value: boolean): Promise<void> {
  try {
    await window.notula.folders.update({ id: folder.id, patch: { is_favourite: value } })
    refreshFolders()
  } catch (err) {
    showToast({
      kind: 'error',
      title: value ? 'Couldn’t add to favorites' : 'Couldn’t remove from favorites',
      description: parseError(err).message
    })
  }
}

/** Nest under a top-level folder, or `null` for the top level. Main checks the rules. */
export async function moveFolder(folderId: string, parentId: string | null): Promise<void> {
  try {
    await window.notula.folders.update({ id: folderId, patch: { parent_id: parentId } })
    refreshFolders()
  } catch (err) {
    showToast({ kind: 'error', title: 'Couldn’t move the folder', description: parseError(err).message })
  }
}
