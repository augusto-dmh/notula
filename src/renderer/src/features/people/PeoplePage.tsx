// SPDX-License-Identifier: Apache-2.0
// `/people`: everyone in the user's notes, with the date of the last note with them and
// how many notes they share. "Everyone" and "People I met" stay as two tabs (the
// multi-user seam), the same rows until notes can be shared. Search,
// sorting by any column, and the scroll position kept per list. "With a voice" (speaker
// profiles, `PeopleFilter` `voice`) shows while a voice row is on, or when Settings opens
// `/people?filter=voice`. A speaker person without an email has a letter avatar and opens
// `/person/p:<personId>`.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { personRouteKey } from '@shared/lib/people'
import { PEOPLE_LIMITS, type PeopleFilter, type PersonRow } from '@shared/types/people'
import { navigate, useRoute } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { readViewState, saveViewState } from '../../app/scroll-memory'
import { Avatar } from '../calendar/Avatar'
import { usePrefs } from '../settings/prefs-store'
import { peopleTabVoice, peopleVoiceBadge } from '../speaker-profiles/strings'
import {
  DirectoryEmpty,
  DirectoryHeader,
  DirectoryLoading,
  DirectoryTable,
  relativeDay,
  usePeopleChanged,
  useScrollContainer,
  useSort,
  type Column
} from './directory'
import { IconPeopleLarge } from './icons'

const TABS = [
  { value: 'all', label: 'Everyone' },
  { value: 'met', label: 'People you’ve met' }
] as const satisfies readonly { value: PeopleFilter; label: string }[]

const TABS_WITH_VOICE = [...TABS, { value: 'voice', label: peopleTabVoice() }] as const satisfies readonly { value: PeopleFilter; label: string }[]

function IconVoice(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />
    </svg>
  )
}

export const PEOPLE_EMPTY = 'People you meet show up here as Notula takes notes.'

export function personColumns(): Column<PersonRow>[] {
  return [
    {
      id: 'person',
      label: 'Person',
      compare: (a, b) => a.name.localeCompare(b.name),
      cell: (p) => (
        <span className="directory-person">
          <Avatar name={p.name} email={p.email ?? null} size={32} />
          <span className="directory-person__text">
            <span className="directory-person__name">
              {p.name}
              {p.isSelf ? <span className="directory-person__me"> (me)</span> : null}
              {p.hasVoice ? (
                <span className="directory-person__voice" title={peopleVoiceBadge()} aria-label={peopleVoiceBadge()} role="img">
                  <IconVoice />
                </span>
              ) : null}
            </span>
            {p.email && p.name !== p.email ? <span className="directory-person__email">{p.email}</span> : null}
          </span>
        </span>
      )
    },
    {
      id: 'last',
      label: 'Last note',
      compare: (a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt),
      cell: (p) => <span className="directory-table__muted">{relativeDay(p.lastSeenAt)}</span>,
      defaultDir: 'desc',
      className: 'directory-table__cell--date'
    },
    {
      id: 'notes',
      label: 'Notes',
      compare: (a, b) => a.count - b.count,
      cell: (p) => <span className="directory-table__num">{p.count}</span>,
      className: 'directory-table__cell--num'
    }
  ]
}

export function PeoplePageView(): JSX.Element {
  const { query: routeQuery } = useRoute()
  const prefs = usePrefs()
  const [tab, setTab] = useState<PeopleFilter>(() => (routeQuery.get('filter') === 'voice' ? 'voice' : 'all'))
  const voiceTab = tab === 'voice' || !!prefs?.['speakers.voices'] || !!prefs?.['speakers.selfVoice']
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<PersonRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attach, scrollEl] = useScrollContainer()
  const columns = useMemo(personColumns, [])
  const [sort, onSort, sorted] = useSort(columns, { column: 'last', dir: 'desc' })
  const viewKey = `people:${tab}`
  const scrollTop = useRef(readViewState<number>(viewKey) ?? 0)
  const restored = useRef(false)

  const load = (): void => {
    window.notula.people
      .list({ filter: tab })
      .then((list) => {
        setRows(list)
        setFailed(false)
      })
      .catch((err: unknown) => {
        debugLog('people:list-failed', { err: String(err) })
        setFailed(true)
      })
  }
  useEffect(load, [tab])
  usePeopleChanged(load)
  useEffect(() => debugLog('people-page-opened'), [])

  // The scroll position, kept per list.
  useEffect(() => {
    if (!scrollEl) return
    const onScroll = (): void => {
      scrollTop.current = scrollEl.scrollTop
    }
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      saveViewState(viewKey, scrollTop.current)
    }
  }, [scrollEl, viewKey])
  useLayoutEffect(() => {
    if (restored.current || !rows || !scrollEl) return
    restored.current = true
    if (scrollTop.current > 0) scrollEl.scrollTop = scrollTop.current
  }, [rows, scrollEl])

  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () => sorted((rows ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || (p.email ?? '').toLowerCase().includes(q))),
    [rows, q, sorted]
  )

  return (
    <div className="directory-page" ref={attach}>
      <div className="directory-page__column">
        <DirectoryHeader<PeopleFilter> title="People" tabs={voiceTab ? TABS_WITH_VOICE : TABS} tab={tab} onTab={setTab} query={query} onQuery={setQuery} searchLabel="Search people" />
        {rows === null ? (
          failed ? (
            <p className="directory-error" role="alert">
              Couldn’t load people
            </p>
          ) : (
            <DirectoryLoading label="Loading people" />
          )
        ) : visible.length === 0 && q ? (
          <p className="directory-none">No people match “{query.trim()}”</p>
        ) : (
          <>
            {visible.length ? (
              <DirectoryTable
                columns={columns}
                rows={visible}
                rowKey={(p) => personRouteKey(p)}
                onOpen={(p) => {
                  saveViewState(viewKey, scrollTop.current)
                  navigate(`/person/${encodeURIComponent(personRouteKey(p))}`)
                }}
                sort={sort}
                onSort={onSort}
                label="People"
                rowLabel={(p) => p.name}
              />
            ) : null}
            {/* The empty block, also under a short list. */}
            {!q && visible.length <= PEOPLE_LIMITS.smallListRows ? <DirectoryEmpty icon={<IconPeopleLarge size={22} />} text={PEOPLE_EMPTY} /> : null}
          </>
        )}
      </div>
    </div>
  )
}
