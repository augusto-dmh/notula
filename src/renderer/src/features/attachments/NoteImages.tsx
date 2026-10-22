// SPDX-License-Identifier: Apache-2.0
// The note's image strip and viewer. Images load
// through `attachments:read` and are shown from memory. The strip is hidden without
// images; uploads in flight show their local preview and a spinner.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { NoteAttachment } from '@shared/types/notes'
import { IconChevronLeft, IconClose, IconDownload } from '../../app/icons'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { AttachmentImage } from './AttachmentImage'
import { forgetImage } from './image-cache'
import { usePendingImages } from './upload'
import './attachments.css'

function IconCopyImage({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2.5" />
      <path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" />
    </svg>
  )
}

function IconTrashSmall({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" />
    </svg>
  )
}

function altFor(a: NoteAttachment): string {
  return a.screen_capture_info?.description?.trim() || 'Uploaded image'
}

async function copyImage(id: string): Promise<void> {
  try {
    await window.notula.attachments.copyImage({ attachmentId: id })
    showToast({ id: 'att-copied', kind: 'success', title: 'Image copied to clipboard' })
  } catch (err) {
    debugLog('attachments-copy-failed', { err: parseError(err) })
    showToast({ id: 'att-copy-failed', kind: 'error', title: 'Couldn’t copy the image. It may have been deleted.' })
  }
}

async function downloadImage(id: string): Promise<void> {
  try {
    await window.notula.attachments.saveAs({ attachmentId: id })
  } catch (err) {
    debugLog('attachments-save-failed', { err: parseError(err) })
    showToast({ id: 'att-save-failed', kind: 'error', title: 'Couldn’t save the image. It may have been deleted.' })
  }
}

export function NoteImages({ noteId, attachments, editable }: { noteId: string; attachments: NoteAttachment[]; editable: boolean }): JSX.Element | null {
  const pending = usePendingImages(noteId)
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set())
  const [viewing, setViewing] = useState<number | null>(null)
  const shown = attachments.filter((a) => !removing.has(a.id))

  const remove = useCallback(
    (id: string): void => {
      if (!editable || removing.has(id)) return
      setRemoving((s) => new Set(s).add(id))
      window.notula.attachments
        .remove({ attachmentId: id })
        .then(() => forgetImage(id))
        .catch((err: unknown) => {
          debugLog('attachments-remove-failed', { err: parseError(err) })
          showToast({ id: 'att-remove-failed', kind: 'error', title: 'Couldn’t remove the attachment. Try again.' })
        })
        .finally(() =>
          setRemoving((s) => {
            const next = new Set(s)
            next.delete(id)
            return next
          })
        )
    },
    [editable, removing]
  )

  // A removed image that is gone from the list closes or moves the viewer.
  useEffect(() => {
    if (viewing !== null && viewing >= shown.length) setViewing(shown.length ? shown.length - 1 : null)
  }, [viewing, shown.length])

  if (shown.length === 0 && pending.length === 0) return null
  return (
    <section className="att-strip" aria-label="Images">
      {shown.map((a, i) => (
        <div key={a.id} className="att-thumb">
          <button type="button" className="att-thumb__open" onClick={() => setViewing(i)} aria-label={`Open image ${i + 1} of ${shown.length}`}>
            <AttachmentImage attachmentId={a.id} alt={altFor(a)} className="att-thumb__img" />
          </button>
          {a.screen_capture_info ? <span className="att-thumb__badge">Snapshot</span> : null}
          {editable ? (
            <button type="button" className="att-thumb__remove" aria-label="Remove image" onClick={() => remove(a.id)}>
              <IconClose size={12} />
            </button>
          ) : null}
        </div>
      ))}
      {pending.map((p) => (
        <div key={p.key} className="att-thumb att-thumb--pending" aria-busy="true" aria-label={`Adding ${p.name}`}>
          {p.preview ? <img className="att-thumb__img" src={p.preview} alt="" draggable={false} /> : <span className="att-thumb__img att-image--loading" />}
          <span className="att-thumb__spinner n-spinner" aria-hidden="true" />
        </div>
      ))}
      {viewing !== null && shown[viewing] ? (
        <ImageViewer
          images={shown}
          index={viewing}
          editable={editable}
          onIndex={setViewing}
          onRemove={(id) => remove(id)}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </section>
  )
}

function ImageViewer({
  images,
  index,
  editable,
  onIndex,
  onRemove,
  onClose
}: {
  images: NoteAttachment[]
  index: number
  editable: boolean
  onIndex(i: number): void
  onRemove(id: string): void
  onClose(): void
}): JSX.Element {
  const image = images[index] as NoteAttachment
  const dialog = useRef<HTMLDivElement>(null)
  const count = images.length

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    return () => before?.focus?.()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowLeft' && count > 1) {
        e.preventDefault()
        onIndex((index - 1 + count) % count)
      } else if (e.key === 'ArrowRight' && count > 1) {
        e.preventDefault()
        onIndex((index + 1) % count)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, count, onIndex, onClose])

  return (
    <div className="att-viewer" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="att-viewer__dialog" role="dialog" aria-modal="true" aria-label={`Image ${index + 1} of ${count}`} tabIndex={-1}>
        <header className="att-viewer__bar">
          <span className="att-viewer__title">
            Image {index + 1} of {count}
          </span>
          <span className="att-viewer__actions">
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void copyImage(image.id)}>
              <IconCopyImage size={15} />
              Copy image
            </button>
            <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void downloadImage(image.id)}>
              <IconDownload size={15} />
              Download
            </button>
            {editable ? (
              <button type="button" className="n-btn n-btn--sm n-btn--ghost att-viewer__danger" onClick={() => onRemove(image.id)}>
                <IconTrashSmall size={15} />
                Remove
              </button>
            ) : null}
            <button type="button" className="n-icon-btn" aria-label="Close" onClick={onClose}>
              <IconClose size={18} />
            </button>
          </span>
        </header>
        <div className="att-viewer__stage">
          {count > 1 ? (
            <button type="button" className="att-viewer__nav att-viewer__nav--prev" aria-label="Previous image" onClick={() => onIndex((index - 1 + count) % count)}>
              <IconChevronLeft size={20} />
            </button>
          ) : null}
          <AttachmentImage key={image.id} attachmentId={image.id} alt={altFor(image)} className="att-viewer__img" />
          {count > 1 ? (
            <button type="button" className="att-viewer__nav att-viewer__nav--next" aria-label="Next image" onClick={() => onIndex((index + 1) % count)}>
              <IconChevronLeft size={20} />
            </button>
          ) : null}
        </div>
        {image.screen_capture_info?.description && image.screen_capture_info.model !== 'none' ? (
          <p className="att-viewer__caption">{image.screen_capture_info.description}</p>
        ) : null}
      </div>
    </div>
  )
}
