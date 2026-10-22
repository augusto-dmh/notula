// SPDX-License-Identifier: Apache-2.0
// A modal on the native <dialog>: focus stays inside, Escape and a backdrop
// click call `onClose`, and focus returns to where it was when the modal closes.

import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react'
import './folders.css'

export function Modal({
  label,
  className,
  onClose,
  children
}: {
  label: string
  className?: string
  onClose(): void
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    // showModal() focuses the first focusable element (the close button); React's autoFocus
    // ran before it, so the intended field is marked `data-autofocus` instead.
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => {
      if (dialog.open) dialog.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  return (
    <dialog
      ref={ref}
      className={`h-modal${className ? ` ${className}` : ''}`}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault()
        onCloseRef.current()
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        const r = e.currentTarget.getBoundingClientRect()
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
        if (!inside) onCloseRef.current()
      }}
    >
      {children}
    </dialog>
  )
}

/** Any modal open right now (a <dialog> or an aria-modal surface), other than `except`. */
export function anotherModalOpen(except?: Element | null): boolean {
  const open = document.querySelectorAll('dialog[open], [aria-modal="true"]')
  for (const el of open) if (el !== except && !except?.contains(el)) return true
  return false
}
