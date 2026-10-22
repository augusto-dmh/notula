// SPDX-License-Identifier: Apache-2.0
// The sidebar footer's Trash button and its popover. The
// button exists only while Trash holds a note; the list follows `notes:changed`.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { TrashItem } from '@shared/types/notes'
import { IconNote } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { deletePermanently, restoreFromTrash } from './actions'
import { IconRestore, IconTrash } from './icons'
import './trash.css'

const POPOVER_WIDTH = 355
const POPOVER_HEIGHT = 390
const POPOVER_GAP = 8
const EDGE = 8
const REFRESH_DEBOUNCE_MS = 150

type TrashState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: TrashItem[] }

/** `notes:list-trash`, refreshed on every documents change. */
function useTrashList(): { state: TrashState; refresh(): void } {
  const [state, setState] = useState<TrashState>({ status: 'loading' })
  const request = useRef(0)
  const refresh = useCallback((): void => {
    const n = ++request.current
    window.notula.notes
      .listTrash()
      .then((items) => {
        if (n === request.current) setState({ status: 'ready', items })
      })
      .catch((err: unknown) => {
        debugLog('trash-list-failed', { err: String(err) })
        if (n === request.current) setState((prev) => (prev.status === 'ready' ? prev : { status: 'error' }))
      })
  }, [])
  useEffect(() => {
    refresh()
    let timer: ReturnType<typeof setTimeout> | null = null
    const offNotes = window.notula.notes.onChanged((c) => {
      if (!c.tables.includes('documents') && !c.tables.includes('note_panels')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS)
    })
    // Storage coming back from a recovery state.
    const offStatus = window.notula.storage.onStatusChanged((s) => {
      if (s.state === 'ready') refresh()
    })
    return () => {
      offNotes()
      offStatus()
      if (timer) clearTimeout(timer)
    }
  }, [refresh])
  return { state, refresh }
}

export function TrashButton(): JSX.Element | null {
  const { state, refresh } = useTrashList()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const count = state.status === 'ready' ? state.items.length : 0

  // The button disappears with the last note; so does an open popover.
  useEffect(() => {
    if (open && state.status === 'ready' && count === 0) setOpen(false)
  }, [open, state.status, count])

  if (count === 0) return null

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="n-btn n-btn--ghost trash-button"
        title="Trash"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) refresh()
          setOpen((o) => !o)
        }}
      >
        <IconTrash size={16} />
        Trash
      </button>
      {open ? (
        <TrashPopover
          anchor={buttonRef.current}
          state={state}
          onClose={(refocus) => {
            setOpen(false)
            if (refocus) buttonRef.current?.focus()
          }}
        />
      ) : null}
    </>
  )
}

function TrashPopover({
  anchor,
  state,
  onClose
}: {
  anchor: HTMLElement | null
  state: TrashState
  onClose(refocus: boolean): void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: EDGE, top: EDGE })

  // To the right of the button, its bottom aligned with the button's, kept on screen.
  useLayoutEffect(() => {
    const place = (): void => {
      const r = anchor?.getBoundingClientRect()
      if (!r) return
      const left = Math.min(r.right + POPOVER_GAP, window.innerWidth - POPOVER_WIDTH - EDGE)
      const top = Math.max(EDGE, Math.min(r.bottom - POPOVER_HEIGHT, window.innerHeight - POPOVER_HEIGHT - EDGE))
      setPos({ left: Math.max(EDGE, left), top })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      onClose(false)
    }
    window.addEventListener('mousedown', onDown)
    ref.current?.querySelector<HTMLElement>('.trash-row__open')?.focus()
    return () => window.removeEventListener('mousedown', onDown)
  }, [anchor, onClose])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose(true)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>('.trash-row__open') ?? [])
    const i = rows.findIndex((r) => r.closest('.trash-row')?.contains(document.activeElement))
    rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus()
  }

  return (
    <div
      ref={ref}
      className="trash-popover"
      role="dialog"
      aria-label="Trash"
      style={{ left: pos.left, top: pos.top, width: POPOVER_WIDTH, height: POPOVER_HEIGHT }}
      onKeyDown={onKeyDown}
    >
      {/* The retention notice is the header's subtitle; no footer. */}
      <header className="trash-popover__header">
        <span className="trash-popover__title">Trash</span>
        <span className="trash-popover__subtitle">Notes here are deleted for good after 30 days</span>
      </header>
      <div className="trash-popover__body">
        {state.status === 'loading' ? (
          <p className="trash-popover__empty">Loading...</p>
        ) : state.status === 'error' ? (
          <p className="trash-popover__empty">Trash isn’t available right now.</p>
        ) : state.items.length === 0 ? (
          <p className="trash-popover__empty">No notes in Trash</p>
        ) : (
          <ul className="trash-popover__list">
            {state.items.map((item) => (
              <li key={item.id} className="trash-row">
                <button
                  type="button"
                  className="trash-row__open"
                  onClick={() => {
                    onClose(false)
                    navigate(`/meeting/${encodeURIComponent(item.id)}`)
                  }}
                >
                  <span className="trash-row__icon" aria-hidden="true">
                    <IconNote size={16} />
                  </span>
                  <span className={`trash-row__title${item.title ? '' : ' is-untitled'}`}>{item.title || 'New note'}</span>
                </button>
                <span className="trash-row__actions">
                  <span className="n-tooltip" data-tooltip="Restore">
                    <button
                      type="button"
                      className="n-icon-btn n-icon-btn--sm"
                      aria-label={`Restore ${item.title || 'New note'}`}
                      onClick={() => {
                        onClose(false)
                        void restoreFromTrash(item.id)
                      }}
                    >
                      <IconRestore size={15} />
                    </button>
                  </span>
                  <span className="n-tooltip n-tooltip--end" data-tooltip="Delete permanently">
                    <button
                      type="button"
                      className="n-icon-btn n-icon-btn--sm trash-row__delete"
                      aria-label={`Delete ${item.title || 'New note'} permanently`}
                      onClick={() => {
                        onClose(false)
                        void deletePermanently(item.id)
                      }}
                    >
                      <IconTrash size={15} />
                    </button>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
