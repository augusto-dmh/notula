// SPDX-License-Identifier: Apache-2.0
// Trash in main: stopping a note's capture before it
// leaves, and the empty-note auto-delete rules, re-checked here from main's own data
// (the renderer's facts are only hints).

import { AUTO_DELETE_CREATION_SOURCES, DEMO_MEETING_PREFIX, type AutoDeleteRequest, type AutoDeleteResult, type AutoDeleteSkip } from '@shared/types/notes'
import type { MainContext } from '../context'
import { log } from '../log'
import type { NoteEmptiness } from '../storage/api'

function capturing(ctx: MainContext, noteId: string): boolean {
  return ctx.capture.isCapturing() && ctx.capture.currentNoteId() === noteId
}

/**
 * A note that is being captured stops first, with reason `document_deleted`, through
 * the drained path, so no audio is lost. A failing stop is logged and the
 * caller goes on: the note keeps its chunks either way.
 */
export async function stopCaptureFor(ctx: MainContext, noteId: string): Promise<void> {
  if (!capturing(ctx, noteId)) return
  try {
    await ctx.capture.stop('document_deleted')
  } catch (err) {
    log('warn', 'notes:stop-capture-failed', { id: noteId, err })
  }
}

/** An own title is non-empty and, on a calendar note, not the event's summary. */
function hasOwnTitle(f: NoteEmptiness): boolean {
  const title = f.title?.trim() ?? ''
  if (!title) return false
  return f.event_id === null || f.title !== f.event_summary
}

function skip(id: string, path: AutoDeleteRequest['path'], skipped: AutoDeleteSkip, event?: string): AutoDeleteResult {
  // No telemetry: these events become local debug lines.
  log('debug', event ?? 'notes:auto-delete-skipped', { id, path, skipped })
  return { deleted: false, skipped }
}

/**
 * `notes:auto-delete-if-empty`. Path `leave` runs every check in
 * order; path `indicator` has no navigation-history, primary-note or demo rules. Main
 * never deletes when it cannot read the note's transcript.
 */
export async function autoDeleteIfEmpty(ctx: MainContext, r: AutoDeleteRequest): Promise<AutoDeleteResult> {
  const leave = r.path === 'leave'
  if (leave && r.inNavHistory) return skip(r.id, r.path, 'in-nav-history', 'notes:auto-delete-skipped-meeting-in-nav-stack')

  let facts: NoteEmptiness | null
  let liveChunks: number
  try {
    facts = await ctx.storage.noteEmptiness(r.id)
    liveChunks = ctx.transcription.liveChunks(r.id).length
  } catch (err) {
    log('warn', 'notes:auto-delete-transcript-unreadable', { id: r.id, err })
    return { deleted: false, skipped: 'transcript-unreadable' }
  }
  if (!facts) return skip(r.id, r.path, 'missing', 'notes:leave-meeting-no-document')
  if (facts.deleted) return skip(r.id, r.path, 'already-deleted')
  if (leave && facts.is_event_main_note) return skip(r.id, r.path, 'primary-event-note', 'notes:auto-delete-skipped-primary-event-note')
  const transcribing = capturing(ctx, r.id)
  if (leave && transcribing && facts.event_id !== null) {
    return skip(r.id, r.path, 'transcribing-calendar-meeting', 'notes:auto-delete-skipped-transcribing-calendar-meeting')
  }
  if (!(AUTO_DELETE_CREATION_SOURCES as readonly string[]).includes(facts.created_via)) {
    return skip(r.id, r.path, 'creation-source')
  }

  const chunks = facts.chunk_count + liveChunks
  const notesLength = Math.max(facts.notes_text_length, leave ? (r.editorTextLength ?? 0) : 0)
  const demo =
    leave &&
    (r.id.startsWith(DEMO_MEETING_PREFIX) || (facts.event_id ?? '').startsWith(DEMO_MEETING_PREFIX)) &&
    facts.live_panel_count === 0
  if (!demo) {
    if (chunks > 0) return skip(r.id, r.path, 'has-transcript')
    if (facts.live_panel_count > 0) return skip(r.id, r.path, 'has-panels')
    if (notesLength > 0) return skip(r.id, r.path, 'has-notes')
    if (hasOwnTitle(facts)) return skip(r.id, r.path, 'has-title')
  }

  if (transcribing) {
    await stopCaptureFor(ctx, r.id)
    // The drain can deliver chunks that were still in flight (ASR latency, or audio held
    // while the socket connected): a note that has a transcript now is kept.
    if (!demo) {
      try {
        const after = await ctx.storage.noteEmptiness(r.id)
        if ((after?.chunk_count ?? 0) + ctx.transcription.liveChunks(r.id).length > 0) {
          return skip(r.id, r.path, 'has-transcript', 'notes:auto-delete-skipped-transcript-after-drain')
        }
      } catch (err) {
        log('warn', 'notes:auto-delete-transcript-unreadable', { id: r.id, err })
        return { deleted: false, skipped: 'transcript-unreadable' }
      }
    }
  }
  log('info', leave ? 'notes:empty-note-discarded' : 'notes:empty-note-discarded-from-bubble', {
    id: r.id,
    demo,
    chunks,
    panels: facts.live_panel_count,
    storedNotesLength: facts.notes_text_length,
    editorNotesLength: r.editorTextLength ?? null,
    hasTitle: hasOwnTitle(facts)
  })
  await ctx.storage.markNoteDeleted(r.id)
  return { deleted: true, skipped: null }
}
