// SPDX-License-Identifier: Apache-2.0
// A small anchored popover for chat menus (model picker, thread actions, recent chats).
// Rendered in a portal with fixed positioning, so it is never clipped by a scroll box.
// Escape and an outside click close it; focus returns to the anchor.

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose(): void
  align?: 'start' | 'end'
  /** Above the anchor (composer menus) or below it. */
  placement?: 'above' | 'below'
  className?: string
  label?: string
  children: ReactNode
}

const GAP = 6
const MARGIN = 8

export function Popover({ anchor, open, onClose, align = 'start', placement = 'below', className, label, children }: Props): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = (): void => {
      const a = anchor.current?.getBoundingClientRect()
      const el = ref.current
      if (!a || !el) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      let left = align === 'end' ? a.right - w : a.left
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN))
      let top = placement === 'above' ? a.top - h - GAP : a.bottom + GAP
      if (placement === 'below' && top + h > window.innerHeight - MARGIN) top = Math.max(MARGIN, a.top - h - GAP)
      if (placement === 'above' && top < MARGIN) top = Math.min(window.innerHeight - h - MARGIN, a.bottom + GAP)
      setPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, anchor, align, placement])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
      anchor.current?.focus()
    }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [open, anchor])

  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={`chat-pop${className ? ` ${className}` : ''}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      {children}
    </div>,
    document.body
  )
}
