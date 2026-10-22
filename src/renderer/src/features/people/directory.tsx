// SPDX-License-Identifier: Apache-2.0
// The pieces the People and Companies pages share: the header with its search toggle
// and tabs, the sortable
// table, date labels, the scroll container and the `people:changed` subscription.

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX, type KeyboardEvent, type ReactNode } from 'react'
import { IconClose, IconSearch } from '../../app/icons'

const DAY_MS = 86_400_000

function startOf(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "Today", "Yesterday", the weekday within a week, else the date (the year when it isn't this one). */
export function relativeDay(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Math.round((startOf(now) - startOf(d)) / DAY_MS)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) })
}

/** The folder tabs: the time for today, else the relative day. */
export function lastNoteLabel(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return startOf(d) === startOf(now) ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : relativeDay(iso, now)
}

/** The page's scroll container (the shell's FramedPage `.page__scroll`). */
export function useScrollContainer(): [(el: HTMLElement | null) => void, HTMLElement | null] {
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const attach = useCallback((el: HTMLElement | null) => {
    setScrollEl((el?.closest('.page__scroll') as HTMLElement | null) ?? null)
  }, [])
  return [attach, scrollEl]
}

/** Calls `cb` (debounced) after every `people:changed` push. */
export function usePeopleChanged(cb: () => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.notula.people.onChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => ref.current(), 120)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])
}

// ---------- header ----------

export function DirectoryHeader<T extends string>({
  title,
  tabs,
  tab,
  onTab,
  query,
  onQuery,
  searchLabel
}: {
  title?: string
  tabs?: readonly { value: T; label: string }[]
  tab?: T
  onTab?(t: T): void
  query: string
  onQuery(q: string): void
  searchLabel: string
}): JSX.Element {
  const [searching, setSearching] = useState(query.length > 0)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (searching) field.current?.focus()
  }, [searching])
  const close = (): void => {
    onQuery('')
    setSearching(false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }
  return (
    <div className="directory-head">
      {title ? <h1 className="directory-head__title">{title}</h1> : null}
      <div className="directory-head__bar">
        {tabs && tab !== undefined && onTab ? (
          <div className="directory-tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.value} type="button" role="tab" aria-selected={t.value === tab} className="directory-tabs__tab" onClick={() => onTab(t.value)}>
                {t.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className={`directory-search${searching ? ' is-open' : ''}`}>
          {searching ? (
            <>
              <IconSearch size={14} />
              <input
                ref={field}
                className="directory-search__field"
                value={query}
                placeholder="Search"
                aria-label={searchLabel}
                onChange={(e) => onQuery(e.target.value)}
                onKeyDown={onKeyDown}
                onBlur={() => {
                  if (!query.trim()) setSearching(false)
                }}
              />
              <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={close}>
                <IconClose size={12} />
              </button>
            </>
          ) : (
            <span className="n-tooltip n-tooltip--end" data-tooltip="Search">
              <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label={searchLabel} onClick={() => setSearching(true)}>
                <IconSearch size={15} />
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- the sortable table ----------

export interface Column<T> {
  id: string
  label: string
  /** Ascending comparison. */
  compare(a: T, b: T): number
  cell(row: T): ReactNode
  /** The direction the default column starts with. */
  defaultDir?: 'asc' | 'desc'
  className?: string
}

export interface SortState {
  column: string
  dir: 'asc' | 'desc'
}

/**
 * Clicking a header sorts by it ascending and clicking it again reverses; the
 * default column starts in its own direction.
 */
export function useSort<T>(columns: Column<T>[], initial: SortState): [SortState, (id: string) => void, (rows: T[]) => T[]] {
  const [sort, setSort] = useState<SortState>(initial)
  const onHeader = (id: string): void =>
    setSort((cur) => {
      if (cur.column === id) return { column: id, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
      const col = columns.find((c) => c.id === id)
      return { column: id, dir: id === initial.column ? (col?.defaultDir ?? initial.dir) : 'asc' }
    })
  const apply = useCallback(
    (rows: T[]): T[] => {
      const col = columns.find((c) => c.id === sort.column)
      if (!col) return rows
      const sorted = [...rows].sort(col.compare)
      return sort.dir === 'desc' ? sorted.reverse() : sorted
    },
    [columns, sort]
  )
  return [sort, onHeader, apply]
}

export function DirectoryTable<T>({
  columns,
  rows,
  rowKey,
  onOpen,
  sort,
  onSort,
  label,
  rowLabel,
  onRowDragStart
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey(row: T): string
  onOpen(row: T): void
  sort: SortState
  onSort(id: string): void
  label: string
  rowLabel(row: T): string
  /** Rows can be dragged (a folder's company row onto the sidebar favorites). */
  onRowDragStart?(row: T, e: DragEvent): void
}): JSX.Element {
  const template = useMemo(() => columns.map((c, i) => (i === 0 ? 'minmax(0, 1fr)' : 'auto')).join(' '), [columns])
  return (
    <div className="directory-table" role="table" aria-label={label} style={{ gridTemplateColumns: template }}>
      <div className="directory-table__row directory-table__row--head" role="row">
        {columns.map((c) => (
          <div key={c.id} role="columnheader" className={`directory-table__cell ${c.className ?? ''}`} aria-sort={sort.column === c.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
            <button type="button" className={`directory-table__sort${sort.column === c.id ? ' is-active' : ''}`} onClick={() => onSort(c.id)}>
              {c.label}
              {sort.column === c.id ? <span className="directory-table__arrow" aria-hidden="true">{sort.dir === 'asc' ? '↑' : '↓'}</span> : null}
            </button>
          </div>
        ))}
      </div>
      {rows.map((row) => (
        <div
          key={rowKey(row)}
          className="directory-table__row directory-table__row--link"
          role="row"
          tabIndex={0}
          aria-label={rowLabel(row)}
          draggable={onRowDragStart ? true : undefined}
          onDragStart={onRowDragStart ? (e) => onRowDragStart(row, e) : undefined}
          onClick={() => onOpen(row)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onOpen(row)
            }
          }}
        >
          {columns.map((c) => (
            <div key={c.id} role="cell" className={`directory-table__cell ${c.className ?? ''}`}>
              {c.cell(row)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function DirectoryEmpty({ icon, text }: { icon: ReactNode; text: string }): JSX.Element {
  return (
    <div className="directory-empty">
      <span className="directory-empty__icon" aria-hidden="true">
        {icon}
      </span>
      <p className="directory-empty__text">{text}</p>
    </div>
  )
}

export function DirectoryLoading({ label }: { label: string }): JSX.Element {
  return (
    <div className="directory-loading" aria-busy="true" aria-label={label}>
      <span>Loading…</span>
    </div>
  )
}
