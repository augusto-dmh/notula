// SPDX-License-Identifier: Apache-2.0
// `/person/:email` and `/person/p:<personId>`: the person's avatar and name, the
// email (click to copy), their company domain (a link, or plain text for a webmail
// domain), a chat scoped to their notes (`search` / `person`), and those notes. A compact
// header appears after 48 px of scroll. The "All notes" / "My notes" switch is the shared
// search value and, as on the search page, shows only once a note is not the user's.
// A speaker person without an email (`p:<personId>`, speaker profiles) has a letter
// avatar, no email line, and the meetings where the person was named or recognized.

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { displayName, isGenericDomain, isResourceEmail } from '@shared/lib/people'
import type { NoteListItem } from '@shared/types/notes'
import type { PersonDetail } from '@shared/types/people'
import type { SpeakerPersonView } from '@shared/types/speakers'
import { IconCheck } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { debugLog, isOwnNote } from '../../app/platform'
import { Avatar } from '../calendar/Avatar'
import { ListChatInput } from '../chat'
import { NoteList } from '../folders/NoteList'
import { setSearchScope, useSearchScope } from '../search/store'
import { VoiceSection } from '../speaker-profiles'
import { usePrefs } from '../settings/prefs-store'
import { usePeopleChanged, useScrollContainer } from './directory'
import { IconCopySmall } from './icons'

const COMPACT_AFTER_PX = 48
const COPIED_MS = 1_500

type Notes = { status: 'loading' } | { status: 'ready'; items: NoteListItem[] } | { status: 'error' }

/** The notes of a person or company page: `notes:list` by ids, the user's only for "My notes". */
export function useScopedNotes(ids: string[] | null, mine: boolean): Notes {
  const [notes, setNotes] = useState<Notes>({ status: 'loading' })
  const key = ids ? ids.join(',') : null
  const load = useCallback(() => {
    if (ids === null) return
    if (ids.length === 0) {
      setNotes({ status: 'ready', items: [] })
      return
    }
    window.notula.notes
      .list({ scope: 'own', ids, ...(mine ? { ownOnly: true } : {}) })
      .then((page) => setNotes({ status: 'ready', items: page.items }))
      .catch((err: unknown) => {
        debugLog('person-notes-failed', { err: String(err) })
        setNotes((prev) => (prev.status === 'ready' ? prev : { status: 'error' }))
      })
  }, [key, mine])
  useEffect(load, [load])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.notula.notes.onChanged((c) => {
      if (!c.tables.includes('documents') && !c.tables.includes('note_panels')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, 150)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [load])
  return notes
}

/** "All notes" / "My notes", shown only once a note is someone else's. */
export function NotesSwitch({ items }: { items: NoteListItem[] }): JSX.Element | null {
  const scope = useSearchScope()
  if (!items.some((i) => !isOwnNote(i)) && scope === 'all') return null
  return (
    <div className="directory-tabs directory-tabs--notes" role="tablist" aria-label="Notes">
      {(['all', 'mine'] as const).map((v) => (
        <button key={v} type="button" role="tab" aria-selected={scope === v} className="directory-tabs__tab" onClick={() => setSearchScope(v)}>
          {v === 'all' ? 'All notes' : 'My notes'}
        </button>
      ))}
    </div>
  )
}

/** The compact header after 48 px of scroll. */
export function useCompact(scrollEl: HTMLElement | null): boolean {
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    if (!scrollEl) return
    const onScroll = (): void => setCompact(scrollEl.scrollTop > COMPACT_AFTER_PX)
    onScroll()
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollEl.removeEventListener('scroll', onScroll)
  }, [scrollEl])
  return compact
}

export function DomainLink({ domain }: { domain: string }): JSX.Element {
  const prefs = usePrefs()
  const generic = isGenericDomain(domain, prefs?.['people.genericEmailDomains'] ?? [])
  return generic ? (
    <span className="directory-domain">{domain}</span>
  ) : (
    <a className="directory-domain directory-domain--link" href={`https://${domain}`} target="_blank" rel="noreferrer">
      {domain}
    </a>
  )
}

/** A speaker person with no email: `/person/p:<personId>`. */
function SpeakerPersonPageView({ personId }: { personId: string }): JSX.Element | null {
  const [view, setView] = useState<SpeakerPersonView | null | undefined>(undefined)
  const [noteIds, setNoteIds] = useState<string[] | null>(null)
  const [attach, scrollEl] = useScrollContainer()
  const compact = useCompact(scrollEl)
  const scope = useSearchScope()

  const load = useCallback(() => {
    window.notula.speakerPeople
      .get({ personId })
      .then((v) => {
        // Merged away, or given an email since: the page moves to where the person lives now.
        if (v.person.mergedInto) navigate(`/person/${encodeURIComponent(`p:${v.person.mergedInto}`)}`, { replace: true })
        else if (v.person.email) navigate(`/person/${encodeURIComponent(v.person.email)}`, { replace: true })
        else setView(v)
      })
      .catch((err: unknown) => {
        debugLog('speaker-people:get-failed', { err: String(err).slice(0, 200) })
        setView(null)
      })
    window.notula.speakerPeople
      .matches({ personId })
      .then((m) => setNoteIds([...new Set(m.map((x) => x.noteId))]))
      .catch(() => setNoteIds([]))
  }, [personId])
  useEffect(load, [load])
  useEffect(
    () =>
      window.notula.speakerPeople.onChanged((p) => {
        if (!p.personId || p.personId === personId) load()
      }),
    [load, personId]
  )

  const notes = useScopedNotes(noteIds, scope === 'mine')
  if (view === null) {
    return (
      <div className="directory-page directory-page--detail">
        <div className="directory-page__column">
          <p className="directory-error" role="alert">
            Couldn’t find this person
          </p>
        </div>
      </div>
    )
  }
  const name = view?.person.name ?? ''

  return (
    <div className="directory-page directory-page--detail" ref={attach}>
      <div className={`directory-compact${compact ? ' is-shown' : ''}`} aria-hidden={!compact}>
        <Avatar name={name} size={16} />
        <span>{name}</span>
      </div>
      <div className="directory-page__column">
        <header className="directory-who">
          <Avatar name={name} size={32} />
          <div className="directory-who__text">
            <h1 className="directory-who__name">{name}</h1>
          </div>
        </header>
        <VoiceSection personId={personId} name={name} />
        <hr className="directory-rule" />
        {notes.status === 'ready' ? <NotesSwitch items={notes.items} /> : null}
        {view === undefined || notes.status === 'loading' ? (
          <div className="directory-loading" aria-busy="true" aria-label="Loading notes">
            <span className="n-spinner" />
          </div>
        ) : notes.status === 'error' ? (
          <p className="directory-error" role="alert">
            Couldn’t load the notes
          </p>
        ) : notes.items.length === 0 ? (
          <p className="directory-none">No notes with this person yet.</p>
        ) : (
          <NoteList items={notes.items} scrollEl={scrollEl} label={`Notes with ${name}`} onOpen={(id) => navigate(`/meeting/${encodeURIComponent(id)}`)} />
        )}
      </div>
    </div>
  )
}

/** The route key: an email, or `p:<personId>` for a speaker person without one. */
export function PersonPageView({ routeKey }: { routeKey: string }): JSX.Element | null {
  const key = useMemo(() => {
    try {
      return decodeURIComponent(routeKey).trim()
    } catch {
      return routeKey.trim()
    }
  }, [routeKey])
  if (key.startsWith('p:') && key.length > 2) return <SpeakerPersonPageView personId={key.slice(2)} />
  return <EmailPersonPageView email={key} />
}

function EmailPersonPageView({ email: raw }: { email: string }): JSX.Element | null {
  const email = useMemo(() => {
    try {
      return decodeURIComponent(raw).trim().toLowerCase()
    } catch {
      return raw.trim().toLowerCase()
    }
  }, [raw])
  const [detail, setDetail] = useState<PersonDetail | null | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [attach, scrollEl] = useScrollContainer()
  const compact = useCompact(scrollEl)
  const scope = useSearchScope()

  // No email in the route goes home.
  useEffect(() => {
    if (!email || isResourceEmail(email)) navigate('/', { replace: true })
  }, [email])

  const load = useCallback(() => {
    if (!email) return
    window.notula.people
      .get({ email })
      .then(setDetail)
      .catch((err: unknown) => {
        debugLog('people:get-failed', { err: String(err) })
        setDetail(null)
      })
  }, [email])
  useEffect(() => {
    setDetail(undefined)
    load()
  }, [load])
  usePeopleChanged(load)

  const notes = useScopedNotes(detail === undefined ? null : (detail?.noteIds ?? []), scope === 'mine')
  if (!email) return null

  const name = detail?.name || displayName({ email })
  const domain = detail?.domain ?? email.slice(email.lastIndexOf('@') + 1)
  const noteIds = detail?.noteIds ?? []

  const copy = (): void => {
    void window.notula.clipboard.writeText({ text: detail?.email ?? email }).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), COPIED_MS)
    })
  }

  return (
    <div className="directory-page directory-page--detail" ref={attach}>
      <div className={`directory-compact${compact ? ' is-shown' : ''}`} aria-hidden={!compact}>
        <Avatar name={name} email={email} size={16} />
        <span>{name}</span>
      </div>
      <div className="directory-page__column">
        <header className="directory-who">
          <Avatar name={name} email={email} size={32} />
          <div className="directory-who__text">
            <h1 className="directory-who__name">{name}</h1>
            <div className="directory-who__meta">
              <button type="button" className="directory-who__email" title="Copy email" onClick={copy}>
                <span>{detail?.email ?? email}</span>
                {copied ? <IconCheck size={13} /> : <IconCopySmall size={13} />}
              </button>
              {domain ? <DomainLink domain={domain} /> : null}
            </div>
          </div>
        </header>
        <VoiceSection email={email} name={name} />
        <div className="directory-page__chat">
          <ListChatInput place={{ kind: 'search', query: email, type: 'person', documentIds: noteIds }} />
        </div>
        <hr className="directory-rule" />
        {notes.status === 'ready' ? <NotesSwitch items={notes.items} /> : null}
        {detail === undefined || notes.status === 'loading' ? (
          <div className="directory-loading" aria-busy="true" aria-label="Loading notes">
            <span className="n-spinner" />
          </div>
        ) : notes.status === 'error' ? (
          <p className="directory-error" role="alert">
            Couldn’t load the notes
          </p>
        ) : notes.items.length === 0 ? (
          <p className="directory-none">No notes with this person yet.</p>
        ) : (
          <NoteList items={notes.items} scrollEl={scrollEl} label={`Notes with ${name}`} onOpen={(id) => navigate(`/meeting/${encodeURIComponent(id)}`)} />
        )}
      </div>
    </div>
  )
}
