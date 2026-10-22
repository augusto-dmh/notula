// SPDX-License-Identifier: Apache-2.0
// The series view's dialogs: Import catalog (pasted text or a Markdown file, previewed with a dry
// run), Merge (two notes of one source, with Undo), and the plain confirmations (Ungroup, Delete
// catalog). Each renders on the native <dialog> of the folders' Modal.

import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { CatalogImportResult, SourceSeries } from '@shared/types/sources'
import { IconClose } from '../../../app/icons'
import { showToast } from '../../../app/toast'
import { readRoomHtml, roomIdFor } from '../../../editor'
import { Modal } from '../../folders/Modal'
import { isMissingHandler } from '../note/source-store'

/** 2 MB, as main accepts. */
const MAX_CATALOG_CHARS = 2 * 1024 * 1024
const PREVIEW_DELAY_MS = 400

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

function failure(err: unknown, action: string): string {
  if (isMissingHandler(err)) return `${action} isn’t available in this build yet.`
  const { code, message } = parseError(err)
  if ((code === 'invalid-input' || code === 'busy' || code === 'not-found') && message) return message
  return `Couldn’t ${action.toLowerCase()}. Try again.`
}

function DialogHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose(): void }): JSX.Element {
  return (
    <header className="h-modal__header">
      <div>
        <h2 className="h-modal__title">{title}</h2>
        {subtitle ? <p className="h-modal__subtitle">{subtitle}</p> : null}
      </div>
      <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Close" onClick={onClose}>
        <IconClose size={15} />
      </button>
    </header>
  )
}

// ---------- Import catalog ----------

function previewLine(r: CatalogImportResult): string {
  const lessons = plural(r.items, 'lesson', 'lessons')
  const where = r.sections > 0 ? ` in ${plural(r.sections, 'section', 'sections')}` : ''
  const numbered = r.numbered > 0 ? ` ${plural(r.numbered, 'note gets', 'notes get')} a lesson number.` : ''
  return `${lessons}${where}.${numbered}`
}

export function ImportCatalogDialog({ series, catalogCount, onClose, onDone }: { series: SourceSeries; catalogCount: number; onClose(): void; onDone(): void }): JSX.Element {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<CatalogImportResult | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const textId = useId()
  const hintId = useId()

  // A dry run counts lessons, sections and the notes it would number, as the user types.
  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    if (!text.trim()) return
    let stale = false
    const t = setTimeout(() => {
      window.notula.sources
        .importCatalog({ seriesId: series.id, input: { kind: 'text', text }, dryRun: true })
        .then((r) => !stale && setPreview(r))
        .catch((err: unknown) => !stale && setPreviewError(failure(err, 'Read the catalog')))
    }, PREVIEW_DELAY_MS)
    return () => {
      stale = true
      clearTimeout(t)
    }
  }, [text, series.id])

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setError(null)
    if (file.size > MAX_CATALOG_CHARS) {
      setError('That file is too large for a catalog. Use a file under 2 MB.')
      return
    }
    try {
      setText(await file.text())
    } catch {
      setError('Couldn’t read that file. Choose another one.')
    }
  }

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.notula.sources.importCatalog({ seriesId: series.id, input: { kind: 'text', text } })
      showToast({
        kind: 'success',
        title: 'Catalog imported',
        description: r.numbered > 0 ? `${plural(r.numbered, 'note', 'notes')} numbered.` : undefined,
        durationMs: 4_000
      })
      onDone()
      onClose()
    } catch (err) {
      setBusy(false)
      setError(failure(err, 'Import the catalog'))
    }
  }

  return (
    <Modal label="Import catalog" className="series-dialog" onClose={() => !busy && onClose()}>
      <form
        className="h-modal__body"
        onSubmit={(e) => {
          e.preventDefault()
          if (preview && !busy) void run()
        }}
      >
        <DialogHeader title="Import catalog" subtitle={`The lesson list of “${series.title}”, in order.`} onClose={onClose} />
        <label className="series-dialog__label" htmlFor={textId}>
          Lessons
        </label>
        <textarea
          id={textId}
          className="n-input series-dialog__text"
          rows={12}
          value={text}
          spellCheck={false}
          placeholder={'## Module 1\n1. Welcome (04:12)\n2. Setting up https://…'}
          aria-describedby={hintId}
          data-autofocus
          onChange={(e) => setText(e.target.value.slice(0, MAX_CATALOG_CHARS))}
        />
        <p className="series-dialog__hint" id={hintId}>
          One lesson per line, with an optional number, duration and link. Headings become sections.
        </p>
        <div className="series-dialog__row">
          <button type="button" className="n-btn n-btn--sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            Choose file…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            hidden
            onChange={(e) => {
              void onFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <span className="series-dialog__preview" role="status">
            {previewError ?? (preview ? previewLine(preview) : '')}
            {preview && preview.skippedLines > 0 ? ` ${plural(preview.skippedLines, 'line', 'lines')} skipped.` : ''}
          </span>
        </div>
        {catalogCount > 0 ? (
          <p className="series-dialog__hint">
            This replaces the current catalog of {plural(catalogCount, 'lesson', 'lessons')}. Numbers you set by hand stay.
          </p>
        ) : null}
        {error ? (
          <p className="series-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="h-modal__footer">
          <button type="button" className="n-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="n-btn n-btn--primary" disabled={!preview || busy}>
            {busy ? 'Importing…' : preview ? `Import ${plural(preview.items, 'lesson', 'lessons')}` : 'Import'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

// ---------- Merge ----------

export interface MergeCandidate {
  noteId: string
  title: string
  createdAt: string
}

/**
 * Opens a note's room the way its editor would, so a note never opened since an import has its
 * text in the room before main appends from it.
 */
async function prepareRoom(noteId: string): Promise<void> {
  const note = await window.notula.notes.get({ id: noteId })
  if (!note) return
  const seed = { ...(note.notes ? { json: note.notes } : {}), ...(note.notes_md ? { markdown: note.notes_md } : {}) }
  await readRoomHtml(roomIdFor('notes', noteId), 'notes', seed)
}

async function undoMerge(mergeId: string, onDone: () => void): Promise<void> {
  try {
    await window.notula.sources.mergeUndo({ mergeId })
    showToast({ kind: 'success', title: 'Merge undone', durationMs: 3_000 })
    onDone()
  } catch (err) {
    showToast({ kind: 'error', title: 'Couldn’t undo the merge', description: failure(err, 'Undo the merge') })
  }
}

export function MergeDialog({ older, newer, onClose, onDone }: { older: MergeCandidate; newer: MergeCandidate; onClose(): void; onDone(): void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await Promise.all([prepareRoom(older.noteId), prepareRoom(newer.noteId)]).catch(() => undefined)
      const r = await window.notula.sources.mergeNotes({ noteIds: [older.noteId, newer.noteId], confirmed: true })
      showToast({
        kind: 'success',
        title: 'Notes merged',
        description: 'The newer note moved to Trash.',
        action: { label: 'Undo', onClick: () => void undoMerge(r.mergeId, onDone) },
        durationMs: 12_000
      })
      onDone()
      onClose()
    } catch (err) {
      setBusy(false)
      setError(failure(err, 'Merge these notes'))
    }
  }

  return (
    <Modal label="Merge these notes?" className="series-dialog series-dialog--confirm" onClose={() => !busy && onClose()}>
      <div className="h-modal__body">
        <h2 className="h-modal__title">Merge these notes?</h2>
        <p className="h-modal__text">
          “{newer.title}” is added to the end of “{older.title}” under a dated heading, with its transcript and enhanced notes. Then it moves to Trash.
        </p>
        <p className="h-modal__text">You can undo this right after.</p>
        {error ? (
          <p className="series-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="h-modal__footer">
          <button type="button" className="n-btn" disabled={busy} onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--primary" disabled={busy} onClick={() => void run()}>
            {busy ? 'Merging…' : 'Merge notes'}
          </button>
        </footer>
      </div>
    </Modal>
  )
}

// ---------- confirmations ----------

export function ConfirmDialog({
  title,
  body,
  confirm,
  busyLabel,
  danger,
  action,
  onClose
}: {
  title: string
  body: string
  confirm: string
  busyLabel: string
  danger?: boolean
  action(): Promise<void>
  onClose(): void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onClose()
    } catch (err) {
      setBusy(false)
      setError(failure(err, confirm))
    }
  }

  return (
    <Modal label={title} className="series-dialog series-dialog--confirm" onClose={() => !busy && onClose()}>
      <div className="h-modal__body">
        <h2 className="h-modal__title">{title}</h2>
        <p className="h-modal__text">{body}</p>
        {error ? (
          <p className="series-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="h-modal__footer">
          <button type="button" className="n-btn" disabled={busy} onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button type="button" className={`n-btn ${danger ? 'n-btn--danger' : 'n-btn--primary'}`} disabled={busy} onClick={() => void run()}>
            {busy ? busyLabel : confirm}
          </button>
        </footer>
      </div>
    </Modal>
  )
}
