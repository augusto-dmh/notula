// SPDX-License-Identifier: Apache-2.0
// A folder's People tab: the people of the folder's
// notes, with Person, Email, Notes and Last note (the time for today, else the day), and
// "Everyone" / "People I met". The search also matches the person's company and domain.

import { useEffect, useMemo, useState, type JSX } from 'react'
import { companyName, personRouteKey } from '@shared/lib/people'
import type { PeopleFilter, PersonRow } from '@shared/types/people'
import { navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { Avatar } from '../calendar/Avatar'
import { DirectoryHeader, DirectoryLoading, DirectoryTable, lastNoteLabel, usePeopleChanged, useSort, type Column } from './directory'
import './people.css'

const TABS = [
  { value: 'all', label: 'Everyone' },
  { value: 'met', label: 'People you’ve met' }
] as const satisfies readonly { value: PeopleFilter; label: string }[]

const COLUMNS: Column<PersonRow>[] = [
  {
    id: 'person',
    label: 'Person',
    compare: (a, b) => a.name.localeCompare(b.name),
    cell: (p) => (
      <span className="directory-person">
        <Avatar name={p.name} email={p.email} size={24} />
        <span className="directory-person__name">
          {p.name}
          {p.isSelf ? <span className="directory-person__me"> (me)</span> : null}
        </span>
      </span>
    )
  },
  { id: 'email', label: 'Email', compare: (a, b) => (a.email ?? '').localeCompare(b.email ?? ''), cell: (p) => <span className="directory-table__muted">{p.email ?? ''}</span> },
  { id: 'notes', label: 'Notes', compare: (a, b) => a.count - b.count, cell: (p) => <span className="directory-table__num">{p.count}</span>, className: 'directory-table__cell--num' },
  {
    id: 'last',
    label: 'Last note',
    compare: (a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt),
    cell: (p) => <span className="directory-table__muted">{lastNoteLabel(p.lastSeenAt)}</span>,
    defaultDir: 'desc',
    className: 'directory-table__cell--date'
  }
]

export function FolderPeopleTab({ folderId }: { folderId: string }): JSX.Element {
  const [tab, setTab] = useState<PeopleFilter>('all')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<PersonRow[] | null>(null)
  const [sort, onSort, sorted] = useSort(COLUMNS, { column: 'last', dir: 'desc' })

  const load = (): void => {
    window.notula.people
      .list({ filter: tab, folderId })
      .then(setRows)
      .catch((err: unknown) => {
        debugLog('people:folder-list-failed', { err: String(err) })
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
          (p) =>
            !q ||
            p.name.toLowerCase().includes(q) ||
            (p.email ?? '').toLowerCase().includes(q) ||
            (p.domain ?? '').includes(q) ||
            (p.domain ? companyName(p.domain).toLowerCase().includes(q) : false)
        )
      ),
    [rows, q, sorted]
  )

  return (
    <div className="folder-directory">
      <DirectoryHeader<PeopleFilter> tabs={TABS} tab={tab} onTab={setTab} query={query} onQuery={setQuery} searchLabel="Search people in this folder" />
      {rows === null ? (
        <DirectoryLoading label="Loading people" />
      ) : visible.length === 0 ? (
        <p className="directory-none">{q ? `No people match “${query.trim()}”` : 'No people in this folder yet'}</p>
      ) : (
        <DirectoryTable
          columns={COLUMNS}
          rows={visible}
          rowKey={(p) => personRouteKey(p)}
          onOpen={(p) => {
            debugLog('folder-person-opened')
            navigate(`/person/${encodeURIComponent(personRouteKey(p))}`)
          }}
          sort={sort}
          onSort={onSort}
          label="People in this folder"
          rowLabel={(p) => p.name}
        />
      )}
    </div>
  )
}
