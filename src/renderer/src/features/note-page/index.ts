// SPDX-License-Identifier: Apache-2.0
import { parseError } from '@shared/errors'
import type { Note } from '@shared/types/notes'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { copyEnhancedNotes as copyPanel, copyTranscript as copyNoteTranscript } from './copy-actions'
import { selectedPanelOf } from './selected-panel'

export { NotePage } from './NotePage'

// The menu copy paths with their toasts, for the command palette.

async function loadNote(noteId: string): Promise<Note | null> {
  try {
    return await window.notula.notes.get({ id: noteId })
  } catch (err) {
    debugLog('copy-note-load-failed', { noteId, err: parseError(err) })
    return null
  }
}

/**
 * Copies a summary panel, then the toast: `panelId`, else the panel the note page has
 * selected, else the newest finished one.
 */
export async function copyEnhancedNotes(noteId: string, panelId?: string | null): Promise<void> {
  const note = await loadNote(noteId)
  const panels = note ? await window.notula.panels.list({ noteId }).catch(() => []) : []
  const finished = panels.filter((p) => !p.deleted_at && p.content_edited_at !== null)
  const wanted = panelId ?? selectedPanelOf(noteId)
  const panel =
    finished.find((p) => p.id === wanted) ??
    [...finished].sort((a, b) => (a.content_edited_at as string).localeCompare(b.content_edited_at as string)).pop()
  if (!note || !panel) {
    showToast({ id: 'notes-copied', kind: 'error', title: 'Couldn’t copy notes' })
    return
  }
  await copyPanel(note, panel)
}

/** Copies the note's transcript, then the toast. */
export async function copyTranscript(noteId: string): Promise<void> {
  const note = await loadNote(noteId)
  if (!note) {
    showToast({ id: 'transcript-copied', kind: 'error', title: 'Couldn’t copy transcript' })
    return
  }
  await copyNoteTranscript(note)
}
