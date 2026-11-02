// SPDX-License-Identifier: Apache-2.0
// Copy as Markdown (the note's menu, source notes only): front-matter as the Markdown export
// (`source_url`, `series`, `lesson`, `channel`, `duration`, `watched`…), then My notes from the
// stamped projection, then each enhanced-notes section. No transcript. The text is built by the
// export's own pure helper, so the copy and Export lessons agree.

import type { JSX } from 'react'
import type { Note } from '@shared/types/notes'
import type { Panel } from '@shared/types/panels'
import { copyAsMarkdownText } from '../../../../main/sources/export-md'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { writeCopyText } from '../../editor'
import { flushStampedProjection } from '../../editor/source-position'
import type { ActionMenuEntry } from '../note-page/ActionMenu'
import { useNoteSource } from '../transcript/SourcePlan'
import { orderPanels } from './store'

async function copyAsMarkdown(note: Note, panels: Panel[]): Promise<void> {
  try {
    // The stamped projection as typed, then the source that carries it.
    await flushStampedProjection(note.id)
    const view = await window.notula.sources.getForNote({ noteId: note.id })
    if (!view) return
    const sections = orderPanels(panels).map((p) => ({ title: p.title, markdown: p.content_markdown ?? p.generated_content ?? '' }))
    await writeCopyText(copyAsMarkdownText({ title: note.title ?? '', view, notesMarkdown: note.notes_md ?? '', sections }))
    showToast({ id: 'copy-markdown', kind: 'success', title: 'Copied as Markdown' })
  } catch (err) {
    debugLog('copy-markdown-failed', { err: String(err) })
    showToast({ id: 'copy-markdown', kind: 'error', title: 'Couldn’t copy the note', description: 'Try again with the Notula window in front.' })
  }
}

/** The menu's Copy as Markdown, on source notes; none on other notes. */
export function useCopyAsMarkdownEntries(note: Note, panels: Panel[], icon: JSX.Element): ActionMenuEntry[] {
  const view = useNoteSource(note.id)
  if (!view) return []
  return [{ kind: 'item', id: 'copy-markdown', label: 'Copy as Markdown', icon, onSelect: () => void copyAsMarkdown(note, panels) }]
}
