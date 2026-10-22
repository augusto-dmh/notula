// SPDX-License-Identifier: Apache-2.0
// TitleField: the note title, saved on every change, with
// Enter handing focus to the note and Escape going back. It also asks main for an AI
// title once per mount while the note is untitled, owned, not transcribing and has a
// transcript; a too-short transcript tries again when the transcript changes.

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { navigate } from '../../app/navigation'
import { debugLog, isOwnNote } from '../../app/platform'
import { useCaptureState } from '../capture'
import { useNote, useTranscriptCount } from './store'
import './enhance.css'

export interface TitleFieldProps {
  noteId: string
  readOnly: boolean
  onEnter(): void
}

const PLACEHOLDER = 'New note'

export function TitleField({ noteId, readOnly, onEnter }: TitleFieldProps): JSX.Element {
  const note = useNote(noteId)
  const capture = useCaptureState()
  const chunkCount = useTranscriptCount(noteId)
  const stored = note?.title ?? ''
  const [value, setValue] = useState(stored)
  const ref = useRef<HTMLTextAreaElement>(null)
  const focused = useRef(false)

  // Store → field. While the user edits, late echoes of their own saves are ignored;
  // a title arriving for an empty field (the AI title) still shows.
  useEffect(() => {
    if (focused.current && value.trim() !== '') return
    setValue(stored)
    // Only a stored change syncs.
  }, [stored])

  // Multi-line field that grows with its content, and re-measures when its width
  // changes (window resize, transcript panel), where the same title can wrap again.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let width = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const save = (next: string): void => {
    window.notula.notes
      .update({ id: noteId, patch: { title: next.trim() ? next : null } })
      .catch((err: unknown) => debugLog('title-save-failed', { noteId, err: parseError(err) }))
  }

  // The AI title.
  const own = !!note && isOwnNote(note)
  const transcribing = capture.transcribingNoteId === noteId
  const untitled = !!note && !note.title?.trim()
  const attempted = useRef(false)
  useEffect(() => {
    if (!own || readOnly || transcribing || !untitled || chunkCount === 0 || attempted.current) return
    attempted.current = true
    window.notula.enhance
      .generateTitle({ noteId })
      .then((r) => {
        debugLog('title-autofill', { noteId, status: r.status, reason: r.reason })
        // Too short: inputs changing (more transcript) may make it eligible again.
        if (r.status === 'skipped' && (r.reason === 'transcript-too-short' || r.reason === 'transcribing')) attempted.current = false
      })
      .catch((err: unknown) => debugLog('title-autofill-failed', { noteId, err: parseError(err) }))
  }, [noteId, own, readOnly, transcribing, untitled, chunkCount])

  return (
    <textarea
      ref={ref}
      className="enh-title"
      rows={1}
      value={value}
      placeholder={PLACEHOLDER}
      readOnly={readOnly}
      spellCheck={false}
      aria-label="Note title"
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
      }}
      onChange={(e) => {
        // One line of text: pasted line breaks become spaces.
        const next = e.target.value.replace(/[\r\n]+/g, ' ')
        setValue(next)
        save(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onEnter()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          if (window.history.length > 1) window.history.back()
          else navigate('/')
        }
      }}
    />
  )
}
