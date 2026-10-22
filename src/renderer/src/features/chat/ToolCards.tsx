// SPDX-License-Identifier: Apache-2.0
// Result cards for the chat tools, composed from each tool's
// labels. Every card reads the call's stored `result`,
// so a finished answer shows the same card after a reload. Rows open their note, person,
// company or folder.

import type { JSX, ReactNode } from 'react'
import type { ChatToolCall } from '@shared/types/chat'
import { navigate } from '../../app/navigation'
import { Avatar } from '../calendar/Avatar'
import { IconCalendarDay, IconDoc, IconFolderSmall } from './icons'

type Rec = Record<string, unknown>

function obj(v: unknown): Rec | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null
}

function arr(v: unknown): Rec[] {
  return Array.isArray(v) ? v.filter((x): x is Rec => !!obj(x)) : []
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

const DAY_MS = 86_400_000

/** "Today", "Yesterday", "Mon 12 Oct" (and the year when it isn't this one). */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const start = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((start(d) - start(now)) / DAY_MS)
  if (diff === 0) return 'Today'
  if (diff === -1) return 'Yesterday'
  if (diff === 1) return 'Tomorrow'
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  })
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function Card({ title, children, footer }: { title?: ReactNode; children: ReactNode; footer?: ReactNode }): JSX.Element {
  return (
    <div className="chat-card">
      {title ? <div className="chat-card__title">{title}</div> : null}
      <div className="chat-card__body">{children}</div>
      {footer ? <div className="chat-card__footer">{footer}</div> : null}
    </div>
  )
}

function Row({ onOpen, lead, title, meta, sub }: { onOpen?(): void; lead?: ReactNode; title: string; meta?: string; sub?: ReactNode }): JSX.Element {
  const body = (
    <>
      {lead ? <span className="chat-card__lead">{lead}</span> : null}
      <span className="chat-card__text">
        <span className="chat-card__row-title">{title}</span>
        {sub ? <span className="chat-card__sub">{sub}</span> : null}
      </span>
      {meta ? <span className="chat-card__meta">{meta}</span> : null}
    </>
  )
  return onOpen ? (
    <button type="button" className="chat-card__row chat-card__row--link" onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className="chat-card__row">{body}</div>
  )
}

const openNote = (id: string) => (): void => navigate(`/meeting/${encodeURIComponent(id)}`)

/** At most this many rows show; the rest are counted. */
const SHOWN = 8

function MoreLine({ total, shown }: { total: number; shown: number }): JSX.Element | null {
  return total > shown ? <div className="chat-card__more">and {total - shown} more</div> : null
}

// ---------- meetings ----------

/** "Listed 12 meetings matching "x" with "Jane" from Planning". */
function listTitle(call: ChatToolCall, n: number): string {
  const kw = str(call.args['keyword'])
  const who = str(call.args['participant'])
  const scope = str(call.args['scope'])
  const parts = [n === 0 ? 'Found no meetings' : `Listed ${n} meeting${n === 1 ? '' : 's'}`]
  if (kw) parts.push(`matching "${kw}"`)
  if (who) parts.push(`with "${who}"`)
  if (scope === 'attended') parts.push('from your attended meetings')
  return parts.join(' ')
}

function MeetingsCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const r = obj(call.result)
  const rows = arr(r?.['meetings'])
  if (!r || rows.length === 0) return null
  const total = num(r['count']) ?? rows.length
  const title = call.name === 'listMeetings' || call.name === 'fetchMeetings' ? listTitle(call, total) : undefined
  return (
    <Card title={title}>
      {rows.slice(0, SHOWN).map((m) => {
        const date = str(m['date']) || str(m['created_at'])
        const attendees = Array.isArray(m['attendees']) ? (m['attendees'] as string[]).slice(0, 3).join(', ') : ''
        return (
          <Row key={str(m['id'])} onOpen={openNote(str(m['id']))} lead={<IconDoc size={14} />} title={str(m['title']) || 'Untitled note'} sub={attendees || undefined} meta={dayLabel(date)} />
        )
      })}
      <MoreLine total={rows.length} shown={SHOWN} />
    </Card>
  )
}

function TranscriptCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const m = obj(obj(call.result)?.['meeting'])
  if (!m) return null
  const n = num(obj(call.result)?.['windows']) ?? 0
  return (
    <Card>
      <Row onOpen={openNote(str(m['id']))} lead={<IconDoc size={14} />} title={str(m['title']) || 'Untitled note'} meta={n ? `${n} passage${n === 1 ? '' : 's'}` : 'No transcript'} />
    </Card>
  )
}

const GROUP_TITLES: Record<string, string> = {
  term_search: 'Keywords',
  entity_match: 'People and companies',
  folder: 'Folders',
  date_range: 'Time range'
}

function ExploreCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const groups = arr(obj(call.result)?.['groups'])
  if (groups.length === 0) return null
  return (
    <Card>
      {groups.map((g, i) => {
        const type = str(g['type'])
        const seed = Array.isArray(g['terms'])
          ? (g['terms'] as string[]).join(', ')
          : Array.isArray(g['entities'])
            ? (g['entities'] as string[]).join(', ')
            : str(g['time_range']).replace(/_/g, ' ')
        const rows = arr(g['results'])
        const available = num(g['totalAvailable']) ?? rows.length
        return (
          <div key={`${type}-${i}`} className="chat-card__group">
            <div className="chat-card__group-title">
              {GROUP_TITLES[type] ?? type}
              {seed ? <span className="chat-card__group-seed">{seed}</span> : null}
              <span className="chat-card__group-count">{available}</span>
            </div>
            {rows.length === 0 ? <div className="chat-card__more">No meetings</div> : null}
            {rows.slice(0, 5).map((m) => {
              const headers = Array.isArray(m['noteHeaders']) ? (m['noteHeaders'] as string[]).slice(0, 3) : []
              const who = Array.isArray(m['attendeeNames']) ? (m['attendeeNames'] as string[]).slice(0, 3).join(', ') : ''
              return (
                <Row
                  key={str(m['id'])}
                  onOpen={openNote(str(m['id']))}
                  lead={<IconDoc size={14} />}
                  title={str(m['title']) || 'Untitled note'}
                  sub={headers.length ? headers.join(' · ') : who || undefined}
                  meta={dayLabel(str(m['meetingAt']))}
                />
              )
            })}
            <MoreLine total={available} shown={Math.min(5, rows.length)} />
          </div>
        )
      })}
    </Card>
  )
}

// ---------- calendar ----------

function UpcomingCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const events = arr(obj(call.result)?.['events'])
  if (events.length === 0) return <Card title="Upcoming meetings"><div className="chat-card__more">Nothing on your calendar</div></Card>
  const byDay = new Map<string, Rec[]>()
  for (const e of events) {
    const key = dayLabel(str(e['start']))
    byDay.set(key, [...(byDay.get(key) ?? []), e])
  }
  return (
    <Card title="Upcoming meetings">
      {[...byDay].map(([day, list]) => (
        <div key={day} className="chat-card__group">
          <div className="chat-card__group-title">{day}</div>
          {list.map((e) => (
            <Row
              key={str(e['id'])}
              lead={<IconCalendarDay size={14} />}
              title={str(e['title'])}
              sub={Array.isArray(e['attendees']) ? (e['attendees'] as string[]).slice(0, 3).join(', ') || undefined : undefined}
              meta={e['allDay'] === true ? 'All-day' : timeLabel(str(e['start']))}
            />
          ))}
        </div>
      ))}
    </Card>
  )
}

function CalendarEventsCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const events = arr(obj(call.result)?.['events'])
  if (events.length === 0) return null
  return (
    <Card>
      {events.slice(0, SHOWN).map((e) => {
        const start = str(e['startTime'])
        const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start)
        return <Row key={str(e['id'])} lead={<IconCalendarDay size={14} />} title={str(e['title'])} meta={`${dayLabel(start)}${allDay ? '' : ` ${timeLabel(start)}`}`} />
      })}
      <MoreLine total={events.length} shown={SHOWN} />
    </Card>
  )
}

// ---------- people ----------

function PeopleCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const r = obj(call.result)
  const people = arr(r?.['people'])
  const entities = arr(r?.['entities'])
  if (people.length === 0 && entities.length === 0) return null
  const rows = people.length
    ? people.map((p) => {
        const interactions = arr(p['interactions'])[0]
        const count = num(interactions?.['count'])
        const last = str(interactions?.['lastAt']) || str(p['lastInteractionAt'])
        return { kind: 'person', name: str(p['name']), email: str(p['email']), domain: '', count, last }
      })
    : entities.map((e) => ({ kind: str(e['kind']), name: str(e['name']), email: str(e['email']), domain: str(e['domain']), count: null, last: '' }))
  return (
    <Card>
      {rows.slice(0, SHOWN).map((p) =>
        p.kind === 'company' ? (
          <Row
            key={`c-${p.domain}`}
            onOpen={() => navigate(`/company/${encodeURIComponent(p.domain)}`)}
            lead={<span className="chat-card__tile">{(p.name || p.domain).charAt(0).toUpperCase()}</span>}
            title={p.name || p.domain}
            sub={p.domain}
          />
        ) : (
          <Row
            key={`p-${p.email}`}
            onOpen={p.email ? () => navigate(`/person/${encodeURIComponent(p.email)}`) : undefined}
            lead={<Avatar name={p.name} email={p.email} size={20} />}
            title={p.name || p.email || 'Unknown person'}
            sub={p.email}
            meta={p.count !== null ? `${p.count} meeting${p.count === 1 ? '' : 's'}${p.last ? ` · ${dayLabel(p.last)}` : ''}` : p.last ? dayLabel(p.last) : undefined}
          />
        )
      )}
      <MoreLine total={rows.length} shown={SHOWN} />
    </Card>
  )
}

// ---------- action items, folders, files, event notes ----------

function ActionItemsCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const items = arr(obj(call.result)?.['items'])
  if (items.length === 0) return null
  return (
    <Card>
      {items.slice(0, 20).map((i) => {
        const source = str(i['sourceNoteId'])
        const owners = Array.isArray(i['attribution']) ? (i['attribution'] as string[]).join(', ') : ''
        return (
          <Row
            key={str(i['id'])}
            onOpen={source ? openNote(source) : undefined}
            lead={<span className={`chat-card__check${i['status'] === 'done' ? ' is-done' : ''}`} aria-hidden="true" />}
            title={str(i['intent'])}
            sub={[str(i['detail']), owners].filter(Boolean).join(' · ') || undefined}
            meta={str(i['sourceTitle']) || undefined}
          />
        )
      })}
    </Card>
  )
}

function FoldersCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const folders = arr(obj(call.result)?.['folders'])
  if (folders.length === 0) return null
  return (
    <Card>
      {folders.slice(0, SHOWN).map((f) => (
        <Row
          key={str(f['id'])}
          onOpen={() => navigate(`/list/${encodeURIComponent(str(f['id']))}`)}
          lead={<IconFolderSmall size={14} />}
          title={str(f['title']) || 'Untitled folder'}
          meta={`${num(f['noteCount']) ?? 0} note${num(f['noteCount']) === 1 ? '' : 's'}`}
        />
      ))}
      <MoreLine total={folders.length} shown={SHOWN} />
    </Card>
  )
}

function FilesCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const files = arr(obj(call.result)?.['files'])
  if (files.length === 0) return null
  return (
    <Card>
      {files.slice(0, SHOWN).map((f) => (
        <Row key={str(f['id'])} lead={<IconDoc size={14} />} title={str(f['name'])} sub={str(f['content_summary']) || undefined} meta={dayLabel(str(f['created_at']))} />
      ))}
      <MoreLine total={files.length} shown={SHOWN} />
    </Card>
  )
}

function FileCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const f = obj(obj(call.result)?.['file'])
  if (!f) return null
  const lines = str(f['content']).split('\n').filter((l) => l.trim()).slice(0, 4)
  return (
    <Card title={str(f['name'])}>
      <div className="chat-card__excerpt">{lines.join('\n')}</div>
    </Card>
  )
}

function EventNotesCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const r = obj(call.result)
  const id = str(r?.['document_id'])
  if (!r) return null
  const lines = str(r['notes']).split('\n').filter((l) => l.trim())
  return (
    <Card>
      <Row
        onOpen={id ? openNote(id) : undefined}
        lead={<IconDoc size={14} />}
        title={str(r['title']) || 'Untitled event'}
        sub={id ? (lines.length ? `${lines.length} line${lines.length === 1 ? '' : 's'} of notes` : 'No notes yet') : 'No note for this event yet'}
        meta={r['created'] === true ? 'New note' : undefined}
      />
    </Card>
  )
}

function OrganizeCard({ call }: { call: ChatToolCall }): JSX.Element | null {
  const r = obj(call.result)
  if (!r) return null
  if (call.name === 'createFolder') {
    const id = str(r['id'])
    return id ? (
      <Card>
        <Row onOpen={() => navigate(`/list/${encodeURIComponent(id)}`)} lead={<IconFolderSmall size={14} />} title={str(r['title'])} meta="Open" />
      </Card>
    ) : null
  }
  const added = arr(r['added']).map((f) => str(f['title']))
  const removed = arr(r['removed']).map((f) => str(f['title']))
  const noteId = str(r['noteId'])
  return (
    <Card>
      <Row
        onOpen={noteId ? openNote(noteId) : undefined}
        lead={<IconFolderSmall size={14} />}
        title={[added.length ? `Added to ${added.join(', ')}` : '', removed.length ? `Removed from ${removed.join(', ')}` : ''].filter(Boolean).join(' · ')}
      />
    </Card>
  )
}

const MEETING_LISTS = new Set([
  'listMeetings',
  'fetchMeetings',
  'findMeetingsByTerms',
  'findMeetingsWithPeople',
  'findMeetingsWithPeopleOrCompanies',
  'gatherMeetingContext',
  'getMeetings',
  'readMeetings'
])

/** The card for a finished call, or null when it has none. */
export function toolCard(call: ChatToolCall): JSX.Element | null {
  if (!call.completed || call.error || call.result === null || call.result === undefined) return null
  if (MEETING_LISTS.has(call.name)) return <MeetingsCard call={call} />
  switch (call.name) {
    case 'readTranscript':
      return <TranscriptCard call={call} />
    case 'exploreMeetings':
      return <ExploreCard call={call} />
    case 'listUpcomingEvents':
      return <UpcomingCard call={call} />
    case 'searchCalendar':
    case 'listEventsInRange':
    case 'findEvents':
      return <CalendarEventsCard call={call} />
    case 'resolvePerson':
    case 'findPeople':
    case 'findPeopleOrCompanies':
      return <PeopleCard call={call} />
    case 'list_todos':
    case 'show_todo_cards':
      return <ActionItemsCard call={call} />
    case 'findFolders':
      return <FoldersCard call={call} />
    case 'listFolderAttachments':
      return <FilesCard call={call} />
    case 'readFile':
      return <FileCard call={call} />
    case 'readEventNote':
    case 'appendToEventNote':
    case 'editEventNote':
      return <EventNotesCard call={call} />
    case 'createFolder':
    case 'organizeNote':
      return <OrganizeCard call={call} />
    default:
      return null
  }
}
