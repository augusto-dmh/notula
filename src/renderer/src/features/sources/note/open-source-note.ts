// SPDX-License-Identifier: Apache-2.0
// The new-note flow's sources branch: find by source, create or continue
// the source note (`sources:create-note`, which files it and starts the feed in main), choose
// the lesson template for a new note while `sources.lessonTemplate` is on, and open the note.
// A Continue whose note is gone, or a guess key (never continued without a confirm),
// creates a new note instead. Until main's handler exists, it falls back to a plain note.

import { parseError } from '@shared/errors'
import type { CreationOrigin, NewNoteRequest } from '@shared/types/notes'
import { GUESS_KEY_PREFIX, LESSON_TEMPLATE_ID } from '@shared/types/sources'
import { navigate } from '../../../app/navigation'
import { debugLog } from '../../../app/platform'
import { showToast } from '../../../app/toast'
import { getPrefs } from '../../settings/prefs-store'
import { pickForNote } from '../../templates'
import { refreshTemplates } from '../../templates/store'
import { isMissingHandler } from './source-store'

/** The note to continue, if it still exists outside Trash. */
async function existingNote(noteId: string | null): Promise<string | null> {
  if (!noteId) return null
  try {
    const note = await window.notula.notes.get({ id: noteId })
    return note && !note.deleted_at ? note.id : null
  } catch {
    return null
  }
}

/** The lesson template on a new source note; skipped when the template isn't there. */
async function applyLessonTemplate(noteId: string): Promise<void> {
  if (getPrefs()?.['sources.lessonTemplate'] === false) return
  try {
    const template = (await refreshTemplates()).find((t) => t.id === LESSON_TEMPLATE_ID)
    if (template) pickForNote(noteId, template)
  } catch (err) {
    debugLog('sources:lesson-template-failed', { code: parseError(err).code })
  }
}

/**
 * Called by `openNewNote` while it holds its in-flight guard. Returns the opened note's id, null
 * when it failed (and told the user), or undefined to fall back to the plain new-note path.
 */
export async function openSourceNote(
  req: { origin: CreationOrigin; source: NonNullable<NewNoteRequest['source']> },
  capturing: boolean
): Promise<string | null | undefined> {
  const { draft, playbackId } = req.source
  const guess = draft.canonicalKey.startsWith(GUESS_KEY_PREFIX)
  const continueId = req.source.mode === 'continue' && !guess ? await existingNote(req.source.noteId) : null
  let result: { noteId: string; created: boolean }
  try {
    result = await window.notula.sources.createNote({
      draft,
      mode: continueId ? 'continue' : 'new',
      noteId: continueId,
      playbackId
    })
  } catch (err) {
    if (isMissingHandler(err)) return undefined
    const { code } = parseError(err)
    debugLog('sources:create-note-failed', { code, capturing })
    showToast({
      id: 'source-note-failed',
      kind: 'error',
      title: continueId ? 'Couldn’t continue the note' : 'Couldn’t create a note for this video',
      description: code === 'storage-unavailable' ? 'Notes storage is not available right now.' : 'Try again in a moment.'
    })
    return null
  }
  debugLog('sources:note-opened', { document_id: result.noteId, created_via: req.origin, created: result.created })
  if (result.created) void applyLessonTemplate(result.noteId)
  const query = new URLSearchParams({ opened_from: req.origin })
  navigate(`/meeting/${encodeURIComponent(result.noteId)}?${query.toString()}`)
  return result.noteId
}
