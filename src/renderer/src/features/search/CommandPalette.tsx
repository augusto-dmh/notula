// SPDX-License-Identifier: Apache-2.0
// The command palette: a modal list
// labelled "Command palette" over the commands.ts registry, the local note search
// (`search:query`, latest wins), folders and people. Keyboard: the first item is highlighted;
// Up/Down and Ctrl+N/P move (a held key stops at the ends instead of wrapping); Enter
// runs; Tab asks Chat; Right Arrow opens a command's sub-list and Backspace, Left Arrow
// or "Back" leave it; Escape closes.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { parseError } from '@shared/errors'
import type { Participant } from '@shared/types/calendar'
import type { Folder } from '@shared/types/folders'
import type { CompanyRow } from '@shared/types/people'
import type { SearchResponse, SearchResult } from '@shared/types/search'
import { listCommands, type Command, type CommandGroup, type CommandItem } from '../../app/commands'
import { IconNote, IconSearch, IconSparkle } from '../../app/icons'
import { currentRoute, navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { askChat } from '../chat'
import { CompanyLogo } from '../companies/CompanyLogo'
import { FolderGlyph, folderTitle, IconArrowLeft, IconChevronRight, useFolders } from '../folders'
import { usePrefs } from '../settings/prefs-store'
import { bestStrength, displayQuery, Highlight, matchStrength, parseQuery, STRENGTH_RANK, type ParsedQuery, type Strength } from './match'
import { setStoredSearch } from './store'
import './search.css'

const NOTES_PER_GROUP = 4
const ENTITIES_WITH_QUERY = 4
const ENTITIES_WITHOUT_QUERY = 3

type Row =
  | { kind: 'search'; key: string; count: number }
  | { kind: 'command'; key: string; command: Command }
  | { kind: 'note'; key: string; result: SearchResult }
  | { kind: 'folder'; key: string; folder: Folder }
  | { kind: 'person'; key: string; person: Participant }
  /** A company from the people in the user's notes. */
  | { kind: 'company'; key: string; company: CompanyRow }
  | { kind: 'ask'; key: string }
  | { kind: 'item'; key: string; item: CommandItem }

interface Section {
  key: string
  heading?: string
  rows: Row[]
}

/** Fixed group order after the Search row, promoted and contextual sections. */
const ORDER: readonly CommandGroup[] = [
  'general',
  'meetings',
  'companies',
  'folders',
  'people',
  'navigation',
  'more-results',
  'selected-notes',
  'actions',
  'settings',
  'workspace',
  'account',
  'internal'
]

const HEADINGS: Partial<Record<CommandGroup, string>> = {
  meetings: 'Meetings',
  companies: 'Companies',
  folders: 'Folders',
  people: 'People',
  navigation: 'Navigation',
  'more-results': 'More results',
  'selected-notes': 'Selected notes',
  settings: 'Settings',
  workspace: 'Workspace',
  account: 'Account',
  internal: 'Internal'
}

// ---------- note search: every change of the trimmed query, latest wins ----------

interface SearchState {
  query: string
  response: SearchResponse | null
  error: boolean
}

function useNoteSearch(text: string): [SearchState, (q: string) => Promise<SearchResponse | null>] {
  const [state, setState] = useState<SearchState>({ query: '', response: null, error: false })
  const latest = useRef('')
  const inflight = useRef<{ query: string; promise: Promise<SearchResponse> } | null>(null)

  useEffect(() => {
    latest.current = text
    if (!text) {
      inflight.current = null
      setState({ query: '', response: null, error: false })
      return
    }
    const promise = window.notula.search.query({ query: text })
    inflight.current = { query: text, promise }
    promise
      .then((response) => {
        if (latest.current === text) setState({ query: text, response, error: false })
      })
      .catch((err: unknown) => {
        if (latest.current !== text) return
        setState({ query: text, response: null, error: true })
        debugLog('palette-search-failed', { queryLength: text.length, error: parseError(err).code })
      })
  }, [text])

  // The Search row waits for the current results.
  const resultsFor = useCallback(
    async (q: string): Promise<SearchResponse | null> => {
      if (state.query === q && state.response) return state.response
      const pending = inflight.current?.query === q ? inflight.current.promise : window.notula.search.query({ query: q })
      try {
        return await pending
      } catch {
        return null
      }
    },
    [state]
  )
  return [state, resultsFor]
}

// ---------- people (`people:participants`): empty until the handler exists ----------

let peopleUnavailable = false

function usePeople(text: string, noteId: string | null): Participant[] {
  const [people, setPeople] = useState<Participant[]>([])
  useEffect(() => {
    if (peopleUnavailable) return
    let live = true
    window.notula.people
      .participants({ query: text, ...(noteId ? { noteId } : {}) })
      .then((list) => live && setPeople(list))
      .catch((err: unknown) => {
        // Until main registers `people:participants` every call is refused; stop asking for this session.
        if (String(err).includes('No handler registered')) peopleUnavailable = true
        if (live) setPeople([])
      })
    return () => {
      live = false
    }
  }, [text, noteId])
  return people
}

// ---------- companies (`companies:list`) ----------

function useCompanies(text: string): CompanyRow[] {
  const [companies, setCompanies] = useState<CompanyRow[]>([])
  useEffect(() => {
    let live = true
    window.notula.companies
      .list({ filter: 'all', ...(text ? { query: text } : {}) })
      .then((list) => live && setCompanies(list))
      .catch(() => live && setCompanies([]))
    return () => {
      live = false
    }
  }, [text])
  return companies
}

// ---------- the palette ----------

export function CommandPalette({ initialQuery, onClose }: { initialQuery: string; onClose(): void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState(initialQuery)
  const [sub, setSub] = useState<Command | null>(null)
  const [commands] = useState(() => listCommands())
  const [active, setActive] = useState(0)
  const [armed, setArmed] = useState<string | null>(null)
  const submitSeq = useRef(0)
  const folders = useFolders()
  const prefs = usePrefs()

  const route = currentRoute()
  const noteId = route.path.startsWith('/meeting/') ? (route.params['id'] ?? null) : null
  const q = useMemo(() => parseQuery(query), [query])
  const rootText = sub ? '' : q.text
  const [search, resultsFor] = useNoteSearch(rootText)
  const people = usePeople(sub ? '' : q.text, noteId)
  const companies = useCompanies(sub ? '' : q.text)
  const selfEmail = (prefs?.['profile.email'] ?? '').trim().toLowerCase()

  // The sub-list's items, read once when it opens.
  const subItems = useMemo(() => (sub?.subList ? sub.subList.items() : []), [sub])

  const sections = useMemo<Section[]>(() => {
    if (sub) {
      const rows: Row[] = subItems
        .map((item, i) => ({ item, i, s: bestStrength([item.label, ...(item.keywords ?? [])], q) }))
        .filter((x): x is { item: CommandItem; i: number; s: Strength } => x.s !== null)
        .sort((a, b) => STRENGTH_RANK[a.s] - STRENGTH_RANK[b.s] || a.i - b.i)
        .map((x) => ({ kind: 'item', key: `item:${x.item.id}`, item: x.item }))
      return rows.length ? [{ key: 'sub', rows }] : []
    }
    return buildSections(q, commands, search, folders?.folders ?? [], people, selfEmail, companies)
  }, [sub, subItems, q, commands, search, folders, people, selfEmail, companies])

  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections])
  const enabledAt = useCallback((i: number) => rowEnabled(rows[i]), [rows])
  const rowsKey = rows.map((r) => r.key).join('|')

  // The first item is always highlighted.
  useLayoutEffect(() => {
    let first = 0
    while (first < rows.length && !enabledAt(first)) first++
    setActive(first < rows.length ? first : 0)
    setArmed(null)
  }, [rowsKey])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Open as a modal; focus returns to where it was on close.
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => {
      if (dialog.open) dialog.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const move = (delta: 1 | -1, held: boolean): void => {
    if (rows.length === 0) return
    let i = active
    for (let step = 0; step < rows.length; step++) {
      let next = i + delta
      if (next < 0 || next >= rows.length) {
        // A held key stops at the ends; a single press wraps.
        if (held) return
        next = next < 0 ? rows.length - 1 : 0
      }
      i = next
      if (enabledAt(i)) break
    }
    if (i !== active && enabledAt(i)) {
      setActive(i)
      setArmed(null)
    }
  }

  const openSub = (command: Command): void => {
    setSub(command)
    setQuery('')
    setArmed(null)
    inputRef.current?.focus()
  }

  const leaveSub = (): void => {
    setSub(null)
    setQuery('')
    inputRef.current?.focus()
  }

  const submitSearch = async (): Promise<void> => {
    const text = q.text
    if (!text) return
    const seq = ++submitSeq.current
    const res = await resultsFor(text)
    if (seq !== submitSeq.current) return
    const results = res?.results ?? []
    const snippets: Record<string, string> = {}
    const matchTypes: Record<string, SearchResult['matchType']> = {}
    for (const r of results) {
      snippets[r.id] = r.snippet || r.title || 'New note'
      matchTypes[r.id] = r.matchType
    }
    // "All notes" is the default and the only value while every note is the user's.
    setStoredSearch(
      { type: 'freeform', query: text, ids: results.map((r) => r.id), snippets, matchTypes, term: q.term, submittedAt: Date.now() },
      'all'
    )
    debugLog('search-submitted', { queryLength: text.length, resultCount: results.length })
    onClose()
    navigate('/search', { replace: currentRoute().path === '/search' })
  }

  const run = async (index: number): Promise<void> => {
    const row = rows[index]
    if (!row || !rowEnabled(row)) return
    switch (row.kind) {
      case 'search':
        await submitSearch()
        return
      case 'note':
        onClose()
        navigate(`/meeting/${encodeURIComponent(row.result.id)}?opened_from=palette`)
        return
      case 'folder':
        onClose()
        navigate(`/list/${encodeURIComponent(row.folder.id)}`)
        return
      case 'person':
        onClose()
        navigate(`/person/${encodeURIComponent(row.person.email)}`)
        return
      case 'company':
        onClose()
        navigate(`/company/${encodeURIComponent(row.company.domain)}`)
        return
      case 'ask':
        onClose()
        askChat({ text: q.text, noteId })
        return
      case 'item':
        onClose()
        await row.item.run()
        return
      case 'command': {
        const c = row.command
        if (c.subList) {
          openSub(c)
          return
        }
        // The first Enter arms, the second runs.
        if (c.confirm && armed !== c.id) {
          setArmed(c.id)
          return
        }
        onClose()
        await c.run?.()
      }
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const input = inputRef.current
    const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    if (e.key === 'ArrowDown' || (ctrlOnly && e.key.toLowerCase() === 'n')) {
      e.preventDefault()
      e.stopPropagation()
      move(1, e.repeat)
    } else if (e.key === 'ArrowUp' || (ctrlOnly && e.key.toLowerCase() === 'p')) {
      e.preventDefault()
      e.stopPropagation()
      move(-1, e.repeat)
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void run(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab' && !e.shiftKey && !sub && q.text) {
      // Tab hands the query to chat.
      e.preventDefault()
      onClose()
      askChat({ text: q.text, noteId })
    } else if (e.key === 'ArrowRight' && input && document.activeElement === input) {
      const row = rows[active]
      if (!sub && row?.kind === 'command' && row.command.subList && rowEnabled(row) && input.selectionStart === input.value.length) {
        e.preventDefault()
        openSub(row.command)
      }
    } else if (sub && input && document.activeElement === input) {
      if ((e.key === 'Backspace' && input.value === '') || (e.key === 'ArrowLeft' && input.selectionStart === 0 && input.selectionEnd === 0)) {
        e.preventDefault()
        leaveSub()
      }
    }
  }

  let index = -1
  return (
    <dialog
      ref={dialogRef}
      className="palette"
      aria-label="Command palette"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return
        const r = e.currentTarget.getBoundingClientRect()
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose()
      }}
      onKeyDown={onKeyDown}
    >
      <div className="palette__field">
        {sub ? (
          <button type="button" className="palette__back" onClick={leaveSub}>
            <IconArrowLeft size={14} />
            Back
          </button>
        ) : (
          <span className="palette__field-icon" aria-hidden="true">
            <IconSearch size={17} />
          </span>
        )}
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          placeholder={sub?.subList?.placeholder ?? 'Search notes or jump to a command'}
          aria-label={sub?.subList?.placeholder ?? 'Command palette'}
          aria-controls="palette-list"
          aria-activedescendant={rows[active] ? `palette-row-${active}` : undefined}
          role="combobox"
          aria-expanded="true"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        {!sub && q.text ? (
          <span className="palette__chat-hint" aria-hidden="true">
            Chat <kbd className="n-kbd">Tab</kbd>
          </span>
        ) : null}
        {!sub && q.text ? <span className="visually-hidden">Press Tab to send this as a chat question</span> : null}
      </div>
      <div ref={listRef} id="palette-list" className="palette__list" role="listbox" aria-label={sub ? sub.label : 'Results'}>
        {rows.length === 0 ? (
          <p className="palette__empty">No matches</p>
        ) : (
          sections.map((section) => (
            <div key={section.key} className="palette__section" role="group" aria-label={section.heading}>
              {section.heading ? <div className="palette__heading">{section.heading}</div> : null}
              {section.rows.map((row) => {
                index++
                const i = index
                const enabled = rowEnabled(row)
                return (
                  <div
                    key={row.key}
                    id={`palette-row-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={i === active}
                    aria-disabled={!enabled || undefined}
                    className={`palette__row${i === active ? ' is-active' : ''}${enabled ? '' : ' is-disabled'}`}
                    onMouseMove={() => {
                      if (i !== active && enabled) {
                        setActive(i)
                        setArmed(null)
                      }
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void run(i)}
                  >
                    <RowContent row={row} q={q} armed={row.kind === 'command' && armed === row.command.id} />
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </dialog>
  )
}

function rowEnabled(row: Row | undefined): boolean {
  return !!row && !(row.kind === 'command' && row.command.enabled === false)
}

function noteTimeShort(seconds: number, now = new Date()): string {
  const d = new Date(seconds * 1000)
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  // "HH:MM" (24-hour) today, else the short month and day.
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function initials(p: Participant): string {
  const base = p.name.trim() || p.email
  const parts = base.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}

function RowContent({ row, q, armed }: { row: Row; q: ParsedQuery; armed: boolean }): JSX.Element {
  switch (row.kind) {
    case 'search':
      return (
        <>
          <span className="palette__icon" aria-hidden="true">
            <IconSearch size={16} />
          </span>
          <span className="palette__label">
            Search <span className="palette__query">{displayQuery(q)}</span>
          </span>
          {row.count > 0 ? <span className="palette__meta">{row.count === 1 ? '1 result' : `${row.count} results`}</span> : null}
        </>
      )
    case 'ask':
      return (
        <>
          <span className="palette__icon" aria-hidden="true">
            <IconSparkle size={16} />
          </span>
          <span className="palette__label">
            Ask in chat <span className="palette__query">{q.text}</span>
          </span>
        </>
      )
    case 'note':
      return (
        <>
          <span className="palette__icon" aria-hidden="true">
            <IconNote size={16} />
          </span>
          <span className="palette__text">
            <span className={`palette__label${row.result.title ? '' : ' is-untitled'}`}>
              <Highlight text={row.result.title || 'New note'} term={q.term} />
            </span>
            {row.result.snippet ? (
              <span className="palette__snippet">
                <Highlight text={row.result.snippet} term={q.term} />
              </span>
            ) : null}
          </span>
          <span className="palette__meta">{noteTimeShort(row.result.sort_epoch)}</span>
        </>
      )
    case 'folder':
      return (
        <>
          <span className="palette__icon" aria-hidden="true">
            <FolderGlyph icon={row.folder.icon} size={16} />
          </span>
          <span className="palette__label">
            <Highlight text={folderTitle(row.folder)} term={q.term} />
          </span>
        </>
      )
    case 'person':
      return (
        <>
          <span className="palette__avatar" aria-hidden="true">
            {initials(row.person)}
          </span>
          <span className="palette__text">
            <span className="palette__label">
              <Highlight text={row.person.name || row.person.email} term={q.term} />
            </span>
            {row.person.name ? (
              <span className="palette__snippet">
                <Highlight text={row.person.email} term={q.term} />
              </span>
            ) : null}
          </span>
        </>
      )
    case 'company':
      return (
        <>
          <span className="palette__icon" aria-hidden="true">
            <CompanyLogo domain={row.company.domain} name={row.company.name} size={16} />
          </span>
          <span className="palette__text">
            <span className="palette__label">
              <Highlight text={row.company.name} term={q.term} />
            </span>
            <span className="palette__snippet">
              <Highlight text={row.company.domain} term={q.term} />
            </span>
          </span>
        </>
      )
    case 'item':
      return (
        <>
          <span className="palette__icon" aria-hidden="true">
            {row.item.icon ?? null}
          </span>
          <span className="palette__label">
            <Highlight text={row.item.label} term={q.term} />
          </span>
        </>
      )
    case 'command': {
      const c = row.command
      return (
        <>
          <span className="palette__label">
            <Highlight text={c.label} term={q.term} />
          </span>
          {armed && c.confirm ? (
            <span className="palette__confirm">
              <span className="palette__confirm-hint">{c.confirm.hint}</span>
              <span className="palette__confirm-key">Confirm ↵</span>
            </span>
          ) : c.subList ? (
            <span className="palette__meta" aria-hidden="true">
              <IconChevronRight size={14} />
            </span>
          ) : null}
        </>
      )
    }
  }
}

function buildSections(
  q: ParsedQuery,
  commands: Command[],
  search: SearchState,
  folders: Folder[],
  people: Participant[],
  selfEmail: string,
  companies: CompanyRow[] = []
): Section[] {
  const has = q.text.length > 0
  const sections: Section[] = []
  const current = has && search.query === q.text
  const results = current ? (search.response?.results ?? []) : []

  // Hidden when the query is a known participant's email (not the user's own).
  const isParticipantEmail = has && q.lower !== selfEmail && people.some((p) => p.email.toLowerCase() === q.lower)
  if (has && !isParticipantEmail) sections.push({ key: 'search', rows: [{ kind: 'search', key: 'search', count: results.length }] })

  const matched = commands
    .map((command, i) => ({ command, i, s: bestStrength([command.label, ...(command.keywords ?? [])], q) }))
    .filter((x): x is { command: Command; i: number; s: Strength } => x.s !== null)
    .sort((a, b) => STRENGTH_RANK[a.s] - STRENGTH_RANK[b.s] || a.i - b.i)
  const promoted = has ? matched.filter((x) => x.command.label.trim().toLowerCase() === q.lower) : []
  const isPromoted = new Set(promoted.map((x) => x.command.id))
  const commandRows = (list: typeof matched): Row[] => list.map((x) => ({ kind: 'command', key: `cmd:${x.command.id}`, command: x.command }))

  if (promoted.length) sections.push({ key: 'promoted', rows: commandRows(promoted) })
  const contextual = matched.filter((x) => x.command.contextual && !isPromoted.has(x.command.id))
  if (contextual.length) sections.push({ key: 'contextual', rows: commandRows(contextual) })
  const rest = matched.filter((x) => !x.command.contextual && !isPromoted.has(x.command.id))

  const limit = has ? ENTITIES_WITH_QUERY : ENTITIES_WITHOUT_QUERY
  for (const group of ORDER) {
    let rows: Row[] = []
    if (group === 'meetings' || group === 'more-results') {
      rows = results
        .filter((r) => (group === 'meetings' ? r.matchType === 'title' : r.matchType !== 'title'))
        .slice(0, NOTES_PER_GROUP)
        .map((r) => ({ kind: 'note', key: `note:${group}:${r.id}`, result: r }))
    } else if (group === 'folders') {
      rows = folders
        .map((folder) => ({ folder, s: matchStrength(folderTitle(folder), q) }))
        .filter((x): x is { folder: Folder; s: Strength } => x.s !== null)
        .sort(
          (a, b) =>
            STRENGTH_RANK[a.s] - STRENGTH_RANK[b.s] ||
            Number(b.folder.is_favourite) - Number(a.folder.is_favourite) ||
            b.folder.updated_at.localeCompare(a.folder.updated_at)
        )
        .slice(0, limit)
        .map((x) => ({ kind: 'folder', key: `folder:${x.folder.id}`, folder: x.folder }))
    } else if (group === 'people') {
      rows = people
        .map((person, i) => ({ person, i, s: has ? bestStrength([person.name, person.email], q) : ('partial' as Strength) }))
        .filter((x): x is { person: Participant; i: number; s: Strength } => x.s !== null)
        .sort((a, b) => STRENGTH_RANK[a.s] - STRENGTH_RANK[b.s] || a.i - b.i)
        .slice(0, limit)
        .map((x) => ({ kind: 'person', key: `person:${x.person.email}`, person: x.person }))
    } else if (group === 'companies') {
      rows = companies
        .map((company, i) => ({ company, i, s: has ? bestStrength([company.name, company.domain], q) : ('partial' as Strength) }))
        .filter((x): x is { company: CompanyRow; i: number; s: Strength } => x.s !== null)
        .sort((a, b) => STRENGTH_RANK[a.s] - STRENGTH_RANK[b.s] || a.i - b.i)
        .slice(0, limit)
        .map((x) => ({ kind: 'company', key: `company:${x.company.domain}`, company: x.company }))
    }
    rows.push(...commandRows(rest.filter((x) => x.command.group === group)))
    if (rows.length) sections.push({ key: group, ...(HEADINGS[group] ? { heading: HEADINGS[group] } : {}), rows })
  }

  // "Ask Chat <query>" once the search finished without error and found nothing.
  if (has && current && !search.error && search.response && results.length === 0) {
    sections.push({ key: 'ask', rows: [{ kind: 'ask', key: 'ask' }] })
  }
  return sections
}
