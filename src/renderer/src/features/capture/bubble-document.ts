// SPDX-License-Identifier: Apache-2.0
// The bubble document: computed in the main
// window from the capture store, the transcribing note and main's live signals, and
// sent to main on every change (`bubble:set-document`). Main forwards it to the bubble.

import type { CaptureHealth } from '@shared/types/capture'
import type { CalendarEvent } from '@shared/types/notes'
import type { BubbleDocument } from '@shared/types/bubble'
import { getLiveSignals, subscribeLive } from './live'
import { getCaptureSnapshot, subscribeCapture } from './store'

/** The bubble's "!" badge text: a problem the user can act on, not the error state itself. */
function warningFor(health: CaptureHealth, noteId: string): string | null {
  if (health.noteId !== noteId) return null
  if (health.antivirusSuspected) return 'Check that your antivirus lets Notula use your mic.'
  if (health.systemDropout) return `We're not receiving audio from ${health.dropoutApp ?? 'other apps'}.`
  return null
}

export function startBubbleDocument(): () => void {
  const api = window.notula
  let note: { id: string; title: string | null; event: CalendarEvent | null } | null = null
  let loading: string | null = null
  let lastSent: string | null = null

  const send = (): void => {
    const s = getCaptureSnapshot()
    const live = getLiveSignals()
    const noteId = s.transcribingNoteId
    const doc: BubbleDocument | null = noteId
      ? {
          kind: 'transcribing',
          noteId,
          title: note?.id === noteId ? note.title : null,
          event: note?.id === noteId ? note.event : null,
          transcription: s.ui,
          warning: warningFor(live.health, noteId),
          inactivity: live.inactivity?.noteId === noteId ? live.inactivity : null
        }
      : null
    const key = JSON.stringify(doc)
    if (key === lastSent) return
    lastSent = key
    api.bubble.setDocument(doc)
  }

  const load = (noteId: string): void => {
    loading = noteId
    void api.notes
      .get({ id: noteId })
      .then((n) => {
        if (loading !== noteId) return
        note = n ? { id: n.id, title: n.title, event: n.linked_event } : { id: noteId, title: null, event: null }
        send()
      })
      .catch(() => undefined)
  }

  const onCapture = (): void => {
    const noteId = getCaptureSnapshot().transcribingNoteId
    if (noteId && note?.id !== noteId && loading !== noteId) load(noteId)
    if (!noteId) loading = null
    send()
  }

  const offCapture = subscribeCapture(onCapture)
  const offLive = subscribeLive(send)
  const offNotes = api.notes.onChanged((c) => {
    const noteId = getCaptureSnapshot().transcribingNoteId
    if (noteId && c.tables.includes('documents') && c.ids.includes(noteId)) load(noteId)
  })
  onCapture()

  return () => {
    offCapture()
    offLive()
    offNotes()
    if (lastSent !== null && lastSent !== 'null') api.bubble.setDocument(null)
    lastSent = null
  }
}
