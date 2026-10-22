// SPDX-License-Identifier: Apache-2.0
// Putting a template on a note.
// - Picking one for the note's own notes (chip, notes menu before the meeting): it
//   becomes the note's temporary template and its headings go into the notes.
// - "Apply template" in the gallery opened from a note: with summary panels it
//   generates with that template; otherwise it applies it as above and generates now,
//   unless the meeting is still going (transcribing, or its event in progress), in
//   which case the end-of-meeting generation uses it. A note without any transcript
//   yet also waits: there is nothing to summarize.

import { parseError } from '@shared/errors'
import type { NoteTemplate } from '@shared/types/templates'
import { showToast } from '../../app/toast'
import { flushStampedProjection } from '../../editor/source-position'
import type { EditorHandle } from '../../editor/types'
import { getCaptureSnapshot } from '../capture/store'
import { regenerateWith } from '../enhance/regenerate'
import { refreshPanels } from '../enhance/store'
import { notesEditorFor, recordTemplateUse, setTemporaryTemplate, withHeadingsApplying } from './store'

/** The temporary template and its headings; null removes both. */
export function applyToNotes(noteId: string, template: NoteTemplate | null, editor?: EditorHandle | null): void {
  setTemporaryTemplate(noteId, template?.id ?? null)
  const ed = editor ?? notesEditorFor(noteId)
  if (ed) withHeadingsApplying(() => ed.applyTemplateHeadings(template ? template.sections.map((s) => s.heading) : null))
}

/** The chip and the notes menu shown before the meeting: a pick is a recorded use. */
export function pickForNote(noteId: string, template: NoteTemplate | null, editor?: EditorHandle | null): void {
  if (template) recordTemplateUse(template.id)
  applyToNotes(noteId, template, editor)
}

function eventInProgress(event: { start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } } | null | undefined): boolean {
  const start = Date.parse(event?.start?.dateTime ?? '')
  const end = Date.parse(event?.end?.dateTime ?? '')
  const now = Date.now()
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end
}

export type ApplyOutcome = 'generating' | 'applied' | 'failed'

/** The gallery's "Apply template". */
export async function applyFromGallery(noteId: string, template: NoteTemplate, editor: EditorHandle | null): Promise<ApplyOutcome> {
  recordTemplateUse(template.id)
  try {
    const panels = await refreshPanels(noteId)
    if (panels.length > 0) {
      await regenerateWith(noteId, { panel: panels[0] ?? null, templateSlug: template.id })
      return 'generating'
    }
    applyToNotes(noteId, template, editor)
    const [note, chunks] = await Promise.all([
      window.notula.notes.get({ id: noteId }),
      window.notula.transcript.get({ noteId }).catch(() => [])
    ])
    const transcribing = getCaptureSnapshot().transcribingNoteId === noteId
    const hasTranscript = chunks.some((c) => c.text.trim().length > 0)
    if (!note || transcribing || eventInProgress(note.linked_event) || !hasTranscript) return 'applied'
    const ed = editor ?? notesEditorFor(noteId)
    let markdown = ''
    try {
      markdown = ed?.getMarkdown() ?? ''
    } catch {
      markdown = ''
    }
    await flushStampedProjection(noteId)
    await window.notula.enhance.generate({ noteId, templateSlug: template.id, ...(markdown.trim() ? { notesMarkdown: markdown } : {}) })
    return 'generating'
  } catch (err) {
    showToast({ kind: 'error', title: 'Couldn’t apply template', description: parseError(err).message })
    return 'failed'
  }
}
