// SPDX-License-Identifier: Apache-2.0
// `/companies`: one row per email domain of the people in the user's notes (webmail
// domains left out), with the logo, the name and domain, the last note and the note
// count. "All companies" / "Companies I met" stay as two tabs, so a future multi-user
// build can tell them apart.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { PEOPLE_LIMITS, type CompanyRow, type PeopleFilter } from '@shared/types/people'
import { navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { readViewState, saveViewState } from '../../app/scroll-memory'
import {
  DirectoryEmpty,
  DirectoryHeader,
  DirectoryLoading,
  DirectoryTable,
  IconBuilding,
  relativeDay,
  usePeopleChanged,
  useScrollContainer,
  useSort,
  type Column
} from '../people'
import { CompanyLogo } from './CompanyLogo'

const TABS = [
  { value: 'all', label: 'All companies' },
  { value: 'met', label: 'Companies you’ve met' }
] as const satisfies readonly { value: PeopleFilter; label: string }[]

export const COMPANIES_EMPTY = 'Companies show up here as Notula takes notes in your meetings.'

const COLUMNS: Column<CompanyRow>[] = [
  {
    id: 'company',
    label: 'Company',
    compare: (a, b) => a.name.localeCompare(b.name),
    cell: (c) => (
      <span className="directory-person">
        <CompanyLogo domain={c.domain} name={c.name} size={32} />
        <span className="directory-person__text">
          <span className="directory-person__name">{c.name}</span>
          <span className="directory-person__email">{c.domain}</span>
        </span>
      </span>
    )
  },
  {
    id: 'last',
    label: 'Last note',
    compare: (a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt),
    cell: (c) => <span className="directory-table__muted">{relativeDay(c.lastSeenAt)}</span>,
    defaultDir: 'desc',
    className: 'directory-table__cell--date'
  },
  { id: 'notes', label: 'Notes', compare: (a, b) => a.count - b.count, cell: (c) => <span className="directory-table__num">{c.count}</span>, className: 'directory-table__cell--num' }
]

export function CompaniesPageView(): JSX.Element {
  const [tab, setTab] = useState<PeopleFilter>('all')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<CompanyRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attach, scrollEl] = useScrollContainer()
  const [sort, onSort, sorted] = useSort(COLUMNS, { column: 'last', dir: 'desc' })
  const viewKey = `companies:${tab}`
  const scrollTop = useRef(readViewState<number>(viewKey) ?? 0)
  const restored = useRef(false)

  const load = (): void => {
    window.notula.companies
      .list({ filter: tab })
      .then((list) => {
        setRows(list)
        setFailed(false)
      })
      .catch((err: unknown) => {
        debugLog('companies:list-failed', { err: String(err) })
        setFailed(true)
      })
  }
  useEffect(load, [tab])
  usePeopleChanged(load)
  useEffect(() => debugLog('companies-page-opened'), [])

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
  const visible = useMemo(() => sorted((rows ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.domain.includes(q))), [rows, q, sorted])

  return (
    <div className="directory-page" ref={attach}>
      <div className="directory-page__column">
        <DirectoryHeader<PeopleFilter> title="Companies" tabs={TABS} tab={tab} onTab={setTab} query={query} onQuery={setQuery} searchLabel="Search companies" />
        {rows === null ? (
          failed ? (
            <p className="directory-error" role="alert">
              Couldn’t load companies
            </p>
          ) : (
            <DirectoryLoading label="Loading companies" />
          )
        ) : visible.length === 0 && q ? (
          <p className="directory-none">No companies match “{query.trim()}”</p>
        ) : (
          <>
            {visible.length ? (
              <DirectoryTable
                columns={COLUMNS}
                rows={visible}
                rowKey={(c) => c.domain}
                onOpen={(c) => {
                  saveViewState(viewKey, scrollTop.current)
                  navigate(`/company/${encodeURIComponent(c.domain)}`)
                }}
                sort={sort}
                onSort={onSort}
                label="Companies"
                rowLabel={(c) => c.name}
              />
            ) : null}
            {!q && visible.length <= PEOPLE_LIMITS.smallListRows ? <DirectoryEmpty icon={<IconBuilding size={22} />} text={COMPANIES_EMPTY} /> : null}
          </>
        )}
      </div>
    </div>
  )
}
