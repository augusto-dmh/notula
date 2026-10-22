// SPDX-License-Identifier: Apache-2.0
// The note header's date and attendee trigger, with the popover of people and event
// details. It sends `calendar:viewing-event` so the reminder scheduler knows which
// event's note is open.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import { detectConferenceLink, joinLabel } from '@shared/lib/conference'
import { companyFromEmail, displayName, isGenericDomain, isResourceEmail, peopleForNote } from '@shared/lib/people'
import { CALENDAR_COLOR_DEFAULT, type Participant } from '@shared/types/calendar'
import type { CalendarEvent, Note, NotePeople, NotePerson } from '@shared/types/notes'
import { IconCalendar } from '../../app/icons'
import { debugLog, isOwnNote } from '../../app/platform'
import { showToast } from '../../app/toast'
import { regenerate } from '../enhance'
import { Avatar } from './Avatar'
import { eventEndMs, eventStartMs, formatRange, myEmailsFrom, useCalendarData, usePrefs } from './store'
import './calendar.css'

interface ManualEdit {
  name: string
  email: string
  action: 'add' | 'remove'
}

interface Person {
  name: string
  email: string
  isCreator: boolean
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const lower = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()
const domainOf = (email: string): string => lower(email.split('@')[1])

/** Notes whose suggestion was answered this session. */
const answered = new Set<string>()

function edits(people: NotePeople | null | undefined): ManualEdit[] {
  const list = Array.isArray(people?.attendee_overrides) ? (people.attendee_overrides as ManualEdit[]) : []
  return list.filter((e) => e && typeof e.email === 'string' && (e.action === 'add' || e.action === 'remove'))
}

/** `people.attendees` plus the creator; without `people`, the event's attendees. Resources never. */
function listedPeople(note: Note): Person[] {
  const out: Person[] = []
  const seen = new Set<string>()
  const creatorKey = lower(note.people?.creator?.email)
  const push = (p: NotePerson | { name?: string; email?: string }, isCreator: boolean): void => {
    const email = (p.email ?? '').trim()
    const key = lower(email)
    if (!key || seen.has(key) || isResourceEmail(email)) return
    seen.add(key)
    out.push({ name: p.name?.trim() || displayName({ email }), email, isCreator: isCreator || (!!creatorKey && key === creatorKey) })
  }
  if (note.people) {
    for (const a of note.people.attendees ?? []) push(a, false)
    if (note.people.creator?.email) push(note.people.creator, true)
  } else {
    for (const a of note.linked_event?.attendees ?? []) {
      if (a?.resource) continue
      push({ name: a.displayName ?? '', email: a.email }, false)
    }
  }
  return out
}

/** Linking: the event's attendees, then the manual edits on top; the creator stays. */
function mergedPeople(note: Note, ev: CalendarEvent, profile: { name: string; email: string }, mine: string[]): NotePeople {
  const fresh = peopleForNote({ event: ev, profile, myEmails: mine })
  const manual = edits(note.people)
  let attendees = [...(fresh.attendees ?? [])]
  for (const e of manual) {
    const key = lower(e.email)
    attendees = attendees.filter((a) => lower(a.email) !== key)
    if (e.action === 'add') attendees.push({ email: e.email, name: e.name || displayName({ email: e.email }) })
  }
  return { ...(note.people ?? {}), creator: note.people?.creator ?? fresh.creator, attendees, attendee_overrides: manual }
}

/** Unlinking: only manually added attendees are kept. */
function unlinkedPeople(note: Note, profile: { name: string; email: string }): NotePeople {
  const manual = edits(note.people)
  return {
    ...(note.people ?? {}),
    creator: note.people?.creator ?? { name: profile.name, email: profile.email },
    attendees: manual.filter((e) => e.action === 'add').map((e) => ({ email: e.email, name: e.name || displayName({ email: e.email }) })),
    attendee_overrides: manual
  }
}

function useNote(noteId: string): { note: Note | null; hasSummary: boolean } {
  const [note, setNote] = useState<Note | null>(null)
  const [hasSummary, setHasSummary] = useState(false)
  const load = useCallback(() => {
    void window.notula.notes
      .get({ id: noteId })
      .then((n) => setNote(n))
      .catch(() => undefined)
    void window.notula.panels
      .list({ noteId })
      .then((p) => setHasSummary(p.some((x) => !x.deleted_at)))
      .catch(() => undefined)
  }, [noteId])
  useEffect(() => {
    setNote(null)
    load()
    return window.notula.notes.onChanged((c) => {
      if (c.ids.includes(noteId) || c.tables.includes('note_panels')) load()
    })
  }, [noteId, load])
  return { note, hasSummary }
}

/** A small anchored popover: Escape and outside clicks close it. */
function Popover({ open, onClose, children }: { open: boolean; onClose(): void; children: ReactNode }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const el = ref.current
      if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.nt-attendees__trigger')) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="nt-popover" ref={ref} role="dialog" aria-label="Meeting details">
      {children}
    </div>
  )
}

function PeopleIcon(): JSX.Element {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <circle cx="17" cy="9.5" r="2.6" />
      <path d="M15.5 14.2A4.6 4.6 0 0 1 21 18.6" />
    </svg>
  )
}

export function NoteAttendeesView({ noteId }: { noteId: string }): JSX.Element | null {
  const { note, hasSummary } = useNote(noteId)
  const prefs = usePrefs()
  const { state, calendars } = useCalendarData()
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const mine = useMemo(() => myEmailsFrom(prefs, state), [prefs, state])
  const mineSet = useMemo(() => new Set(mine), [mine])
  const profile = useMemo(() => ({ name: prefs?.['profile.name'] ?? '', email: prefs?.['profile.email'] ?? '' }), [prefs])
  const eventId = note?.linked_event?.id ?? null

  // Row 147: on mount, on event change and on unmount.
  useEffect(() => {
    window.notula.calendar.setViewingEvent({ eventId })
    return () => window.notula.calendar.setViewingEvent({ eventId: null })
  }, [eventId])

  if (!note) return null
  const event = note.linked_event
  const editable = isOwnNote(note) && !note.deleted_at
  const people = listedPeople(note)
  const others = people.filter((p) => !mineSet.has(lower(p.email)) && !p.isCreator)
  const countLabel = others.length === 0 ? 'Me' : `${people.length} attendee${people.length === 1 ? '' : 's'}`
  const when = eventStartMs(event) ?? Date.parse(note.created_at)
  const dateLabel = new Date(when).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

  return (
    <div className="nt-attendees">
      <button type="button" className="nt-attendees__trigger" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconCalendar size={15} />
        <span>{dateLabel}</span>
        <span className="nt-attendees__sep" aria-hidden="true" />
        <PeopleIcon />
        <span>{countLabel}</span>
      </button>
      {editable && !event ? <EventSuggestion note={note} mine={mineSet} profile={profile} /> : null}
      <Popover open={open} onClose={close}>
        {event ? (
          <EventDetails
            event={event}
            color={calendars.find((c) => c.id === event['calendarId'])?.color ?? CALENDAR_COLOR_DEFAULT}
            userEmail={state?.sources.find((s) => event.id.includes(`:${s.id}:`))?.accountEmail ?? (profile.email || null)}
          />
        ) : null}
        {editable ? <EventPicker note={note} mine={mine} profile={profile} /> : null}
        <PeopleSection
          note={note}
          people={people}
          editable={editable}
          hasSummary={hasSummary}
          mine={mine}
          profile={profile}
          genericDomains={prefs?.['people.genericEmailDomains'] ?? []}
        />
      </Popover>
    </div>
  )
}

// ---------- people ----------

function PeopleSection({
  note,
  people,
  editable,
  hasSummary,
  mine,
  profile,
  genericDomains
}: {
  note: Note
  people: Person[]
  editable: boolean
  hasSummary: boolean
  mine: string[]
  profile: { name: string; email: string }
  genericDomains: readonly string[]
}): JSX.Element {
  const ownDomain = domainOf(profile.email || mine[0] || '')
  // By domain; webmail groups first, the user's own domain last, the rest in order.
  const groups = useMemo(() => {
    const map = new Map<string, Person[]>()
    for (const p of people) {
      const d = domainOf(p.email)
      map.set(d, [...(map.get(d) ?? []), p])
    }
    const entries = [...map.entries()]
    const rank = (d: string): number => (isGenericDomain(d, genericDomains) ? 0 : d === ownDomain ? 2 : 1)
    return entries.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e[0]) - rank(b.e[0]) || a.i - b.i).map(({ e }) => e)
  }, [people, genericDomains, ownDomain])

  const edit = async (action: 'add' | 'remove', person: { name: string; email: string }): Promise<void> => {
    const key = lower(person.email)
    const base: NotePeople =
      note.people ?? peopleForNote({ event: note.linked_event, profile, myEmails: mine })
    const creatorKey = lower(base.creator?.email)
    let attendees = [...(base.attendees ?? [])]
    if (action === 'add') {
      if (key === creatorKey || attendees.some((a) => lower(a.email) === key) || (mine.includes(key) && !note.people)) {
        showToast({ id: 'attendee-exists', title: 'Already on the attendee list' })
        return
      }
      attendees.push({ email: person.email.trim(), name: person.name || displayName({ email: person.email }) })
    } else {
      if (key === creatorKey) {
        showToast({ id: 'attendee-creator', kind: 'error', title: 'The organizer can’t be removed' })
        return
      }
      attendees = attendees.filter((a) => lower(a.email) !== key)
    }
    const manual = edits(base).filter((e) => lower(e.email) !== key)
    manual.push({ name: person.name, email: person.email.trim(), action })
    const before = note.people ?? null
    try {
      await window.notula.notes.update({ id: note.id, patch: { people: { ...base, attendees, attendee_overrides: manual } } })
      debugLog(action === 'add' ? 'attendee-added' : 'attendee-removed')
      showToast({
        id: 'attendees-updated',
        title: 'Attendees updated',
        action: { label: 'Undo', onClick: () => void window.notula.notes.update({ id: note.id, patch: { people: before } }).catch(() => undefined) }
      })
      if (hasSummary) {
        showToast({ id: 'attendees-regenerate', title: 'Attendees changed', action: { label: 'Regenerate notes', onClick: () => regenerate(note.id) } })
      }
    } catch {
      showToast({ id: 'attendee-failed', kind: 'error', title: action === 'add' ? 'Couldn’t add attendee' : 'Couldn’t update attendees' })
    }
  }

  return (
    <div className="nt-people">
      {groups.map(([domain, list]) => (
        <div key={domain || '-'} className="nt-people__group">
          <div className="nt-people__domain">
            {/* No enrichment: the company comes from the email domain, none for a webmail domain. */}
            {domain && !isGenericDomain(domain, genericDomains) && companyFromEmail(`x@${domain}`) ? (
              <>
                {companyFromEmail(`x@${domain}`)} <span className="nt-people__host">{domain}</span>
              </>
            ) : (
              domain || 'Other'
            )}
          </div>
          {list.map((p) => (
            <div key={p.email} className="nt-person">
              <Avatar name={p.name} email={p.email} size={20} />
              <span className="nt-person__text">
                <span className="nt-person__name">{p.name || p.email}</span>
                {p.name ? <span className="nt-person__email">{p.email}</span> : null}
              </span>
              {editable && !p.isCreator && !(mine.includes(lower(p.email)) && !note.people) ? (
                <button type="button" className="nt-person__remove" aria-label={`Remove ${p.name || p.email}`} onClick={() => void edit('remove', p)}>
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ))}
      {editable ? <AddAttendee noteId={note.id} onAdd={(p) => void edit('add', p)} /> : null}
    </div>
  )
}

function AddAttendee({ noteId, onAdd }: { noteId: string; onAdd(p: { name: string; email: string }): void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Participant[]>([])
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void window.notula.people
        .participants({ query: q, noteId })
        .then((r) => alive && setResults(r))
        .catch(() => alive && setResults([]))
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, noteId])
  const q = query.trim()
  const pick = (p: { name: string; email: string }): void => {
    onAdd(p)
    setQuery('')
  }
  return (
    <div className="nt-add">
      <input
        className="n-input nt-add__input"
        placeholder="Add attendees..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          if (results[0]) pick({ name: results[0].name, email: results[0].email })
          else if (EMAIL.test(q)) pick({ name: displayName({ email: q }), email: q })
        }}
        aria-label="Add attendees"
      />
      {q ? (
        <div className="nt-add__results" role="listbox">
          {results.map((r) => (
            <button key={r.email} type="button" role="option" aria-selected="false" className="nt-add__result" onClick={() => pick({ name: r.name, email: r.email })}>
              <Avatar name={r.name} email={r.email} size={20} />
              <span className="nt-person__text">
                <span className="nt-person__name">{r.name || r.email}</span>
                {r.name ? <span className="nt-person__email">{r.email}</span> : null}
              </span>
              <span className="nt-add__verb">Add</span>
            </button>
          ))}
          {results.length === 0 ? (
            EMAIL.test(q) ? (
              <button type="button" className="nt-add__result" onClick={() => pick({ name: displayName({ email: q }), email: q })}>
                <Avatar name={null} email={q} size={20} />
                <span className="nt-person__text">
                  <span className="nt-person__name">Add {q}</span>
                </span>
              </button>
            ) : (
              <div className="nt-add__hint">Type an email to add...</div>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------- event details ----------

const OUTLOOK_HOSTS = ['outlook.office365.com', 'outlook.live.com']
const GOOGLE_CALENDAR_HOSTS = ['calendar.google.com']

function EventDetails({ event, color, userEmail }: { event: CalendarEvent; color: string; userEmail: string | null }): JSX.Element {
  const start = eventStartMs(event)
  const end = eventEndMs(event)
  const link = detectConferenceLink(event, userEmail)
  const ended = end !== null && end <= Date.now()
  const description = typeof event['description'] === 'string' ? (event['description'] as string).trim() : ''
  const location = typeof event['location'] === 'string' ? (event['location'] as string).trim() : ''
  const showLocation = !!location && !/zoom|google meet|teams/i.test(location)
  let htmlLink = typeof event['htmlLink'] === 'string' && /^https?:\/\//i.test(event['htmlLink'] as string) ? (event['htmlLink'] as string) : null
  let outlook = false
  if (htmlLink) {
    let host = ''
    try {
      host = new URL(htmlLink).hostname.toLowerCase()
    } catch {
      host = ''
    }
    outlook = OUTLOOK_HOSTS.includes(host)
    // An ICS feed's URL property can point anywhere, often at the call itself: it is shown
    // as a calendar link only on a calendar host. API events carry their own link.
    if (event.id.startsWith('ics:') && !outlook && !GOOGLE_CALENDAR_HOSTS.includes(host)) htmlLink = null
  }
  const showJoin = !ended && link !== null
  const date = start !== null ? new Date(start).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) : ''
  return (
    <div className="nt-event-details">
      <div className="nt-event-details__title">
        <span className="nt-dot" style={{ background: color }} aria-hidden="true" />
        {event.summary || 'Untitled'}
      </div>
      {start !== null ? (
        <div className="nt-event-details__when">
          {date} · {formatRange(start, end)}
        </div>
      ) : null}
      {description ? (
        <div className="nt-event-details__block">
          <div className="nt-event-details__label">Description</div>
          <div className="nt-event-details__desc">{description}</div>
        </div>
      ) : null}
      {showLocation ? (
        <div className="nt-event-details__block">
          <div className="nt-event-details__label">Location</div>
          <div className="nt-event-details__loc">{location}</div>
        </div>
      ) : null}
      {showJoin || htmlLink ? (
        <div className="nt-event-details__actions">
          {showJoin && link ? (
            <button
              type="button"
              className="n-btn n-btn--primary n-btn--sm"
              onClick={() =>
                void window.notula.calendar
                  .join({ url: link.url, calendarId: typeof event['calendarId'] === 'string' ? (event['calendarId'] as string) : null })
                  .catch(() => undefined)
              }
            >
              {link.provider ? joinLabel(link) : 'Join Meeting'}
            </button>
          ) : null}
          {htmlLink ? (
            <a className="n-btn n-btn--ghost n-btn--sm" href={htmlLink} target="_blank" rel="noreferrer noopener">
              {showJoin ? 'Calendar' : outlook ? 'Open in Outlook Calendar' : 'Open in Google Calendar'}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------- linking ----------

async function linkEvent(note: Note, ev: CalendarEvent | null, profile: { name: string; email: string }, mine: string[]): Promise<() => Promise<void>> {
  const before = { linked_event: note.linked_event, title: note.title, people: note.people }
  if (ev) {
    const title = !note.title?.trim() ? (ev.summary ?? null) : note.title
    await window.notula.notes.update({ id: note.id, patch: { linked_event: ev, title, people: mergedPeople(note, ev, profile, mine) } })
  } else {
    const oldTitle = note.linked_event?.summary
    const title = oldTitle && note.title === oldTitle ? null : note.title
    await window.notula.notes.update({ id: note.id, patch: { linked_event: null, title, people: unlinkedPeople(note, profile) } })
  }
  return async () => {
    await window.notula.notes.update({ id: note.id, patch: before })
  }
}

function EventPicker({ note, mine, profile }: { note: Note; mine: string[]; profile: { name: string; email: string } }): JSX.Element {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const day = new Date(Date.parse(note.created_at))
    day.setHours(0, 0, 0, 0)
    let alive = true
    void window.notula.calendar
      .range({ from: day.toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString() })
      .then((list) => alive && setEvents(list.filter((e) => !!e.start?.dateTime)))
      .catch(() => alive && setEvents([]))
    return () => {
      alive = false
    }
  }, [open, note.created_at])
  const choose = (ev: CalendarEvent | null): void => {
    setOpen(false)
    void linkEvent(note, ev, profile, mine).catch(() => showToast({ id: 'event-link-failed', kind: 'error', title: 'Couldn’t link the calendar event. Try again.' }))
  }
  return (
    <div className="nt-picker">
      <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {note.linked_event ? 'Change calendar event' : 'Choose a calendar event'}
      </button>
      {open ? (
        <div className="nt-picker__list" role="listbox" aria-label="Choose a calendar event">
          {events === null ? <div className="nt-add__hint">Loading…</div> : null}
          {events?.map((ev) => {
            const s = eventStartMs(ev)
            return (
              <button key={ev.id} type="button" role="option" aria-selected={ev.id === note.linked_event?.id} className="nt-picker__item" onClick={() => choose(ev)}>
                <span className="nt-picker__time">{s !== null ? formatRange(s, eventEndMs(ev)) : ''}</span>
                <span className="nt-picker__title">{ev.summary || 'Untitled'}</span>
              </button>
            )
          })}
          {events && events.length === 0 ? <div className="nt-add__hint">No events that day</div> : null}
          <button type="button" role="option" aria-selected={!note.linked_event} className="nt-picker__item" onClick={() => choose(null)}>
            <span className="nt-picker__title">No calendar event</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** A note without an event, created during a meeting that is still on. */
function EventSuggestion({ note, mine, profile }: { note: Note; mine: ReadonlySet<string>; profile: { name: string; email: string } }): JSX.Element | null {
  const [candidate, setCandidate] = useState<CalendarEvent | null>(null)
  const [hidden, setHidden] = useState(() => answered.has(note.id))
  useEffect(() => {
    if (hidden) return
    const created = Date.parse(note.created_at)
    const now = Date.now()
    let alive = true
    void window.notula.calendar
      .range({ from: new Date(Math.min(created, now) - 86_400_000).toISOString(), to: new Date(now + 60_000).toISOString() })
      .then((list) => {
        if (!alive) return
        const attends = (ev: CalendarEvent): boolean =>
          (ev.attendees ?? []).some((a) => a.self === true || mine.has(lower(a.email))) ||
          [ev['organizer'], ev['creator']].some((p) => {
            const o = p as { self?: unknown; email?: unknown } | undefined
            return o?.self === true || (typeof o?.email === 'string' && mine.has(lower(o.email)))
          })
        // Of overlapping meetings, the one that started last: the one just joined, as the
        // tray and the detected-meeting card pick it.
        const hits = list.filter((ev) => {
          const s = eventStartMs(ev)
          const e = eventEndMs(ev)
          return s !== null && e !== null && s <= now && e > now && created >= s - 10 * 60_000 && created < e && attends(ev)
        })
        const hit = hits.sort((a, b) => (eventStartMs(b) ?? 0) - (eventStartMs(a) ?? 0))[0]
        setCandidate(hit ?? null)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [note.id, note.created_at, hidden, mine])
  if (hidden || !candidate) return null
  const dismiss = (): void => {
    answered.add(note.id)
    setHidden(true)
  }
  const yes = (): void => {
    dismiss()
    void linkEvent(note, candidate, profile, [...mine])
      .then((undo) =>
        showToast({
          id: 'event-linked',
          kind: 'success',
          title: 'Event added',
          description: candidate.summary || 'Calendar event',
          action: { label: 'Undo', onClick: () => void undo().catch(() => undefined) }
        })
      )
      .catch(() => showToast({ id: 'event-link-failed', kind: 'error', title: 'Couldn’t link the calendar event. Try again.' }))
  }
  return (
    <div className="nt-suggest" role="group" aria-label="Is this your current meeting?">
      <span className="nt-suggest__text">
        Is this your current meeting? <strong>{candidate.summary}</strong>
      </span>
      <button type="button" className="n-btn n-btn--sm" onClick={yes}>
        Yes
      </button>
      <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={dismiss}>
        No
      </button>
    </div>
  )
}
