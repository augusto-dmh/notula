// SPDX-License-Identifier: Apache-2.0
// Manual transcript section delete: always available, from the transcript's selection bar.
// Main refuses while that note is being captured.

import { useState, type JSX } from 'react'
import { RETENTION_LIMITS } from '@shared/types/retention'
import { showToast } from '../../app/toast'
import { useCaptureState } from '../capture'
import { Modal } from '../folders/Modal'
import './retention.css'

export function SectionDeleteButton({ noteId, chunkIds, onClear }: { noteId: string; chunkIds: string[]; onClear(): void }): JSX.Element | null {
  const capture = useCaptureState()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!chunkIds.length) return null
  const tooMany = chunkIds.length > RETENTION_LIMITS.sectionDeleteMax
  const run = (): void => {
    setBusy(true)
    window.notula.transcript
      .deleteSections({ noteId, chunkIds, confirmed: true })
      .then(() => {
        setOpen(false)
        onClear()
        const capturing = capture.transcribingNoteId === noteId
        showToast({
          title: 'Transcript updated',
          kind: 'success',
          ...(capturing
            ? {}
            : {
                action: {
                  label: 'Regenerate notes',
                  onClick: () => void window.notula.enhance.generate({ noteId }).catch(() => showToast({ title: "Couldn't regenerate the notes.", kind: 'error' }))
                }
              })
        })
      })
      .catch((err: unknown) => {
        const busyErr = err instanceof Error && /busy: /.test(err.message)
        showToast({ title: busyErr ? 'Stop the transcript first' : 'Couldn’t delete the transcript section. Try again.', kind: 'error' })
      })
      .finally(() => setBusy(false))
  }
  return (
    <>
      <button type="button" className="nt-tr-link" onClick={() => setOpen(true)}>
        Delete
      </button>
      {open ? (
        <Modal label="Delete transcript sections" onClose={() => setOpen(false)}>
          <div className="h-modal__body retention-dialog">
            <h2 className="h-modal__title">{chunkIds.length === 1 ? 'Delete this transcript section?' : 'Delete selected transcript sections?'}</h2>
            {tooMany ? (
              <p className="h-modal__subtitle">
                You can delete up to {RETENTION_LIMITS.sectionDeleteMax} sections at a time. You selected {chunkIds.length}.
              </p>
            ) : (
              <p className="h-modal__subtitle">Deleted sections can’t be recovered.</p>
            )}
            <footer className="retention-dialog__actions">
              <button
                type="button"
                className="n-btn n-btn--ghost"
                data-autofocus
                onClick={() => {
                  setOpen(false)
                  onClear()
                }}
              >
                Clear selection
              </button>
              {tooMany ? null : (
                <button type="button" className="n-btn n-btn--danger" disabled={busy} onClick={run}>
                  {busy ? 'Deleting…' : 'Delete'}
                </button>
              )}
            </footer>
          </div>
        </Modal>
      ) : null}
    </>
  )
}
