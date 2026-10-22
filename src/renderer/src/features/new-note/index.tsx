// SPDX-License-Identifier: Apache-2.0
// New note, from the home button and the application menu. Main pushes
// `notes:new-requested` / `notes:new-blocked`; the renderer does the rest: reuse the
// event's note or create one, start
// transcription when asked, and open the note page.

import { useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { CalendarEvent, CreationOrigin, NewNoteRequest, Note } from '@shared/types/notes'
import { IconPlus } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { debugLog, NEW_NOTE_SHORTCUT } from '../../app/platform'
import { showToast } from '../../app/toast'
import { startTranscription, useCaptureState, type CaptureState } from '../capture'
import { getCaptureSnapshot } from '../capture/store'
import { eventStart } from '../home/grouping'
import { openSourceNote } from '../sources'

export interface NewNoteRequestInput {
  origin: CreationOrigin
  event?: CalendarEvent
  autoTranscribe: boolean
  expandBrief?: boolean
  /** A source note (`NewNoteRequest.source`): the sources branch opens it. */
  source?: NewNoteRequest['source']
}

/** Every entry point refuses while a note is transcribing. */
export function showNewNoteBlocked(): void {
  showToast({
    id: 'new-note-blocked',
    kind: 'error',
    title: 'Another note is already transcribing',
    description: 'Stop that transcript first, then try again.'
  })
}

export function isCapturing(c: CaptureState): boolean {
  return c.transcribingNoteId !== null || c.pendingStart
}

async function startFor(noteId: string): Promise<void> {
  const result = await startTranscription(noteId)
  if (result.ok) return
  debugLog('new-note-transcription-not-started', { noteId, reason: result.reason })
  if (result.reason === 'busy') {
    showNewNoteBlocked()
  } else if (result.reason === 'no-asr') {
    showToast({
      id: 'transcription-not-set-up',
      title: 'Transcription isn’t set up yet',
      description: 'Add a transcription provider in Settings to capture this meeting.',
      action: { label: 'Open Settings', onClick: () => navigate('/settings') }
    })
  } else {
    showToast({ id: 'transcription-not-started', kind: 'error', title: 'Couldn’t start transcription' })
  }
}

let inFlight = false

/**
 * Opens a new note (or the event's existing one), starts transcription when asked,
 * and navigates to it with `opened_from`. Ignored while another request runs.
 */
export async function openNewNote(req: NewNoteRequestInput, capturing: boolean): Promise<string | null> {
  // A source note decides for itself while a source note captures (Next item, Switch note).
  if (capturing && !req.source) {
    showNewNoteBlocked()
    return null
  }
  if (inFlight) return null
  inFlight = true
  try {
    if (req.source) {
      const opened = await openSourceNote({ origin: req.origin, source: req.source }, capturing)
      if (opened !== undefined) return opened
      if (capturing) {
        showNewNoteBlocked()
        return null
      }
    }
    let note: Note | null = null
    if (req.event?.id) {
      const start = eventStart(req.event)
      note = await window.notula.notes.findByEvent({
        eventId: req.event.id,
        ...(start ? { startTime: start.toISOString() } : {})
      })
    }
    note ??= await window.notula.notes.create({
      origin: req.origin,
      title: req.event?.summary ?? null,
      calendarEvent: req.event ?? null
    })
    debugLog('new-note-created', { document_id: note.id, created_via: req.origin })
    const pending = req.autoTranscribe ? startFor(note.id) : null
    const query = new URLSearchParams({ opened_from: req.origin })
    if (req.expandBrief) query.set('expand_brief', '1')
    navigate(`/meeting/${encodeURIComponent(note.id)}?${query.toString()}`)
    await pending
    return note.id
  } catch (err) {
    const { code, message } = parseError(err)
    showToast({
      id: 'new-note-failed',
      kind: 'error',
      title: 'Couldn’t create a note',
      description: code === 'storage-unavailable' ? 'Notes storage is not available right now.' : message
    })
    return null
  } finally {
    inFlight = false
  }
}

/**
 * The listener's create-and-open path for callers outside React, such as deep links and
 * calendar blocks.
 */
export async function startNewNote(req: NewNoteRequest): Promise<void> {
  const capture = getCaptureSnapshot()
  await openNewNote(
    {
      origin: req.creationSource,
      autoTranscribe: req.autoTranscribe,
      ...(req.event ? { event: req.event } : {}),
      ...(req.expandBrief ? { expandBrief: true } : {}),
      ...(req.source ? { source: req.source } : {})
    },
    capture.transcribingNoteId !== null || capture.pendingStart
  )
}

/** Mounted once inside the gates: answers the application menu's requests. */
export function NewNoteListener(): null {
  const capture = useCaptureState()
  const capturing = useRef(false)
  capturing.current = isCapturing(capture)

  useEffect(() => {
    const offRequested = window.notula.notes.onNewRequested((req) => {
      void openNewNote(
        {
          origin: req.creationSource,
          autoTranscribe: req.autoTranscribe,
          ...(req.event ? { event: req.event } : {}),
          ...(req.expandBrief ? { expandBrief: true } : {}),
          ...(req.source ? { source: req.source } : {})
        },
        capturing.current
      )
    })
    const offBlocked = window.notula.notes.onNewBlocked(() => showNewNoteBlocked())
    return () => {
      offRequested()
      offBlocked()
    }
  }, [])

  return null
}

/** The home toolbar button. */
export function NewNoteButton(): JSX.Element {
  const capture = useCaptureState()
  const [busy, setBusy] = useState(false)
  return (
    <span className="n-tooltip" data-tooltip={NEW_NOTE_SHORTCUT}>
      <button
        type="button"
        className="n-btn n-btn--primary"
        disabled={busy}
        aria-keyshortcuts={NEW_NOTE_SHORTCUT.includes('⌘') ? 'Shift+Meta+N' : 'Control+Shift+N'}
        onClick={() => {
          setBusy(true)
          void openNewNote({ origin: 'new_note_button', autoTranscribe: true }, isCapturing(capture)).finally(() => setBusy(false))
        }}
      >
        <IconPlus size={16} />
        New note
      </button>
    </span>
  )
}
