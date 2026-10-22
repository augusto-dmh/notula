// SPDX-License-Identifier: Apache-2.0
// A folder's Companies tab: the companies of the folder's
// notes (the user's own domain left out), with Company, People (up to 4 avatars and "+n";
// hovering lists them), Notes and Last note. The search matches the name, the domain and
// the company's people. With company favorites on, a row can be dragged onto the sidebar.

import { useEffect, useMemo, useState, type JSX } from 'react'
import type { CompanyRow, PeopleFilter, PersonRow } from '@shared/types/people'
import { navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { Avatar } from '../calendar/Avatar'
import { DirectoryHeader, DirectoryLoading, DirectoryTable, lastNoteLabel, usePeopleChanged, useSort, type Column } from '../people'
import { usePrefs } from '../settings/prefs-store'
import { CompanyLogo } from './CompanyLogo'
import { COMPANY_FAVORITE_MIME } from './favorites'

const TABS = [
  { value: 'all', label: 'All companies' },
  { value: 'met', label: 'Companies you’ve met' }
] as const satisfies readonly { value: PeopleFilter; label: string }[]

const STACKED = 4

type Row = CompanyRow & { people: PersonRow[] }

function Stack({ people }: { people: PersonRow[] }): JSX.Element | null {
  if (people.length === 0) return null
  return (
    <span className="directory-stack" title={people.map((p) => p.name).join('\n')}>
      {people.slice(0, STACKED).map((p) => (
        <Avatar key={p.email} name={p.name} email={p.email} size={20} />
      ))}
      {people.length > STACKED ? <span className="directory-stack__more">+{people.length - STACKED}</span> : null}
    </span>
  )
}

const COLUMNS: Column<Row>[] = [
  {
    id: 'company',
    label: 'Company',
    compare: (a, b) => a.name.localeCompare(b.name),
    cell: (c) => (
      <span className="directory-person">
        <CompanyLogo domain={c.domain} name={c.name} size={24} />
        <span className="directory-person__text">
          <span className="directory-person__name">{c.name}</span>
          <span className="directory-person__email">{c.domain}</span>
        </span>
      </span>
    )
  },
  { id: 'people', label: 'People', compare: (a, b) => a.uniqueAttendees - b.uniqueAttendees, cell: (c) => <Stack people={c.people} /> },
  { id: 'notes', label: 'Notes', compare: (a, b) => a.count - b.count, cell: (c) => <span className="directory-table__num">{c.count}</span>, className: 'directory-table__cell--num' },
  {
    id: 'last',
    label: 'Last note',
    compare: (a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt),
    cell: (c) => <span className="directory-table__muted">{lastNoteLabel(c.lastSeenAt)}</span>,
    defaultDir: 'desc',
    className: 'directory-table__cell--date'
  }
]

export function FolderCompaniesTab({ folderId }: { folderId: string }): JSX.Element {
  const [tab, setTab] = useState<PeopleFilter>('all')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Row[] | null>(null)
  const [sort, onSort, sorted] = useSort(COLUMNS, { column: 'last', dir: 'desc' })
  const prefs = usePrefs()
  const favoritesOn = prefs?.['companies.sidebarFavorites'] === true

  const load = (): void => {
    Promise.all([window.notula.companies.list({ filter: tab, folderId }), window.notula.people.list({ filter: tab, folderId })])
      .then(([companies, people]) => setRows(companies.map((c) => ({ ...c, people: people.filter((p) => p.domain === c.domain) }))))
      .catch((err: unknown) => {
        debugLog('companies:folder-list-failed', { err: String(err) })
        setRows([])
      })
  }
  useEffect(load, [tab, folderId])
  usePeopleChanged(load)

  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      sorted(
        (rows ?? []).filter(
          (c) =>
            !q ||
            c.name.toLowerCase().includes(q) ||
            c.domain.includes(q) ||
            c.people.some((p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
        )
      ),
    [rows, q, sorted]
  )

  return (
    <div className="folder-directory">
      <DirectoryHeader<PeopleFilter> tabs={TABS} tab={tab} onTab={setTab} query={query} onQuery={setQuery} searchLabel="Search companies in this folder" />
      {rows === null ? (
        <DirectoryLoading label="Loading companies" />
      ) : visible.length === 0 ? (
        <p className="directory-none">{q ? `No companies match “${query.trim()}”` : 'No companies found in this folder'}</p>
      ) : (
        <DirectoryTable
          columns={COLUMNS}
          rows={visible}
          rowKey={(c) => c.domain}
          onOpen={(c) => {
            debugLog('folder-company-opened')
            navigate(`/company/${encodeURIComponent(c.domain)}`)
          }}
          sort={sort}
          onSort={onSort}
          label="Companies in this folder"
          rowLabel={(c) => c.name}
          {...(favoritesOn
            ? {
                onRowDragStart: (c: Row, e) => {
                  e.dataTransfer.setData(COMPANY_FAVORITE_MIME, JSON.stringify({ domain: c.domain, name: c.name }))
                  e.dataTransfer.effectAllowed = 'copy'
                }
              }
            : {})}
        />
      )}
    </div>
  )
}
