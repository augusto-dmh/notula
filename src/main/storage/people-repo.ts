// SPDX-License-Identifier: Apache-2.0
// People and companies:
// in-memory maps derived in the worker; a rebuild emits the pseudo-table `people_maps`.
//
// The walk: notes not in the trash, oldest first by `created_at`. A note's participants are
// its `people.attendees` (which already carry the user's attendee edits) plus
// `people.creator`, with the `attendee_overrides` applied once more; a note without `people`
// uses its calendar attendees that are not `self`. Calendar resources and note-taker bots
// never count. Names: the calendar display names, then the participant's own name, then the
// name derived from the email; the newest note's name wins. `lastSeenAt` is the note's
// creation time.
//
// The maps are keyed only by note data. Everything that depends on the user's settings
// ("my emails", the webmail list) is applied per query, so a settings change needs no
// rebuild. A read rebuilds the maps when the notes changed since the last build; main
// asks for that at most once a minute (people/index.ts) and pushes `people:changed`.

import type { CalendarAttendee, CalendarEvent, NotePeople, NotePerson } from '@shared/types/notes'
import type {
  CompaniesQuery,
  CompanyDetail,
  CompanyRow,
  PeopleQuery,
  PersonDetail,
  PersonRow
} from '@shared/types/people'
import { DEMO_MEETING_PREFIX } from '@shared/types/notes'
import { companyName, displayName, isExcludedEmail, isGenericDomain, isResourceEmail } from '@shared/lib/people'
import { parseJson } from './rows'
import { speakerPeopleForList } from './speaker-people-repo'
import { invalid, type StoreCtx } from './store'

const MAX_QUERY = 200
const MAX_ID = 200

type Attendee = CalendarAttendee | NotePerson

interface Participant {
  /** Lower-cased. */
  key: string
  email: string
  name: string
  attendee: Attendee | null
}

interface NoteFacts {
  id: string
  createdAt: string
  participants: Participant[]
}

interface PersonAgg {
  email: string
  name: string
  domain: string | null
  lastSeenAt: string
  documents: string[]
  latestAttendee: Attendee | null
}

interface CompanyAgg {
  domain: string
  lastSeenAt: string
  documents: string[]
}

interface Maps {
  fingerprint: string
  notes: NoteFacts[]
  people: Map<string, PersonAgg>
  companies: Map<string, CompanyAgg>
}

let built: Maps | null = null

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@')
  const d = at < 0 ? '' : email.slice(at + 1).trim().toLowerCase()
  return d || null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

interface ManualEdit {
  email: string
  action: 'add' | 'remove'
}

function manualEdits(people: NotePeople | null): ManualEdit[] {
  const list = Array.isArray(people?.attendee_overrides) ? people.attendee_overrides : []
  return list.filter(
    (e): e is ManualEdit =>
      !!e && typeof (e as ManualEdit).email === 'string' && ((e as ManualEdit).action === 'add' || (e as ManualEdit).action === 'remove')
  )
}

/** One note's participants. */
function participantsOf(people: NotePeople | null, event: CalendarEvent | null): Participant[] {
  const calendar = new Map<string, CalendarAttendee>()
  for (const a of Array.isArray(event?.attendees) ? event.attendees : []) {
    const email = str(a?.email)
    if (email) calendar.set(email.toLowerCase(), a)
  }
  const organizer = (event?.['organizer'] ?? null) as { email?: unknown; displayName?: unknown } | null
  const creator = (event?.['creator'] ?? null) as { email?: unknown; displayName?: unknown } | null
  const eventName = (key: string): string => {
    const a = calendar.get(key)
    if (str(a?.displayName)) return str(a?.displayName)
    if (str(organizer?.email).toLowerCase() === key && str(organizer?.displayName)) return str(organizer?.displayName)
    if (str(creator?.email).toLowerCase() === key && str(creator?.displayName)) return str(creator?.displayName)
    return ''
  }

  // The candidate pool: calendar attendees, then people.attendees, then the creator (a later entry wins).
  const pool = new Map<string, { email: string; name: string; attendee: Attendee }>()
  for (const [key, a] of calendar) pool.set(key, { email: str(a.email), name: '', attendee: a })
  for (const p of people?.attendees ?? []) {
    const email = str(p?.email)
    if (email) pool.set(email.toLowerCase(), { email, name: str(p.name), attendee: p })
  }
  const creatorEmail = str(people?.creator?.email)
  if (creatorEmail && people?.creator) pool.set(creatorEmail.toLowerCase(), { email: creatorEmail, name: str(people.creator.name), attendee: people.creator })

  const keys = new Set<string>()
  if (people) {
    for (const p of people.attendees ?? []) {
      const email = str(p?.email)
      if (email) keys.add(email.toLowerCase())
    }
  } else {
    for (const [key, a] of calendar) if (!a.self && !a.resource) keys.add(key)
  }
  for (const e of manualEdits(people)) {
    const key = e.email.trim().toLowerCase()
    if (e.action === 'remove') keys.delete(key)
    else if (pool.has(key)) keys.add(key)
  }
  if (creatorEmail) keys.add(creatorEmail.toLowerCase())

  const out: Participant[] = []
  for (const key of keys) {
    const c = pool.get(key)
    if (!c || !key.includes('@') || isExcludedEmail(key)) continue
    out.push({ key, email: c.email, name: eventName(key) || c.name, attendee: c.attendee })
  }
  return out
}

function readNotes(s: StoreCtx): NoteFacts[] {
  const rows = s.db
    .prepare(
      `SELECT id, created_at, people, linked_event, event_id FROM documents
       WHERE deleted_at IS NULL AND owner_id = @owner AND workspace_id = @workspace AND is_scratchpad = 0
       ORDER BY created_at ASC, rid ASC`
    )
    .all({ owner: s.identity.ownerId, workspace: s.identity.workspaceId }) as {
    id: string
    created_at: string
    people: string | null
    linked_event: string | null
    event_id: string | null
  }[]
  const notes: NoteFacts[] = []
  for (const r of rows) {
    // The bundled demo meeting is not the user's.
    if (r.id.startsWith(DEMO_MEETING_PREFIX) || (r.event_id ?? '').startsWith(DEMO_MEETING_PREFIX)) continue
    const people = parseJson<NotePeople | null>(r.people, null)
    const event = parseJson<CalendarEvent | null>(r.linked_event, null)
    notes.push({ id: r.id, createdAt: r.created_at, participants: participantsOf(people && typeof people === 'object' ? people : null, event) })
  }
  return notes
}

/** The people and company maps, over notes walked oldest first. */
function aggregate(notes: NoteFacts[]): { people: Map<string, PersonAgg>; companies: Map<string, CompanyAgg> } {
  const people = new Map<string, PersonAgg>()
  const companies = new Map<string, CompanyAgg>()
  for (const n of notes) {
    const seenDomains = new Set<string>()
    for (const p of n.participants) {
      const cur = people.get(p.key)
      if (cur) {
        if (p.name) cur.name = p.name
        cur.email = p.email || cur.email
        if (n.createdAt > cur.lastSeenAt) cur.lastSeenAt = n.createdAt
        if (!cur.documents.includes(n.id)) cur.documents.push(n.id)
        if (p.attendee) cur.latestAttendee = { ...(cur.latestAttendee ?? {}), ...p.attendee } as Attendee
      } else {
        people.set(p.key, {
          email: p.email,
          name: p.name,
          domain: domainOf(p.key),
          lastSeenAt: n.createdAt,
          documents: [n.id],
          latestAttendee: p.attendee
        })
      }
      const domain = domainOf(p.key)
      if (!domain || isResourceEmail(`x@${domain}`) || seenDomains.has(domain)) continue
      seenDomains.add(domain)
      const c = companies.get(domain)
      if (c) {
        if (n.createdAt > c.lastSeenAt) c.lastSeenAt = n.createdAt
        c.documents.push(n.id)
      } else {
        companies.set(domain, { domain, lastSeenAt: n.createdAt, documents: [n.id] })
      }
    }
  }
  return { people, companies }
}

function fingerprint(s: StoreCtx): string {
  const d = s.db
    .prepare(
      `SELECT count(*) AS n, max(updated_at) AS u, total(length(coalesce(people, '')) + length(coalesce(linked_event, ''))) AS l
       FROM documents WHERE deleted_at IS NULL AND owner_id = @owner AND workspace_id = @workspace`
    )
    .get({ owner: s.identity.ownerId, workspace: s.identity.workspaceId }) as { n: number; u: string | null; l: number }
  return `${s.identity.ownerId}|${d.n}|${d.u ?? ''}|${d.l}`
}

/** The maps, rebuilt first when the notes changed since the last build. */
function maps(s: StoreCtx): Maps {
  const fp = fingerprint(s)
  if (built && built.fingerprint === fp) return built
  const started = Date.now()
  const notes = readNotes(s)
  const { people, companies } = aggregate(notes)
  built = { fingerprint: fp, notes, people, companies }
  s.touch('people_maps')
  s.log('debug', 'people:maps-rebuilt', { notes: notes.length, people: people.size, companies: companies.size, ms: Date.now() - started })
  return built
}

/** The folder's notes only, aggregated on demand. */
function scoped(s: StoreCtx, m: Maps, folderId: string | undefined): { people: Map<string, PersonAgg>; companies: Map<string, CompanyAgg> } {
  if (!folderId) return m
  const ids = new Set(
    (s.db.prepare(`SELECT note_id FROM folder_notes WHERE folder_id = ?`).all(folderId) as { note_id: string }[]).map((r) => r.note_id)
  )
  return aggregate(m.notes.filter((n) => ids.has(n.id)))
}

function query(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string' || v.length > MAX_QUERY) throw invalid('query is invalid')
  return v.trim().toLowerCase()
}

function folderIdOf(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !v || v.length > MAX_ID) throw invalid('folderId is invalid')
  return v
}

function lowerSet(list: unknown): Set<string> {
  return new Set((Array.isArray(list) ? list : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()))
}

function personName(p: PersonAgg): string {
  return p.name || displayName({ email: p.email })
}

function byRecent<T extends { lastSeenAt: string }>(a: T, b: T): number {
  return b.lastSeenAt.localeCompare(a.lastSeenAt)
}

/**
 * The derived rows, joined with the persisted speaker people: a
 * person with the row's email gives it `personId` and `hasVoice`, and the user's own rows take the
 * self person. Outside a folder, a person no derived row holds (no email, or an email met nowhere)
 * is listed too, opening `/person/p:<id>`. `voice` keeps the rows with a remembered voice.
 */
export function listPeople(s: StoreCtx, q: PeopleQuery & { myEmails: string[] }): PersonRow[] {
  if (q?.filter !== 'all' && q?.filter !== 'met' && q?.filter !== 'voice') throw invalid('filter must be all, met or voice')
  const m = maps(s)
  const folderId = folderIdOf(q.folderId)
  const scope = scoped(s, m, folderId)
  const needle = query(q.query)
  const mine = lowerSet(q.myEmails)
  const persisted = speakerPeopleForList(s)
  const byEmail = new Map(persisted.filter((p) => p.email).map((p) => [p.email!, p]))
  const self = persisted.find((p) => p.isSelf) ?? null
  const joined = new Set<string>()
  const rows: PersonRow[] = []
  for (const [key, p] of scope.people) {
    const name = personName(p)
    if (needle) {
      const company = p.domain ? companyName(p.domain).toLowerCase() : ''
      const hit = name.toLowerCase().includes(needle) || key.includes(needle) || (!!q.folderId && (company.includes(needle) || (p.domain ?? '').includes(needle)))
      if (!hit) continue
    }
    const isSelf = mine.has(key)
    const person = byEmail.get(key) ?? (isSelf ? self : null)
    if (person) joined.add(person.personId)
    // Every note is the user's own while Notula has no server: "met" = "all", `isMine` always.
    rows.push({
      email: p.email,
      ...(person ? { personId: person.personId } : {}),
      hasVoice: person?.hasVoice ?? false,
      name,
      domain: p.domain,
      lastSeenAt: p.lastSeenAt,
      count: p.documents.length,
      isMine: true,
      isSelf
    })
  }
  if (!folderId) {
    for (const p of persisted) {
      // The user is listed through their own email rows, never as a second row.
      if (p.isSelf || joined.has(p.personId) || (p.email && m.people.has(p.email))) continue
      if (needle && !p.name.toLowerCase().includes(needle) && !(p.email ?? '').includes(needle)) continue
      rows.push({
        ...(p.email ? { email: p.email } : {}),
        personId: p.personId,
        hasVoice: p.hasVoice,
        name: p.name,
        domain: p.email ? domainOf(p.email) : null,
        lastSeenAt: p.lastAt,
        count: p.notes,
        isMine: true,
        isSelf: false
      })
    }
  }
  return (q.filter === 'voice' ? rows.filter((r) => r.hasVoice) : rows).sort(byRecent)
}

export function getPerson(s: StoreCtx, email: string, _myEmails: string[]): PersonDetail | null {
  const m = maps(s)
  if (typeof email !== 'string' || !email.trim()) return null
  const p = m.people.get(email.trim().toLowerCase())
  if (!p) return null
  return { email: p.email, name: personName(p), domain: p.domain, lastSeenAt: p.lastSeenAt, noteIds: [...p.documents], latestAttendee: p.latestAttendee }
}

/** Domains of "my emails" that are a company (the folder tab leaves them out). */
function ownDomains(myEmails: string[], generic: string[]): Set<string> {
  return new Set(
    myEmails
      .map((e) => domainOf(e.trim().toLowerCase()))
      .filter((d): d is string => !!d && !isGenericDomain(d, generic))
  )
}

export function listCompanies(s: StoreCtx, q: CompaniesQuery & { myEmails: string[]; genericDomains: string[] }): CompanyRow[] {
  // `voice` is a people filter; companies read it as all.
  if (q?.filter !== 'all' && q?.filter !== 'met' && q?.filter !== 'voice') throw invalid('filter must be all, met or voice')
  const m = maps(s)
  const folderId = folderIdOf(q.folderId)
  const scope = scoped(s, m, folderId)
  const needle = query(q.query)
  const generic = Array.isArray(q.genericDomains) ? q.genericDomains : []
  const own = folderId ? ownDomains(Array.isArray(q.myEmails) ? q.myEmails : [], generic) : new Set<string>()
  const peopleByDomain = new Map<string, PersonAgg[]>()
  for (const p of scope.people.values()) {
    if (!p.domain) continue
    const list = peopleByDomain.get(p.domain) ?? []
    list.push(p)
    peopleByDomain.set(p.domain, list)
  }
  const rows: CompanyRow[] = []
  for (const c of scope.companies.values()) {
    if (isGenericDomain(c.domain, generic) || own.has(c.domain)) continue
    const name = companyName(c.domain)
    const staff = peopleByDomain.get(c.domain) ?? []
    if (needle) {
      const hit =
        name.toLowerCase().includes(needle) ||
        c.domain.includes(needle) ||
        (!!folderId && staff.some((p) => personName(p).toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle)))
      if (!hit) continue
    }
    rows.push({ domain: c.domain, name, lastSeenAt: c.lastSeenAt, count: c.documents.length, uniqueAttendees: staff.length, isMine: true })
  }
  return rows.sort(byRecent)
}

export function getCompany(s: StoreCtx, domain: string, o: { myEmails: string[]; genericDomains: string[] }): CompanyDetail | null {
  const m = maps(s)
  if (typeof domain !== 'string' || !domain.trim()) return null
  const key = domain.trim().toLowerCase()
  if (isGenericDomain(key, Array.isArray(o?.genericDomains) ? o.genericDomains : [])) return null
  const c = m.companies.get(key)
  if (!c) return null
  const docs = new Set(c.documents)
  const people = [...m.people.values()]
    .filter((p) => p.domain === key)
    .sort(byRecent)
    .map((p) => ({ email: p.email, name: personName(p), noteIds: p.documents.filter((id) => docs.has(id)) }))
    .filter((p) => p.noteIds.length > 0)
  return { domain: key, name: companyName(key), lastSeenAt: c.lastSeenAt, noteIds: [...c.documents], people }
}
