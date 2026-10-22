// SPDX-License-Identifier: Apache-2.0
// Dropping images onto a note: the page tracks "dragging images"
// and "dragging while disabled", and hands dropped files to the upload path. Internal drags
// (text, notes) and drags without files are left alone.

import { useCallback, useRef, useState, type DragEvent, type JSX } from 'react'

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

export interface ImageDrop {
  dragging: boolean
  handlers: {
    onDragEnter(e: DragEvent): void
    onDragOver(e: DragEvent): void
    onDragLeave(e: DragEvent): void
    onDrop(e: DragEvent): void
  }
}

export function useImageDrop(enabled: boolean, onFiles: (files: File[]) => void): ImageDrop {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const onFilesRef = useRef(onFiles)
  onFilesRef.current = onFiles

  const onDragEnter = useCallback((e: DragEvent): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth.current++
    setDragging(true)
  }, [])
  const onDragOver = useCallback(
    (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = enabled ? 'copy' : 'none'
    },
    [enabled]
  )
  const onDragLeave = useCallback((e: DragEvent): void => {
    if (!hasFiles(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }, [])
  const onDrop = useCallback(
    (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      if (!enabled) return
      const files = Array.from(e.dataTransfer.files)
      if (files.length) onFilesRef.current(files)
    },
    [enabled]
  )
  return { dragging, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}

export function ImageDropOverlay({ visible, enabled }: { visible: boolean; enabled: boolean }): JSX.Element | null {
  if (!visible) return null
  return (
    <div className={`att-drop${enabled ? '' : ' att-drop--disabled'}`} aria-hidden="true">
      <div className="att-drop__card">
        <span className="att-drop__title">{enabled ? 'Drop images to add them to this note' : 'Images can’t be added to this note'}</span>
        <span className="att-drop__hint">{enabled ? 'PNG or JPEG, up to 10 images' : 'Only your own notes outside Trash take images'}</span>
      </div>
    </div>
  )
}
