// SPDX-License-Identifier: Apache-2.0
// Undo import: the batch's notes that still exist, ticked unless opened or changed since
// the import. Confirm moves the ticked notes to Trash (never deletes for good) and removes the
// folders the batch created that end up empty. One undo per batch.

import { useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { ImportUndoPreview } from '@shared/types/imports-markdown'
import { showToast } from '../../app/toast'
import { plural } from './labels'

export function UndoDialog({ batchId, onClose }: { batchId: string; onClose(): void }): JSX.Element {
  const [preview, setPreview] = useState<ImportUndoPreview | null>(null)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.notula.notesImport
      .undoPreview({ batchId })
      .then((p) => {
        setPreview(p)
        setTicked(new Set(p.notes.filter((n) => !n.changedSinceImport).map((n) => n.noteId)))
      })
      .catch((err: unknown) => setError(parseError(err).message))
  }, [batchId])

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function confirm(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await window.notula.notesImport.undo({ batchId, noteIds: [...ticked], confirmed: true })
      const folders = res.foldersDeleted ? ` and removed ${plural(res.foldersDeleted, 'empty folder', 'empty folders')}` : ''
      showToast({ id: 'notes-import-undo', kind: 'success', title: `Moved ${plural(res.trashed, 'note', 'notes')} to Trash${folders}` })
      onClose()
    } catch (err) {
      setError(parseError(err).message)
      setBusy(false)
    }
  }

  const toggle = (id: string, on: boolean): void => {
    const next = new Set(ticked)
    if (on) next.add(id)
    else next.delete(id)
    setTicked(next)
  }

  return (
    <div className="nix-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="nix-dialog" role="dialog" aria-modal="true" aria-labelledby="nix-undo-title" ref={ref}>
        <h2 className="nix-dialog__title" id="nix-undo-title">
          Undo this import?
        </h2>
        <div className="nix-dialog__body">
          {preview === null && !error ? <span className="n-spinner" aria-hidden="true" /> : null}
          {preview ? (
            <>
              <p className="nix-note">
                The ticked notes move to Trash, where you can restore them for 30 days. Notes you opened or changed since the import are unticked.
                {preview.foldersToDelete ? ` ${plural(preview.foldersToDelete, 'folder', 'folders')} the import created will be removed when empty.` : ''}
              </p>
              {preview.notes.length ? (
                <ul className="nix-list nix-list--ticks">
                  {preview.notes.map((n) => (
                    <li key={n.noteId}>
                      <label>
                        <input type="checkbox" checked={ticked.has(n.noteId)} onChange={(e) => toggle(n.noteId, e.target.checked)} />
                        <span>{n.title || 'Untitled'}</span>
                        {n.changedSinceImport ? <small className="nix-warning">Opened or changed since the import</small> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="nix-note">None of this import’s notes are left outside Trash.</p>
              )}
            </>
          ) : null}
          {error ? (
            <p className="nix-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="nix-dialog__footer">
          <button type="button" className="n-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="n-btn n-btn--danger" disabled={busy || preview === null} onClick={() => void confirm()}>
            {ticked.size ? `Move ${plural(ticked.size, 'note', 'notes')} to Trash` : 'Undo import'}
          </button>
        </div>
      </div>
    </div>
  )
}
