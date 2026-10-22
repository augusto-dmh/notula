// SPDX-License-Identifier: Apache-2.0
// The `/search` page: `Results for "<query>"` (or
// "Search results"), the list-header chat input, then the stored result ids through
// `notes:list { ids }`: the listable scope, per-event dedupe and display-time order,
// under day headers (the palette's own-first order is not kept). Each row is home's
// row plus the stored snippet with the term highlighted. The query shows in a compact
// header after 48 px. Empty: "No meetings found" and "Clear search" (Esc).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { NoteListItem } from '@shared/types/notes'
import { IconSearch } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { debugLog, isOwnNote, isTextTarget } from '../../app/platform'
import { readViewState, saveViewState } from '../../app/scroll-memory'
import { ListChatInput } from '../chat'
import { anotherModalOpen, NoteList } from '../folders'
import { Highlight } from './match'
import { setSearchScope, useSearchScope, useStoredSearch, type StoredSearch } from './store'
import './search.css'

const COMPACT_AFTER_PX = 48

type ListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: NoteListItem[] }

function clearSearch(): void {
  if (window.history.length > 1) window.history.back()
  else navigate('/')
}

export function SearchPageView(): JSX.Element {
  const stored = useStoredSearch()
  const scope = useSearchScope()
  const [list, setList] = useState<ListState>({ status: 'idle' })
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const [compact, setCompact] = useState(false)
  const scrollTop = useRef(0)
  const restoredFor = useRef<string | null>(null)
  const request = useRef(0)
  const attach = useCallback((el: HTMLElement | null) => {
    setScrollEl((el?.closest('.page__scroll') as HTMLElement | null) ?? null)
  }, [])

  // Scroll memory per search type, query and switch value.
  const memoryKey = stored ? `search:${stored.type}:${stored.query}:${scope}` : null

  const load = useCallback(
    async (s: StoredSearch | null, ownOnly: boolean): Promise<void> => {
      const req = ++request.current
      if (!s) {
        setList({ status: 'idle' })
        return
      }
      if (s.ids.length === 0) {
        setList({ status: 'ready', items: [] })
        return
      }
      setList((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }))
      try {
        const page = await window.notula.notes.list({ scope: 'own', ids: s.ids, ...(ownOnly ? { ownOnly: true } : {}) })
        if (req === request.current) setList({ status: 'ready', items: page.items })
      } catch (err) {
        if (req === request.current) setList({ status: 'error', message: parseError(err).message })
      }
    },
    []
  )

  useEffect(() => {
    void load(stored, scope === 'mine')
  }, [load, stored, scope])

  // The page keeps refreshing on note changes.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.notula.notes.onChanged((c) => {
      if (!c.tables.includes('documents') && !c.tables.includes('calendar_events')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(stored, scope === 'mine'), 150)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [load, stored, scope])

  useEffect(() => {
    if (stored) debugLog('search-page-opened', { queryLength: stored.query.length, type: stored.type, count: stored.ids.length })
  }, [stored])

  useEffect(() => () => debugLog('search-page-closed'), [])

  useEffect(() => {
    if (!scrollEl) return
    const onScroll = (): void => {
      scrollTop.current = scrollEl.scrollTop
      setCompact(scrollEl.scrollTop > COMPACT_AFTER_PX)
    }
    onScroll()
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollEl.removeEventListener('scroll', onScroll)
  }, [scrollEl])

  // Restore this search's scroll position once its rows render; a new search starts at the top.
  useLayoutEffect(() => {
    if (!scrollEl || !memoryKey || list.status !== 'ready' || restoredFor.current === memoryKey) return
    restoredFor.current = memoryKey
    scrollEl.scrollTop = readViewState<number>(memoryKey) ?? 0
  }, [scrollEl, memoryKey, list.status])

  useEffect(
    () => () => {
      if (memoryKey) saveViewState(memoryKey, scrollTop.current)
    },
    [memoryKey]
  )

  const empty = !!stored && list.status === 'ready' && list.items.length === 0

  // Escape clears the search on the empty state too.
  useEffect(() => {
    if (!empty) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || anotherModalOpen() || isTextTarget(e.target)) return
      e.preventDefault()
      clearSearch()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [empty])

  const openNote = (id: string): void => {
    if (memoryKey) saveViewState(memoryKey, scrollTop.current)
    debugLog('search-result-opened', { id, queryLength: stored?.query.length ?? 0, type: stored?.type, source: 'search_page' })
    navigate(`/meeting/${encodeURIComponent(id)}?opened_from=search_page`)
  }

  const items = list.status === 'ready' ? list.items : []
  // The switch shows only once a result is not the user's own (not possible yet).
  const showSwitch = items.some((i) => !isOwnNote(i))
  const title = stored?.query ? `Results for "${stored.query}"` : 'Search results'

  return (
    <div className="search-page" ref={attach}>
      <div className={`search-bar${compact ? ' is-compact' : ''}`} aria-hidden={!compact}>
        <IconSearch size={14} />
        <span className="search-bar__query">{stored?.query || 'Search'}</span>
      </div>
      <div className="search-page__column">
        <h1 className="search-page__title">{title}</h1>
        {stored ? (
          <div className="search-page__chat">
            <ListChatInput place={{ kind: 'search', query: stored.query, type: 'freeform', documentIds: stored.ids }} />
          </div>
        ) : null}
        <hr className="search-page__rule" />
        {stored ? (
          <>
            {showSwitch ? (
              <div className="search-switch" role="radiogroup" aria-label="Notes">
                {(['all', 'mine'] as const).map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={scope === v} className="search-switch__option" onClick={() => setSearchScope(v)}>
                    {v === 'all' ? 'All notes' : 'My notes'}
                  </button>
                ))}
              </div>
            ) : null}
            {list.status === 'loading' ? (
              <div className="search-page__loading" aria-busy="true" aria-label="Loading results">
                <span className="n-spinner" />
              </div>
            ) : list.status === 'error' ? (
              <p className="search-page__error" role="alert">
                {list.message || 'Couldn’t load the results'}
              </p>
            ) : empty ? (
              <div className="search-empty">
                <span className="search-empty__icon" aria-hidden="true">
                  <IconSearch size={22} />
                </span>
                <p className="search-empty__title">No meetings found</p>
                <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={clearSearch}>
                  Clear search <kbd className="n-kbd">Esc</kbd>
                </button>
              </div>
            ) : (
              <NoteList
                items={items}
                scrollEl={scrollEl}
                label="Search results"
                onOpen={openNote}
                extraLine={(item) => {
                  // Only when both a snippet and a term exist.
                  const snippet = stored.snippets[item.id]
                  return snippet && stored.term ? <Highlight text={snippet} term={stored.term} /> : null
                }}
              />
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
