// SPDX-License-Identifier: Apache-2.0
// GenerateButton and the "Transcript
// updated" toast after a stop, both for the open note.

import { useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { DEFAULT_TEMPLATE_SLUG } from '@shared/types/enhance'
import { DELETED_CHUNK_MARKER } from '@shared/types/transcript'
import { IconSparkle } from '../../app/icons'
import { debugLog, isOwnNote } from '../../app/platform'
import { showToast } from '../../app/toast'
import { useCaptureState } from '../capture'
import { temporaryTemplateId } from '../templates'
import { plainLength } from './EnhancedView'
import { registerNotesMarkdown, regenerateWith } from './regenerate'
import { orderPanels, useNote, useNoteGenerating, usePanelsSnapshot, useTranscriptCount } from './store'
import './enhance.css'

export interface GenerateButtonProps {
  noteId: string
  getNotesMarkdown(): string
}

const NOTES_CHARS_THRESHOLD = 20
/** How often the label re-reads the live editor while the button shows. */
const LABEL_POLL_MS = 1_500
/** After a stop, the final chunks are flushed before the toast checks them. */
const TRANSCRIPT_SETTLE_MS = 1_500

export function GenerateButton({ noteId, getNotesMarkdown }: GenerateButtonProps): JSX.Element | null {
  useEffect(() => registerNotesMarkdown(noteId, getNotesMarkdown), [noteId, getNotesMarkdown])
  useTranscriptUpdatedToast(noteId)

  const note = useNote(noteId)
  const { panels, loading } = usePanelsSnapshot(noteId)
  const capture = useCaptureState()
  const chunkCount = useTranscriptCount(noteId)
  const generating = useNoteGenerating(noteId)
  const [busy, setBusy] = useState(false)

  const visible =
    !!note &&
    isOwnNote(note) &&
    !loading &&
    panels.length === 0 &&
    chunkCount > 0 &&
    capture.transcribingNoteId !== noteId &&
    !generating &&
    !busy

  const readChars = (): number => {
    let live = 0
    try {
      live = plainLength(getNotesMarkdown())
    } catch {
      live = 0
    }
    return Math.max(live, note?.notes_text?.trim().length ?? 0)
  }
  const [notesChars, setNotesChars] = useState(0)
  useEffect(() => {
    if (!visible) return
    setNotesChars(readChars())
    const t = setInterval(() => setNotesChars(readChars()), LABEL_POLL_MS)
    return () => clearInterval(t)
    // readChars reads the latest note and editor on each tick.
  }, [visible, note?.notes_text])

  if (!visible) return null
  const label = notesChars > NOTES_CHARS_THRESHOLD ? 'Enhance notes' : 'Generate notes'

  const onClick = (): void => {
    setBusy(true)
    let markdown = ''
    try {
      markdown = getNotesMarkdown()
    } catch {
      markdown = ''
    }
    window.notula.enhance
      .generate({ noteId, ...(markdown.trim() ? { notesMarkdown: markdown } : {}) })
      .catch((err: unknown) => {
        showToast({ kind: 'error', title: 'Couldn’t generate notes', description: parseError(err).message })
      })
      .finally(() => setBusy(false))
  }

  return (
    <button type="button" className="n-btn n-btn--primary enh-generate" onClick={onClick}>
      <IconSparkle size={16} />
      {label}
    </button>
  )
}

/**
 * When this note's transcription stops, a note that already has a summary
 * and gained transcript after its newest panel was created offers to regenerate.
 */
function useTranscriptUpdatedToast(noteId: string): void {
  const capture = useCaptureState()
  const prev = useRef(capture.transcribingNoteId)

  useEffect(() => {
    const was = prev.current === noteId
    prev.current = capture.transcribingNoteId
    if (!was || capture.transcribingNoteId === noteId) return
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        const note = await window.notula.notes.get({ id: noteId }).catch(() => null)
        if (cancelled || !note || !isOwnNote(note)) return
        const panels = orderPanels(await window.notula.panels.list({ noteId }).catch(() => []))
        if (cancelled || panels.length === 0) return
        const newest = panels.reduce((a, b) => (b.created_at > a ? b.created_at : a), '')
        const chunks = await window.notula.transcript.get({ noteId }).catch(() => [])
        const updated = chunks.some((c) => c.text.trim() && c.text !== DELETED_CHUNK_MARKER && c.start_timestamp > newest)
        if (cancelled || !updated) return
        showToast({
          id: `transcript-updated-${noteId}`,
          title: 'Transcript updated',
          action: {
            label: 'Regenerate notes',
            onClick: () => {
              debugLog('summary-regenerate', { noteId, source: 'transcript-updated-toast' })
              // The default slug rule: the note's temporary template, else the default.
              void regenerateWith(noteId, { panel: panels[0] ?? null, templateSlug: temporaryTemplateId(noteId) ?? DEFAULT_TEMPLATE_SLUG })
            }
          }
        })
      })()
    }, TRANSCRIPT_SETTLE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [capture.transcribingNoteId, noteId])
}
