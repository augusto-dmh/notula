// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { parseError, type ParsedError } from '@shared/errors'
import { NOTE_DRAG_MIME } from '@shared/types/folders'
import type { NoteListItem } from '@shared/types/notes'
import { IconCheck, IconClose, IconNote } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { debugLog, isOwnNote, NEW_NOTE_SHORTCUT } from '../../app/platform'
import { readViewState, saveViewState } from '../../app/scroll-memory'
import { SettingsButton, TopBar } from '../../app/TopBar'
import { NuxTip } from '../nux'
import { usePrefs } from '../settings/prefs-store'
import { UpcomingMeetings } from '../calendar'
import { useCaptureState } from '../capture'
import { FollowUpSuggestedIcon, SuggestedFollowUps, useSuggestedNoteIds } from '../follow-up'
import { NewNoteButton } from '../new-note'
import { NoticeCard } from '../speaker-profiles'
import { ActionMenu, type ActionMenuEntry } from '../note-page/ActionMenu'
import { IconOpen, IconTrash, trashNotes } from '../trash'
import { noteAttendeeLine } from './attendees'
import { formatTime, groupRows, isAllDay, type HomeRow } from './grouping'
import { publishHomeSelection } from './selection'
import './home.css'

/** First page ("recent"), then everything ("all") near the end. */
const FIRST_PAGE = 100
const LOAD_MORE_PX = 300
const HEADER_HEIGHT = 44
const ROW_HEIGHT = 60
const VIEW_KEY = 'home'

type Mode = 'recent' | 'all'

interface HomeViewState {
  scrollTop: number
  mode: Mode
}

type ListState =
  | { status: 'loading' }
  | { status: 'error'; error: ParsedError }
  | { status: 'ready'; items: NoteListItem[]; hasMore: boolean }

export function HomePage(): JSX.Element {
  const saved = useMemo(() => readViewState<HomeViewState>(VIEW_KEY), [])
  const [mode, setMode] = useState<Mode>(saved?.mode ?? 'recent')
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const prefs = usePrefs()
  const selfEmail = prefs?.['profile.email'] || undefined
  const genericDomains = prefs?.['people.genericEmailDomains']
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTop = useRef(saved?.scrollTop ?? 0)
  const restored = useRef(false)
  const request = useRef(0)
  const modeRef = useRef(mode)
  modeRef.current = mode

  const load = useCallback(async (m: Mode): Promise<void> => {
    const id = ++request.current
    try {
      const page = await window.notula.notes.list({ scope: 'own', ...(m === 'recent' ? { limit: FIRST_PAGE } : {}) })
      if (id !== request.current) return
      setList({ status: 'ready', items: page.items, hasMore: page.hasMore })
    } catch (err) {
      if (id !== request.current) return
      setList((prev) => (prev.status === 'ready' ? prev : { status: 'error', error: parseError(err) }))
      debugLog('home-list-failed', { err: parseError(err) })
    }
  }, [])

  useEffect(() => {
    debugLog('home-opened')
  }, [])

  useEffect(() => {
    void load(mode)
  }, [load, mode])

  // Refresh on store changes to notes or calendar events.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.notula.notes.onChanged((c) => {
      if (!c.tables.includes('documents') && !c.tables.includes('calendar_events')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(mode), 120)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [load, mode])

  // Save the scroll position when leaving home.
  useEffect(
    () => () => {
      saveViewState(VIEW_KEY, { scrollTop: scrollTop.current, mode: modeRef.current } satisfies HomeViewState)
    },
    []
  )
  const items = list.status === 'ready' ? list.items : []
  const hasMore = list.status === 'ready' && list.hasMore
  const rows = useMemo(() => groupRows(items), [items])
  const loadingMore = mode === 'all' && list.status === 'ready' && list.hasMore

  // ---------- multi-select and the row menu ----------

  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set())
  // The palette's "Move N notes to trash" reads it.
  useEffect(() => publishHomeSelection([...selection]), [selection])
  useEffect(() => () => publishHomeSelection([]), [])
  const [trashing, setTrashing] = useState(false)
  const [rowMenu, setRowMenu] = useState<{ item: NoteListItem; point: { x: number; y: number } } | null>(null)

  // Notes that left the list leave the selection.
  useEffect(() => {
    setSelection((prev) => {
      if (prev.size === 0) return prev
      const listed = new Set(items.map((i) => i.id))
      const next = new Set([...prev].filter((id) => listed.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [items])

  useEffect(() => {
    if (selection.size === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) setSelection(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection.size])

  const toggleSelected = useCallback((id: string): void => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const openRowMenu = useCallback((item: NoteListItem, point: { x: number; y: number }): void => {
    setRowMenu({ item, point })
  }, [])

  /** The selection bar always says "Notes moved to trash". */
  const trashSelection = async (): Promise<void> => {
    if (trashing) return
    setTrashing(true)
    try {
      await trashNotes([...selection], { alwaysPlural: true })
      setSelection(new Set())
    } finally {
      setTrashing(false)
    }
  }

  /**
   * "Move to trash" (danger, last). With a selection of the user's own notes it
   * trashes all of them and clears the selection; otherwise only this row.
   */
  const rowMenuEntries = (item: NoteListItem): ActionMenuEntry[] => {
    const selectedItems = items.filter((i) => selection.has(i.id))
    const bulk = selectedItems.length > 0 && selectedItems.every((i) => isOwnNote(i))
    const targets = bulk ? selectedItems.map((i) => i.id) : [item.id]
    const selected = selection.has(item.id)
    return [
      { kind: 'item', id: 'open', label: 'Open', icon: <IconOpen size={16} />, onSelect: () => openNote(item.id) },
      {
        kind: 'item',
        id: 'select',
        label: selected ? 'Deselect' : 'Select',
        icon: <IconCheck size={16} />,
        onSelect: () => toggleSelected(item.id)
      },
      { kind: 'divider', id: 'divider' },
      {
        kind: 'item',
        id: 'trash',
        label: targets.length > 1 ? `Move ${targets.length} notes to Trash` : 'Move to Trash',
        icon: <IconTrash size={16} />,
        danger: true,
        disabled: !bulk && !isOwnNote(item),
        onSelect: () => {
          void trashNotes(targets).then(() => {
            if (bulk) setSelection(new Set())
          })
        }
      }
    ]
  }

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    scrollTop.current = el.scrollTop
    if (mode === 'recent' && hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_PX) setMode('all')
  }

  const openNote = (id: string): void => {
    saveViewState(VIEW_KEY, { scrollTop: scrollTop.current, mode } satisfies HomeViewState)
    navigate(`/meeting/${encodeURIComponent(id)}?opened_from=homescreen_document`)
  }

  // Restore the scroll position once the list has rendered.
  useLayoutEffect(() => {
    if (restored.current || list.status !== 'ready') return
    restored.current = true
    const el = scrollRef.current
    if (el && scrollTop.current > 0) el.scrollTop = scrollTop.current
  }, [list.status])

  return (
    <div className="page home">
      <TopBar>
        <NewNoteButton />
        <SettingsButton />
      </TopBar>
      <div className="page__scroll home__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="home__column">
          {/* Speaker profiles: the one-time notice card. */}
          <NoticeCard />
          {/* The AI setup tip. */}
          <NuxTip id="ai-setup" />
          <UpcomingMeetings />
          {/* Drafts waiting for the user. */}
          <SuggestedFollowUps />
          {list.status === 'loading' ? (
            <ListSkeleton />
          ) : list.status === 'error' ? (
            <ListError error={list.error} onRetry={() => void load(mode)} />
          ) : items.length === 0 ? (
            <EmptyNotes />
          ) : (
            <NotesList
              rows={rows}
              scrollRef={scrollRef}
              selfEmail={selfEmail}
              genericDomains={genericDomains}
              selection={selection}
              onOpen={openNote}
              onToggle={toggleSelected}
              onContextMenu={openRowMenu}
            />
          )}
          {loadingMore ? (
            <div className="home__more" aria-label="Loading more notes">
              <span className="n-spinner" />
            </div>
          ) : null}
        </div>
      </div>
      {selection.size > 0 ? (
        <SelectionBar
          count={selection.size}
          busy={trashing}
          onTrash={() => void trashSelection()}
          onClear={() => setSelection(new Set())}
        />
      ) : null}
      {rowMenu ? (
        <ActionMenu
          label="Note"
          anchor={{ point: rowMenu.point }}
          entries={rowMenuEntries(rowMenu.item)}
          onClose={() => setRowMenu(null)}
        />
      ) : null}
    </div>
  )
}

/** The multi-select bar. */
function SelectionBar({
  count,
  busy,
  onTrash,
  onClear
}: {
  count: number
  busy: boolean
  onTrash(): void
  onClear(): void
}): JSX.Element {
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected notes">
      <span className="selection-bar__count">{count} selected</span>
      <button type="button" className="n-btn n-btn--sm selection-bar__trash" disabled={busy} onClick={onTrash}>
        <IconTrash size={15} />
        {count > 1 ? `Move ${count} notes to Trash` : 'Move to Trash'}
      </button>
      <span className="n-tooltip n-tooltip--end" data-tooltip="Clear selection">
        <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Clear selection" onClick={onClear}>
          <IconClose size={14} />
        </button>
      </span>
    </div>
  )
}

function NotesList({
  rows,
  scrollRef,
  selfEmail,
  genericDomains,
  selection,
  onOpen,
  onToggle,
  onContextMenu
}: {
  rows: HomeRow[]
  scrollRef: RefObject<HTMLDivElement | null>
  selfEmail: string | undefined
  genericDomains: readonly string[] | undefined
  selection: ReadonlySet<string>
  onOpen(id: string): void
  onToggle(id: string): void
  onContextMenu(item: NoteListItem, point: { x: number; y: number }): void
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const capture = useCaptureState()
  // Rows whose meeting has a ready follow-up draft show an envelope.
  const followUps = useSuggestedNoteIds()
  /** Dragging a selected row drags the whole selection of own notes. */
  const selectedOwn = useMemo(
    () => rows.flatMap((r) => (r.kind === 'note' && selection.has(r.item.id) && isOwnNote(r.item) ? [r.item.id] : [])),
    [rows, selection]
  )

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const measure = (): void => setOffset(el.offsetTop)
    measure()
    const ro = new ResizeObserver(measure)
    if (el.parentElement) ro.observe(el.parentElement)
    return () => ro.disconnect()
  }, [])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'header' ? HEADER_HEIGHT : ROW_HEIGHT),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 10,
    scrollMargin: offset
  })

  return (
    <div ref={listRef} className="notes-list" role="list" aria-label="Notes" style={{ height: virtualizer.getTotalSize() }}>
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
        const own = isOwnNote(row.item)
        const transcribing = capture.transcribingNoteId === row.item.id
        const selected = selection.has(row.item.id)
        const title = row.item.title || 'New note'
        const item = row.item
        return (
          <div
            key={v.key}
            className={`notes-list__slot${selected ? ' is-selected' : ''}${selection.size > 0 ? ' is-selecting' : ''}`}
            style={style}
            role="listitem"
            onContextMenu={(e) => {
              e.preventDefault()
              onContextMenu(item, { x: e.clientX, y: e.clientY })
            }}
          >
            {/* The hover checkbox over the icon. */}
            <label className="note-row__select">
              <input
                type="checkbox"
                className="note-row__checkbox"
                aria-label={`Select ${title}`}
                checked={selected}
                onChange={() => onToggle(item.id)}
              />
            </label>
            <button
              type="button"
              className="note-row"
              // Rows drag as NOTE_DRAG_MIME, so a sidebar folder can take them.
              draggable={own}
              onDragStart={(e) => {
                const ids = selected && selectedOwn.length > 0 ? selectedOwn : [item.id]
                e.dataTransfer.setData(NOTE_DRAG_MIME, JSON.stringify(ids))
                e.dataTransfer.setData('text/plain', ids.length > 1 ? `${ids.length} notes` : title)
                e.dataTransfer.effectAllowed = 'copyMove'
              }}
              onClick={() => onOpen(row.item.id)}
              onKeyDown={(e) => {
                if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                  e.preventDefault()
                  const r = e.currentTarget.getBoundingClientRect()
                  onContextMenu(item, { x: r.left + 48, y: r.bottom })
                }
              }}
            >
              <span className="note-row__icon" aria-hidden="true">
                <IconNote size={18} />
              </span>
              <span className="note-row__text">
                <span className={`note-row__title${row.item.title ? '' : ' is-untitled'}`}>{row.item.title || 'New note'}</span>
                <span className="note-row__meta">{noteAttendeeLine(row.item, own, selfEmail, genericDomains)}</span>
              </span>
              {followUps.has(item.id) ? <FollowUpSuggestedIcon /> : null}
              {transcribing ? (
                <span className="note-row__live">
                  <span className="note-row__live-dot" aria-hidden="true" />
                  Transcribing
                </span>
              ) : (
                <span className="note-row__time">{isAllDay(row.item) ? 'All day' : formatTime(row.time)}</span>
              )}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function ListSkeleton(): JSX.Element {
  return (
    <div className="notes-skeleton" aria-busy="true" aria-label="Loading notes">
      <div className="n-skeleton notes-skeleton__header" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="notes-skeleton__row">
          <div className="n-skeleton notes-skeleton__icon" />
          <div className="notes-skeleton__lines">
            <div className="n-skeleton notes-skeleton__title" style={{ width: `${62 - i * 7}%` }} />
            <div className="n-skeleton notes-skeleton__meta" />
          </div>
        </div>
      ))}
    </div>
  )
}

const SAMPLE_ROWS = [
  { title: 'Weekly product sync', meta: 'Ana, Ben & 4 others', time: '10:00 AM' },
  { title: 'Customer interview', meta: 'Priya Raman', time: '1:30 PM' },
  { title: 'Design review', meta: 'Leo & Mia', time: '3:00 PM' },
  { title: '1:1', meta: 'Sam Carter', time: '4:30 PM' }
]

/** Empty state: a faded sample list under the message. */
function EmptyNotes(): JSX.Element {
  return (
    <section className="notes-empty" aria-label="Notes">
      <div className="notes-empty__sample" aria-hidden="true">
        <div className="notes-list__header is-first notes-empty__header">Today</div>
        {SAMPLE_ROWS.map((r) => (
          <div key={r.title} className="note-row note-row--sample">
            <span className="note-row__icon">
              <IconNote size={18} />
            </span>
            <span className="note-row__text">
              <span className="note-row__title">{r.title}</span>
              <span className="note-row__meta">{r.meta}</span>
            </span>
            <span className="note-row__time">{r.time}</span>
          </div>
        ))}
      </div>
      <div className="notes-empty__message">
        <p className="notes-empty__title">Notes you take will be listed here</p>
        <p className="notes-empty__hint">
          Start one with <strong>New note</strong> or <kbd className="n-kbd">{NEW_NOTE_SHORTCUT}</kbd>
        </p>
      </div>
    </section>
  )
}

function ListError({ error, onRetry }: { error: ParsedError; onRetry(): void }): JSX.Element {
  const storage = error.code === 'storage-unavailable'
  return (
    <section className="notes-error" role="alert">
      <p className="notes-error__title">{storage ? 'Your notes aren’t available yet' : 'Couldn’t load your notes'}</p>
      <p className="notes-error__detail">
        {storage ? 'Notula is still opening its local storage.' : error.message || 'Something went wrong.'}
      </p>
      <button type="button" className="n-btn n-btn--sm" onClick={onRetry}>
        Try again
      </button>
    </section>
  )
}
