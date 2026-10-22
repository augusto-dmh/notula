// SPDX-License-Identifier: Apache-2.0
// `/company/:domain`: the logo, name and domain,
// the people from that company in the user's notes, a chat scoped to its notes
// (`search` / `company`), and those notes. With the Labs switch on, a star adds the
// company to the sidebar favorites.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { companyName, displayName } from '@shared/lib/people'
import type { CompanyDetail } from '@shared/types/people'
import { navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { Avatar } from '../calendar/Avatar'
import { ListChatInput } from '../chat'
import { NoteList } from '../folders/NoteList'
import { DomainLink, IconStar, NotesSwitch, useCompact, usePeopleChanged, useScopedNotes, useScrollContainer } from '../people'
import { useSearchScope } from '../search/store'
import { usePrefs } from '../settings/prefs-store'
import { CompanyLogo } from './CompanyLogo'
import { addFavorite, isFavorite, removeFavorite } from './favorites'

const STACKED = 4

function PeopleLine({ people }: { people: CompanyDetail['people'] }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  if (people.length === 0) return null
  const name = (p: CompanyDetail['people'][number]): string => p.name || displayName({ email: p.email })
  const go = (email: string): void => navigate(`/person/${encodeURIComponent(email)}`)
  if (people.length === 1) {
    const p = people[0] as CompanyDetail['people'][number]
    return (
      <div className="directory-who__people">
        <button type="button" className="directory-who__person" onClick={() => go(p.email)}>
          <Avatar name={name(p)} email={p.email} size={20} />
          {name(p)}
        </button>
      </div>
    )
  }
  return (
    <div className="directory-who__people directory-people-pop" ref={wrap} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="directory-who__person" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="directory-stack">
          {people.slice(0, STACKED).map((p) => (
            <Avatar key={p.email} name={name(p)} email={p.email} size={20} />
          ))}
        </span>
        {people.length > STACKED ? <span className="directory-stack__more">+{people.length - STACKED}</span> : null}
        <span>{people.length} people</span>
      </button>
      {open ? (
        <div className="directory-people-pop__list" role="menu">
          {people.map((p) => (
            <button key={p.email} type="button" role="menuitem" className="directory-people-pop__item" onClick={() => go(p.email)}>
              <Avatar name={name(p)} email={p.email} size={20} />
              <span>{name(p)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function CompanyPageView({ domain: raw }: { domain: string }): JSX.Element | null {
  const domain = useMemo(() => {
    try {
      return decodeURIComponent(raw).trim().toLowerCase()
    } catch {
      return raw.trim().toLowerCase()
    }
  }, [raw])
  const [detail, setDetail] = useState<CompanyDetail | null | undefined>(undefined)
  const [attach, scrollEl] = useScrollContainer()
  const compact = useCompact(scrollEl)
  const scope = useSearchScope()
  const prefs = usePrefs()
  const favoritesOn = prefs?.['companies.sidebarFavorites'] === true
  const starred = isFavorite(domain, prefs?.['companies.favorites'] ?? [])

  // No domain in the route goes home.
  useEffect(() => {
    if (!domain) navigate('/', { replace: true })
  }, [domain])

  const load = useCallback(() => {
    if (!domain) return
    window.notula.companies
      .get({ domain })
      .then(setDetail)
      .catch((err: unknown) => {
        debugLog('companies:get-failed', { err: String(err) })
        setDetail(null)
      })
  }, [domain])
  useEffect(() => {
    setDetail(undefined)
    load()
  }, [load])
  usePeopleChanged(load)

  const notes = useScopedNotes(detail === undefined ? null : (detail?.noteIds ?? []), scope === 'mine')
  if (!domain) return null
  const name = detail?.name || companyName(domain)
  const noteIds = detail?.noteIds ?? []

  return (
    <div className="directory-page directory-page--detail" ref={attach}>
      <div className={`directory-compact${compact ? ' is-shown' : ''}`} aria-hidden={!compact}>
        <CompanyLogo domain={domain} name={name} size={16} />
        <span>{name}</span>
      </div>
      <div className="directory-page__column">
        <header className="directory-who">
          <CompanyLogo domain={domain} name={name} size={32} />
          <div className="directory-who__text">
            <h1 className="directory-who__name">{name}</h1>
            <div className="directory-who__meta">
              <DomainLink domain={domain} />
            </div>
            <PeopleLine people={detail?.people ?? []} />
          </div>
          {favoritesOn ? (
            <div className="directory-who__actions">
              <span className="n-tooltip n-tooltip--end" data-tooltip={starred ? 'Remove from favorites' : 'Add to favorites'}>
                <button
                  type="button"
                  className={`n-icon-btn directory-star${starred ? ' is-on' : ''}`}
                  aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
                  aria-pressed={starred}
                  onClick={() => (starred ? removeFavorite(domain) : addFavorite({ domain, name }))}
                >
                  <IconStar size={17} filled={starred} />
                </button>
              </span>
            </div>
          ) : null}
        </header>
        <div className="directory-page__chat">
          <ListChatInput place={{ kind: 'search', query: domain, type: 'company', documentIds: noteIds }} />
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
          <p className="directory-none">No notes with this company yet.</p>
        ) : (
          <NoteList items={notes.items} scrollEl={scrollEl} label={`Notes with ${name}`} onOpen={(id) => navigate(`/meeting/${encodeURIComponent(id)}`)} />
        )}
      </div>
    </div>
  )
}
