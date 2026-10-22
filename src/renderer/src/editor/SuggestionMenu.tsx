// SPDX-License-Identifier: Apache-2.0
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from 'react'
import type { MenuStore } from './menus'

interface SuggestionMenuProps<I> {
  store: MenuStore<I>
  label: string
  /** Shown when the query matches nothing; null hides the menu instead. */
  empty: string | null
  itemKey(item: I): string
  renderItem(item: I, selected: boolean): ReactNode
}

const GAP = 6
const MARGIN = 8

/** A caret-anchored list for the `/` and `@` suggestion plugins. */
export function SuggestionMenu<I>({ store, label, empty, itemKey, renderItem }: SuggestionMenuProps<I>): JSX.Element | null {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    const rect = state.rect
    if (!state.open || !el || !rect) {
      setPos(null)
      return
    }
    const h = el.offsetHeight
    const w = el.offsetWidth
    const below = rect.bottom + GAP
    const top = below + h > window.innerHeight - MARGIN ? Math.max(MARGIN, rect.top - GAP - h) : below
    const left = Math.min(Math.max(MARGIN, rect.left), window.innerWidth - w - MARGIN)
    setPos({ top, left })
  }, [state])

  useLayoutEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [state.selected])

  if (!state.open || (state.items.length === 0 && empty === null)) return null

  return (
    <div
      ref={ref}
      className="ne-menu"
      role="listbox"
      aria-label={label}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden', top: 0, left: 0 }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {state.items.length === 0 ? (
        <div className="ne-menu__empty">{empty}</div>
      ) : (
        state.items.map((item, i) => (
          <div
            key={itemKey(item)}
            role="option"
            aria-selected={i === state.selected}
            className={`ne-menu__item${i === state.selected ? ' is-selected' : ''}`}
            onMouseEnter={() => store.select(i)}
            onClick={() => state.pick?.(item)}
          >
            {renderItem(item, i === state.selected)}
          </div>
        ))
      )}
    </div>
  )
}
