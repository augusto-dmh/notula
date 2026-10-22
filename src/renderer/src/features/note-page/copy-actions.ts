// SPDX-License-Identifier: Apache-2.0
// The note's copy actions: "Copy enhanced
// notes" copies the selected panel with the note header in both flavors; "Copy
// transcript" copies the plain-text transcript. Every write is awaited and answered
// with a toast ("Notes copied").

import { parseError } from '@shared/errors'
import { transcriptCopyText } from '@shared/lib/transcript-text'
import type { Note } from '@shared/types/notes'
import type { Panel } from '@shared/types/panels'
import type { TranscriptChunk } from '@shared/types/transcript'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { copyFlavors, copyHeaderFor, readRoomHtml, roomIdFor, writeCopyFlavors, writeCopyText } from '../../editor'

/** The text of a transcript chunk marked as removed. */
const DELETED_CHUNK_TEXT = '[DELETED]'

/** The seed the panel's editor uses (EnhancedView), so a first read fills an empty room the same way. */
function panelSeed(panel: Panel): { json?: unknown; markdown?: string } {
  const markdown = panel.content_markdown ?? panel.generated_content ?? undefined
  return { ...(panel.content ? { json: panel.content } : {}), ...(markdown ? { markdown } : {}) }
}

/** A panel has finished content once its content time is set. */
export function hasFinishedPanel(panels: Panel[]): boolean {
  return panels.some((p) => !p.deleted_at && p.content_edited_at !== null)
}

/** At least one chunk whose text is not `[DELETED]`. */
export function hasCopyableTranscript(chunks: TranscriptChunk[]): boolean {
  return chunks.some((c) => c.text.trim() !== '' && c.text !== DELETED_CHUNK_TEXT)
}

export async function copyEnhancedNotes(note: Note, panel: Panel): Promise<void> {
  try {
    const html = await readRoomHtml(roomIdFor('summary', panel.id), 'panel', panelSeed(panel))
    const flavors = copyFlavors(html, copyHeaderFor(note))
    await writeCopyFlavors(flavors)
    // `copy-as-markdown` is a local debug line; nothing is sent anywhere.
    debugLog('copy-as-markdown', { noteId: note.id, markdownLength: flavors.text.length, source: 'command-menu' })
    showToast({ id: 'notes-copied', kind: 'success', title: 'Notes copied' })
  } catch (err) {
    debugLog('copy-notes-failed', { noteId: note.id, err: parseError(err) })
    showToast({ id: 'notes-copied', kind: 'error', title: 'Couldn’t copy notes' })
  }
}

export async function copyTranscript(note: Note): Promise<void> {
  try {
    const [chunks, settings] = await Promise.all([window.notula.transcript.get({ noteId: note.id }), window.notula.prefs.get()])
    const text = transcriptCopyText({
      note,
      chunks: chunks.filter((c) => c.text !== DELETED_CHUNK_TEXT),
      wordLevel: settings['transcription.diarization']
    })
    await writeCopyText(text)
    debugLog('transcript-copy-done', { hasTitle: Boolean(note.title), length: text.length })
    showToast({ id: 'transcript-copied', kind: 'success', title: 'Transcript copied to clipboard' })
  } catch (err) {
    debugLog('note-copy-failed', { noteId: note.id, err: parseError(err) })
    showToast({ id: 'transcript-copied', kind: 'error', title: 'Couldn’t copy transcript' })
  }
}
