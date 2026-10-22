// SPDX-License-Identifier: Apache-2.0
// `/people`: everyone in the user's notes, with the date of the last note with them and
// how many notes they share. "Everyone" and "People I met" stay as two tabs (the
// multi-user seam), the same rows until notes can be shared. Search,
// sorting by any column, and the scroll position kept per list.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { PEOPLE_LIMITS, type PeopleFilter, type PersonRow } from '@shared/types/people'
import { navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { readViewState, saveViewState } from '../../app/scroll-memory'
import { Avatar } from '../calendar/Avatar'
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

export const PEOPLE_EMPTY = 'People you meet show up here as Notula takes notes.'

export function personColumns(): Column<PersonRow>[] {
  return [
    {
      id: 'person',
      label: 'Person',
      compare: (a, b) => a.name.localeCompare(b.name),
      cell: (p) => (
        <span className="directory-person">
          <Avatar name={p.name} email={p.email} size={32} />
          <span className="directory-person__text">
            <span className="directory-person__name">
              {p.name}
              {p.isSelf ? <span className="directory-person__me"> (me)</span> : null}
            </span>
            {p.name !== p.email ? <span className="directory-person__email">{p.email}</span> : null}
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
  const [tab, setTab] = useState<PeopleFilter>('all')
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
    () => sorted((rows ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))),
    [rows, q, sorted]
  )

  return (
    <div className="directory-page" ref={attach}>
      <div className="directory-page__column">
        <DirectoryHeader<PeopleFilter> title="People" tabs={TABS} tab={tab} onTab={setTab} query={query} onQuery={setQuery} searchLabel="Search people" />
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
                rowKey={(p) => p.email}
                onOpen={(p) => {
                  saveViewState(viewKey, scrollTop.current)
                  navigate(`/person/${encodeURIComponent(p.email)}`)
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
