// SPDX-License-Identifier: Apache-2.0
// The note list of the folder and search pages (the folder page, "My notes" and `/search`): home's rows
// under day headers, virtualized in the page's scroll
// container. Rows drag as NOTE_DRAG_MIME, so a sidebar folder can take them. An
// optional third line (the search snippet) and a hover action ("Remove from folder").

import { useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { NOTE_DRAG_MIME } from '@shared/types/folders'
import type { NoteListItem } from '@shared/types/notes'
import { IconNote } from '../../app/icons'
import { isOwnNote } from '../../app/platform'
import { useCaptureState } from '../capture'
import { groupRows, noteAttendeeLine, noteTime } from '../home'
import { ActionMenu, type ActionMenuEntry } from '../note-page/ActionMenu'
import { usePrefs } from '../settings/prefs-store'

const HEADER_HEIGHT = 44
const ROW_HEIGHT = 60
const ROW_HEIGHT_EXTRA = 80

/** Home's time column: the local time, or "All day". */
export function noteTimeLabel(item: Pick<NoteListItem, 'linked_event' | 'sort_epoch' | 'created_at'>): string {
  const start = item.linked_event?.start
  if (start?.date && !start.dateTime) return 'All day'
  return noteTime(item).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export interface NoteRowAction {
  label: string
  icon: ReactNode
  run(item: NoteListItem): void
}

export function NoteList({
  items,
  scrollEl,
  label,
  onOpen,
  extraLine,
  action,
  menu
}: {
  items: readonly NoteListItem[]
  /** The page's scroll container. */
  scrollEl: HTMLElement | null
  label: string
  onOpen(id: string): void
  extraLine?(item: NoteListItem): ReactNode
  action?: NoteRowAction
  menu?(item: NoteListItem): ActionMenuEntry[]
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const [rowMenu, setRowMenu] = useState<{ item: NoteListItem; point: { x: number; y: number } } | null>(null)
  const capture = useCaptureState()
  const prefs = usePrefs()
  const selfEmail = prefs?.['profile.email'] || undefined
  const rows = useMemo(() => groupRows(items), [items])
  const rowHeight = extraLine ? ROW_HEIGHT_EXTRA : ROW_HEIGHT

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el || !scrollEl) return
    const measure = (): void => setOffset(el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop)
    measure()
    const ro = new ResizeObserver(measure)
    if (el.parentElement) ro.observe(el.parentElement)
    return () => ro.disconnect()
  }, [scrollEl])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => (rows[i]?.kind === 'header' ? HEADER_HEIGHT : rowHeight),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 10,
    scrollMargin: offset
  })

  return (
    <>
      <div ref={listRef} className="notes-list h-notes" role="list" aria-label={label} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index]
          if (!row) return null
          const style = { height: v.size, transform: `translateY(${v.start - virtualizer.options.scrollMargin}px)` }
          if (row.kind === 'header') {
            return (
              <div key={v.key} className={`notes-list__header${v.index === 0 ? ' is-first' : ''}`} style={style} role="presentation">
                {row.label}
              </div>
            )
          }
          const item = row.item
          const own = isOwnNote(item)
          const transcribing = capture.transcribingNoteId === item.id
          const extra = extraLine?.(item)
          return (
            <div
              key={v.key}
              className={`notes-list__slot h-notes__slot${action ? ' has-action' : ''}`}
              style={style}
              role="listitem"
              onContextMenu={
                menu
                  ? (e) => {
                      e.preventDefault()
                      setRowMenu({ item, point: { x: e.clientX, y: e.clientY } })
                    }
                  : undefined
              }
            >
              <button
                type="button"
                className="note-row h-notes__row"
                draggable={own}
                onDragStart={(e) => {
                  e.dataTransfer.setData(NOTE_DRAG_MIME, JSON.stringify([item.id]))
                  e.dataTransfer.setData('text/plain', item.title || 'New note')
                  e.dataTransfer.effectAllowed = 'copyMove'
                }}
                onClick={() => onOpen(item.id)}
                onKeyDown={(e) => {
                  if (menu && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
                    e.preventDefault()
                    const r = e.currentTarget.getBoundingClientRect()
                    setRowMenu({ item, point: { x: r.left + 48, y: r.bottom } })
                  }
                }}
              >
                <span className="note-row__icon" aria-hidden="true">
                  <IconNote size={18} />
                </span>
                <span className="note-row__text">
                  <span className={`note-row__title${item.title ? '' : ' is-untitled'}`}>{item.title || 'New note'}</span>
                  <span className="note-row__meta">{noteAttendeeLine(item, own, selfEmail, prefs?.['people.genericEmailDomains'])}</span>
                  {extra ? <span className="h-notes__extra">{extra}</span> : null}
                </span>
                {transcribing ? (
                  <span className="note-row__live">
                    <span className="note-row__live-dot" aria-hidden="true" />
                    Transcribing
                  </span>
                ) : (
                  <span className="note-row__time h-notes__time">{noteTimeLabel(item)}</span>
                )}
              </button>
              {action ? (
                <span className="n-tooltip n-tooltip--end h-notes__action" data-tooltip={action.label}>
                  <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label={action.label} onClick={() => action.run(item)}>
                    {action.icon}
                  </button>
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
      {rowMenu && menu ? (
        <ActionMenu label="Note" anchor={{ point: rowMenu.point }} entries={menu(rowMenu.item)} onClose={() => setRowMenu(null)} />
      ) : null}
    </>
  )
}
