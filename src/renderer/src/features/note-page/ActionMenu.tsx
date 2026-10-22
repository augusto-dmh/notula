// SPDX-License-Identifier: Apache-2.0
// A small action menu: the note header's "…" menu and the home row's
// context menu. Fixed-positioned at an anchor rectangle or a point, kept on screen,
// with arrow-key navigation, Escape and outside-click closing.

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import './action-menu.css'

export type ActionMenuEntry =
  | { kind: 'item'; id: string; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; hint?: string; onSelect(): void }
  | { kind: 'divider'; id: string }

export type ActionMenuAnchor = { rect: DOMRect; align: 'start' | 'end' } | { point: { x: number; y: number } }

const EDGE = 8
const GAP = 6

export function ActionMenu({
  label,
  anchor,
  entries,
  owner,
  onClose,
  extra
}: {
  label: string
  anchor: ActionMenuAnchor
  entries: ActionMenuEntry[]
  /** Owner-drawn items after the entries (the dispatcher's "Run dispatcher"). */
  extra?: ReactNode
  /** The button that toggles the menu: a press on it is left to its own click. */
  owner?: HTMLElement | null
  onClose(refocus: boolean): void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left: number
    let top: number
    if ('point' in anchor) {
      left = anchor.point.x
      top = anchor.point.y
    } else {
      left = anchor.align === 'end' ? anchor.rect.right - w : anchor.rect.left
      top = anchor.rect.bottom + GAP
      if (top + h > window.innerHeight - EDGE) top = anchor.rect.top - GAP - h
    }
    left = Math.max(EDGE, Math.min(left, window.innerWidth - w - EDGE))
    top = Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE))
    setPos({ left, top })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !owner?.contains(t)) onClose(false)
    }
    const onBlur = (): void => onClose(false)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
    }
  }, [onClose, owner])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      onClose(true)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])
    if (items.length === 0) return
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next =
      e.key === 'Home'
        ? items[0]
        : e.key === 'End'
          ? items[items.length - 1]
          : items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
    next?.focus()
  }

  return (
    <div
      ref={ref}
      className="action-menu"
      role="menu"
      aria-label={label}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry) =>
        entry.kind === 'divider' ? (
          <div key={entry.id} className="action-menu__divider" role="separator" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className={`action-menu__item${entry.danger ? ' action-menu__item--danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => {
              onClose(false)
              entry.onSelect()
            }}
          >
            {entry.icon ? (
              <span className="action-menu__icon" aria-hidden="true">
                {entry.icon}
              </span>
            ) : null}
            <span className="action-menu__label">{entry.label}</span>
            {entry.hint ? <span className="action-menu__hint">{entry.hint}</span> : null}
          </button>
        )
      )}
      {extra}
    </div>
  )
}
