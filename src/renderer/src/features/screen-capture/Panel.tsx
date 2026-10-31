// SPDX-License-Identifier: Apache-2.0
// The screen-capture panel (`#/screen-capture?captureId=…`): up to 4 removable previews, an
// optional note, another grab, Save (Ctrl/Cmd+Enter) and Close (Escape). The images stay in
// main until Save; this window only shows small previews.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { CAPTURE_NOTE_MAX } from '@shared/types/attachments'
import { SCREEN_CAPTURE_LIMITS, type ScreenCaptureState } from '@shared/types/screen-capture'
import './screen-capture.css'

type Phase =
  | { kind: 'editing'; message: string | null }
  | { kind: 'capturing' }
  | { kind: 'saving' }
  | { kind: 'saved'; noteId: string; title: string }
  | { kind: 'error' }

const isMac = navigator.userAgent.includes('Mac')

function captureIdFromHash(): string {
  const q = window.location.hash.split('?')[1] ?? ''
  return new URLSearchParams(q).get('captureId') ?? ''
}

function limitMessage(room: number): string {
  if (room <= 0) return 'This note already has 10 images, the most it can hold. Remove one from the note to save these.'
  return room === 1
    ? 'This note has room for 1 more image. Remove some here to save.'
    : `This note has room for ${room} more images. Remove some here to save.`
}

export function Panel(): JSX.Element {
  const [captureId, setCaptureId] = useState(captureIdFromHash)
  const [state, setState] = useState<ScreenCaptureState | null>(null)
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'editing', message: null })
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const html = document.documentElement
    html.classList.add('cap-window')
    html.dataset['theme'] = 'dark'
    document.title = 'Screenshot'
  }, [])

  const load = useCallback((id: string): void => {
    void window.notula.screenCapture
      .getState({ captureId: id })
      .then((s) => {
        if (s) setState(s)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    load(captureId)
    return window.notula.screenCapture.onOpen(({ captureId: id }) => {
      setCaptureId(id)
      load(id)
      field.current?.focus()
    })
  }, [captureId, load])

  const close = useCallback((): void => {
    void window.notula.screenCapture.close({ captureId }).catch(() => undefined)
  }, [captureId])

  const save = useCallback(async (): Promise<void> => {
    if (!state?.images.length || phase.kind === 'saving' || phase.kind === 'saved' || phase.kind === 'capturing') return
    setPhase({ kind: 'saving' })
    try {
      const r = await window.notula.screenCapture.save({ captureId, note })
      if (r.status === 'saved') setPhase({ kind: 'saved', noteId: r.noteId, title: r.title })
      else if (r.status === 'limit') setPhase({ kind: 'editing', message: limitMessage(r.room) })
      else setPhase({ kind: 'error' })
    } catch {
      setPhase({ kind: 'error' })
    }
  }, [captureId, note, phase.kind, state])

  const another = async (): Promise<void> => {
    if (phase.kind !== 'editing' || (state?.images.length ?? 0) >= SCREEN_CAPTURE_LIMITS.images) return
    setPhase({ kind: 'capturing' })
    try {
      const r = await window.notula.screenCapture.take({ captureId, mode: 'region' })
      setState(r.state)
      setPhase({
        kind: 'editing',
        message: r.status === 'failed' ? 'Couldn’t capture the screen. Try again.' : r.status === 'permission-denied' ? 'Notula needs screen recording access to capture.' : null
      })
    } catch {
      setPhase({ kind: 'editing', message: 'Couldn’t capture the screen. Try again.' })
    }
    field.current?.focus()
  }

  const remove = async (index: number): Promise<void> => {
    if (phase.kind !== 'editing') return
    const next = await window.notula.screenCapture.removeImage({ captureId, index }).catch(() => null)
    if (next) setState(next)
    setPhase({ kind: 'editing', message: null })
    // Nothing left to save: the panel goes.
    if (next && next.images.length === 0) close()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, save])

  if (phase.kind === 'saved') {
    return (
      <div className="cap-panel cap-panel--done" role="status">
        <div className="cap-panel__done">
          <span className="cap-panel__done-title">Saved to “{phase.title}”</span>
        </div>
        <div className="cap-panel__actions">
          <button type="button" className="n-btn n-btn--sm" onClick={close}>
            Close
          </button>
          <button
            type="button"
            className="n-btn n-btn--sm n-btn--primary"
            onClick={() => void window.notula.screenCapture.openNote({ captureId, noteId: phase.noteId }).catch(() => undefined)}
          >
            Open note
          </button>
        </div>
      </div>
    )
  }

  const images = state?.images ?? []
  const busy = phase.kind === 'saving' || phase.kind === 'capturing'
  const full = images.length >= SCREEN_CAPTURE_LIMITS.images
  const message =
    phase.kind === 'error' ? 'Couldn’t save the screenshots. Try again.' : phase.kind === 'editing' ? phase.message : phase.kind === 'capturing' ? 'Capturing…' : null
  return (
    <div className="cap-panel" aria-busy={busy}>
      <div className="cap-panel__shots" aria-label="Screenshots">
        {images.map((img, i) => (
          <div key={`${i}-${img.preview.length}`} className="cap-shot">
            <img src={img.preview} alt={`Screenshot ${i + 1} of ${images.length}`} />
            <button type="button" className="cap-shot__remove" aria-label={`Remove screenshot ${i + 1}`} disabled={busy} onClick={() => void remove(i)}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        ))}
        {full ? null : (
          <button type="button" className="cap-shot cap-shot--add" aria-label="Capture another" title="Capture another" disabled={busy} onClick={() => void another()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
      </div>
      <div className="cap-panel__side">
        <textarea
          ref={field}
          className="cap-panel__note"
          placeholder="Add a note (optional)"
          aria-label="Note"
          aria-describedby={message ? 'cap-message' : undefined}
          value={note}
          maxLength={CAPTURE_NOTE_MAX}
          autoFocus
          disabled={phase.kind === 'saving'}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="cap-panel__actions">
          <span id="cap-message" className={`cap-panel__message${phase.kind === 'error' ? ' is-error' : ''}`} aria-live="polite">
            {message}
          </span>
          <button type="button" className="n-btn n-btn--sm" onClick={close}>
            Close
          </button>
          <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy || images.length === 0} title={isMac ? '⌘ Enter' : 'Ctrl+Enter'} onClick={() => void save()}>
            {phase.kind === 'saving' ? 'Saving…' : phase.kind === 'error' ? 'Try again' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
