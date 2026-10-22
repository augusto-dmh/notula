// SPDX-License-Identifier: Apache-2.0
// `/person/<email>`: the person page the command palette's People group opens: the
// person's name and email, a chat scoped to their notes, and those notes. The people
// list, the "All notes" / "My notes" tabs and company links live in the people feature.
//
// A person's notes are the user's notes that list them: as creator or attendee in the
// note's `people`, else among its event's attendees.

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { displayName, isResourceEmail } from '@shared/lib/people'
import type { NoteListItem } from '@shared/types/notes'
import { navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { ListChatInput } from '../chat'
import { NoteList } from '../folders'
import { Avatar } from './Avatar'

const lower = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase()

/** The note's people for this email, with the name the note gives them. */
function personIn(item: NoteListItem, email: string): { name: string | null } | null {
  const people = item.people
  if (people) {
    for (const p of [people.creator, ...(people.attendees ?? [])]) {
      if (p && lower(p.email) === email) return { name: p.name?.trim() || null }
    }
    return null
  }
  for (const a of item.linked_event?.attendees ?? []) {
    if (a && lower(a.email) === email) return { name: a.displayName?.trim() || null }
  }
  return null
}

type ListState = { status: 'loading' } | { status: 'ready'; items: NoteListItem[]; name: string | null } | { status: 'error' }

export function PersonPage({ email: raw }: { email: string }): JSX.Element | null {
  const email = useMemo(() => lower(raw), [raw])
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const attach = useCallback((el: HTMLElement | null) => {
    setScrollEl((el?.closest('.page__scroll') as HTMLElement | null) ?? null)
  }, [])

  // No email in the route: home.
  useEffect(() => {
    if (!email || isResourceEmail(email)) navigate('/', { replace: true })
  }, [email])

  const load = useCallback(async (): Promise<void> => {
    if (!email) return
    try {
      const page = await window.notula.notes.list({ scope: 'own' })
      let name: string | null = null
      const items: NoteListItem[] = []
      for (const item of page.items) {
        const hit = personIn(item, email)
        if (!hit) continue
        items.push(item)
        name ??= hit.name
      }
      setList({ status: 'ready', items, name })
    } catch (err) {
      debugLog('person-notes-failed', { err })
      setList((prev) => (prev.status === 'ready' ? prev : { status: 'error' }))
    }
  }, [email])

  useEffect(() => {
    setList({ status: 'loading' })
    void load()
  }, [load])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.notula.notes.onChanged((c) => {
      if (!c.tables.includes('documents') && !c.tables.includes('calendar_events')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), 150)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [load])

  if (!email) return null
  const items = list.status === 'ready' ? list.items : []
  const name = displayName({ name: list.status === 'ready' ? list.name : null, email })
  const domain = email.slice(email.lastIndexOf('@') + 1)

  const copyEmail = (): void => {
    void window.notula.clipboard
      .writeText({ text: email })
      .then(() => showToast({ id: 'person-email', kind: 'success', title: 'Email copied' }))
      .catch(() => showToast({ id: 'person-email', kind: 'error', title: 'Couldn’t copy the email' }))
  }

  return (
    <div className="person-page" ref={attach}>
      <div className="person-page__column">
        <header className="person-page__header">
          <Avatar name={name} email={email} size={40} />
          <div className="person-page__who">
            <h1 className="person-page__name">{name}</h1>
            <button type="button" className="person-page__email" title="Copy email" onClick={copyEmail}>
              {email}
            </button>
            {domain ? <span className="person-page__domain">{domain}</span> : null}
          </div>
        </header>
        <div className="person-page__chat">
          <ListChatInput place={{ kind: 'search', query: email, type: 'person', documentIds: items.map((i) => i.id) }} />
        </div>
        <hr className="person-page__rule" />
        {list.status === 'loading' ? (
          <div className="person-page__loading" aria-busy="true" aria-label="Loading notes">
            <span className="n-spinner" />
          </div>
        ) : list.status === 'error' ? (
          <p className="person-page__empty" role="alert">
            Couldn’t load the notes
          </p>
        ) : items.length === 0 ? (
          <p className="person-page__empty">No notes with this person yet.</p>
        ) : (
          <NoteList
            items={items}
            scrollEl={scrollEl}
            label={`Notes with ${name}`}
            onOpen={(id) => navigate(`/meeting/${encodeURIComponent(id)}`)}
          />
        )}
      </div>
    </div>
  )
}
