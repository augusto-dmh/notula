// SPDX-License-Identifier: Apache-2.0
// `/wiki` and `/wiki/:section`: Overview, the seven domain
// sections, "How to work with me", the name dictionary and People. Every section is an editable
// text box with its provenance; "Draft from my meetings" fills it from recent notes through the
// user's own AI provider, never replacing what the user wrote without asking.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import {
  USER_CONTEXT_LIMITS,
  USER_CONTEXT_SECTIONS,
  type UserContextDraftEvent,
  type UserContextSection,
  type UserContextSectionId,
  type UserContextState
} from '@shared/types/user-context'
import { IconSparkle } from '../../app/icons'
import { navigate, useRoute } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import './user-context.css'

type Page = 'overview' | UserContextSectionId | 'names' | 'people'

const PAGES: { id: Page; title: string }[] = [
  { id: 'overview', title: 'Overview' },
  ...USER_CONTEXT_SECTIONS.map((s) => ({ id: s.id as Page, title: s.title })),
  { id: 'names', title: 'Name dictionary' },
  { id: 'people', title: 'People' }
]

const HINTS: Record<UserContextSectionId, string> = {
  identity: 'Your role, team and company, and what you are responsible for.',
  'current-work': 'What you are working on now, and what matters most.',
  relationships: 'The people you work with most, and how.',
  'work-habits': 'How you like to work and make decisions. For example: "Prefers bullet points".',
  communication: 'How you write and speak, and the formats you prefer. Chat uses this to write in your voice.',
  calendar: 'Your meetings and scheduling habits.',
  reference: 'Your terms, acronyms and tools, and where things live.',
  'assistant-guide': 'A short guide for colleagues working with you.'
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function useUserContext(): { state: UserContextState | null; error: string | null; reload(): void } {
  const [state, setState] = useState<UserContextState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    window.notula.userContext
      .get()
      .then((s) => {
        setState(s)
        setError(null)
      })
      .catch((err: unknown) => setError(parseError(err).message || 'Couldn’t load this page. Try again.'))
  }, [])
  useEffect(() => {
    reload()
    return window.notula.userContext.onChanged(reload)
  }, [reload])
  return { state, error, reload }
}

interface Draft {
  runId: string | null
  sectionIds: UserContextSectionId[]
}

export function UserContextPageView(): JSX.Element {
  const { params } = useRoute()
  const page = (PAGES.some((p) => p.id === params['section']) ? params['section'] : 'overview') as Page
  const { state, error, reload } = useUserContext()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirm, setConfirm] = useState<UserContextSectionId[] | null>(null)
  const draftRef = useRef<Draft | null>(null)
  draftRef.current = draft

  useEffect(
    () =>
      window.notula.userContext.onDraftProgress((e: UserContextDraftEvent) => {
        const d = draftRef.current
        if (!d || (d.runId && d.runId !== e.runId)) return
        if (e.type === 'started') return
        setDraft(null)
        if (e.type === 'error') showToast({ title: e.message, kind: 'error' })
        else if (e.updated.length === 0 && e.skippedUser.length === 0) showToast({ title: 'Nothing to add from your recent notes', kind: 'info' })
        else showToast({ title: e.updated.length === 1 ? 'Section drafted' : `${e.updated.length} sections drafted`, kind: 'success' })
        reload()
      }),
    [reload]
  )

  const startDraft = async (ids: UserContextSectionId[], overwriteUser: boolean): Promise<void> => {
    setConfirm(null)
    setDraft({ runId: null, sectionIds: ids })
    try {
      const { runId } = await window.notula.userContext.draft({ sectionIds: ids, overwriteUser })
      setDraft((d) => (d ? { ...d, runId } : d))
    } catch (err) {
      setDraft(null)
      showToast({ title: "Couldn't draft your profile", description: parseError(err).message, kind: 'error' })
    }
  }

  /** Asks first when a requested section holds the user's own text. */
  const requestDraft = (ids: UserContextSectionId[]): void => {
    const own = ids.filter((id) => {
      const s = state?.sections.find((x) => x.section_id === id)
      return s && s.origin === 'user' && s.content.trim()
    })
    if (own.length) setConfirm(ids)
    else void startDraft(ids, false)
  }

  const emptyIds = USER_CONTEXT_SECTIONS.map((s) => s.id).filter((id) => !state?.sections.find((x) => x.section_id === id)?.content.trim())

  return (
    <div className="uc-page">
      <nav className="uc-nav" aria-label="Wiki">
        <h1 className="uc-nav__title">Wiki</h1>
        {PAGES.map((p) => (
          <button
            key={p.id}
            type="button"
            className="uc-nav__item"
            aria-current={p.id === page ? 'page' : undefined}
            onClick={() => navigate(p.id === 'overview' ? '/wiki' : `/wiki/${p.id}`, { replace: true })}
          >
            {p.title}
          </button>
        ))}
      </nav>
      <main className="uc-main">
        {error ? (
          <div className="uc-empty" role="alert">
            <p className="uc-empty__title">Couldn’t load your wiki</p>
            <p>{error}</p>
            <button type="button" className="n-btn n-btn--sm" onClick={reload}>
              Refresh
            </button>
          </div>
        ) : !state ? (
          <p className="uc-loading">Loading your wiki…</p>
        ) : (
          <div className="uc-column">
            {confirm ? (
              <div className="uc-confirm" role="alertdialog" aria-label="Replace your text?">
                <p>Some of these sections hold text you wrote. Replace it with a draft, or only fill the others?</p>
                <div className="uc-confirm__actions">
                  <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button type="button" className="n-btn n-btn--sm" onClick={() => void startDraft(confirm, false)}>
                    Keep mine
                  </button>
                  <button type="button" className="n-btn n-btn--sm n-btn--danger" onClick={() => void startDraft(confirm, true)}>
                    Replace
                  </button>
                </div>
              </div>
            ) : null}
            {page === 'overview' ? (
              <Overview state={state} drafting={!!draft} emptyIds={emptyIds} onDraftAll={() => requestDraft(emptyIds)} />
            ) : page === 'names' ? (
              <Names names={state.nameDictionary} />
            ) : page === 'people' ? (
              <People state={state} />
            ) : (
              <SectionEditor
                key={page}
                id={page}
                section={state.sections.find((s) => s.section_id === page) ?? null}
                drafting={!!draft && draft.sectionIds.includes(page)}
                busy={!!draft}
                onDraft={() => requestDraft([page])}
              />
            )}
          </div>
        )}
      </main>
    </div>
  )
}

function Header({ title, children }: { title: string; children?: React.ReactNode }): JSX.Element {
  return (
    <header className="uc-header">
      <div>
        <h2 className="uc-title">{title}</h2>
      </div>
      {children ? <div className="uc-header__actions">{children}</div> : null}
    </header>
  )
}

function Overview(p: { state: UserContextState; drafting: boolean; emptyIds: UserContextSectionId[]; onDraftAll(): void }): JSX.Element {
  const prefs = usePrefs()
  const filled = USER_CONTEXT_SECTIONS.map((def) => ({ def, s: p.state.sections.find((x) => x.section_id === def.id) })).filter((x) => x.s?.content.trim())
  return (
    <>
      <Header title="Overview">
        <button type="button" className="n-btn n-btn--sm" disabled={p.drafting || p.emptyIds.length === 0} onClick={p.onDraftAll}>
          {p.drafting ? <span className="n-spinner" aria-hidden="true" /> : <IconSparkle size={14} />}
          {p.drafting ? 'Drafting…' : 'Draft all empty sections'}
        </button>
      </Header>
      <p className="uc-tagline">What Notula knows about you. Stored only on this computer.</p>
      <p className="uc-lead">Notula adds this to your summaries and chats so they fit how you work. It goes only to the AI provider you chose.</p>
      <div className="uc-switches">
        <label className="uc-switch">
          <input type="checkbox" checked={prefs?.['userContext.inSummaries'] !== false} onChange={(e) => setPrefs({ 'userContext.inSummaries': e.target.checked })} />
          Use in summaries
        </label>
        <label className="uc-switch">
          <input type="checkbox" checked={prefs?.['userContext.inChat'] !== false} onChange={(e) => setPrefs({ 'userContext.inChat': e.target.checked })} />
          Use in chat
        </label>
      </div>
      {filled.length === 0 ? (
        <div className="uc-empty">
          <p className="uc-empty__title">Your wiki is empty</p>
          <p>Write about yourself in any section, or let your AI draft it from your recent meetings.</p>
        </div>
      ) : (
        filled.map(({ def, s }) => (
          <section key={def.id} className="uc-card">
            <button type="button" className="uc-card__title" onClick={() => navigate(`/wiki/${def.id}`, { replace: true })}>
              {def.title}
            </button>
            <p className="uc-card__body">{s!.content}</p>
            <Provenance section={s!} />
          </section>
        ))
      )}
    </>
  )
}

function Provenance({ section }: { section: UserContextSection }): JSX.Element {
  return (
    <p className="uc-prov">
      {section.origin === 'drafted' && section.drafted_at ? `Drafted from your meetings · Saved ${dateLabel(section.updated_at)}` : 'Written by you'}
    </p>
  )
}

function SectionEditor(p: { id: UserContextSectionId; section: UserContextSection | null; drafting: boolean; busy: boolean; onDraft(): void }): JSX.Element {
  const title = USER_CONTEXT_SECTIONS.find((s) => s.id === p.id)!.title
  const [text, setText] = useState(p.section?.content ?? '')
  const [saving, setSaving] = useState(false)
  const saved = useRef(p.section?.content ?? '')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A draft (or another window) changed the stored text: take it unless the user is mid-edit.
  useEffect(() => {
    const next = p.section?.content ?? ''
    if (next !== saved.current && text === saved.current) setText(next)
    saved.current = next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.section?.content])

  const save = useCallback(
    (value: string) => {
      if (value === saved.current) return
      setSaving(true)
      window.notula.userContext
        .update({ sectionId: p.id, content: value })
        .then((s) => {
          saved.current = s.content
        })
        .catch((err: unknown) => showToast({ title: "Couldn't save", description: parseError(err).message, kind: 'error' }))
        .finally(() => setSaving(false))
    },
    [p.id]
  )

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const onChange = (value: string): void => {
    setText(value)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => save(value), 800)
  }

  return (
    <>
      <Header title={title}>
        <button type="button" className="n-btn n-btn--sm" disabled={p.busy} onClick={p.onDraft}>
          {p.drafting ? <span className="n-spinner" aria-hidden="true" /> : <IconSparkle size={14} />}
          {p.drafting ? 'Drafting…' : 'Draft from my meetings'}
        </button>
      </Header>
      <p className="uc-lead">{HINTS[p.id]}</p>
      <textarea
        className="n-input uc-editor"
        value={text}
        maxLength={USER_CONTEXT_LIMITS.sectionMax}
        placeholder="Nothing yet. Add what Notula should know about you."
        disabled={p.drafting}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (timer.current) clearTimeout(timer.current)
          save(text)
        }}
      />
      <div className="uc-editor__meta">
        {p.section && p.section.content.trim() ? <Provenance section={p.section} /> : <span />}
        <span className="uc-count">
          {saving ? 'Saving…' : `${text.length.toLocaleString()} / ${USER_CONTEXT_LIMITS.sectionMax.toLocaleString()}`}
        </span>
      </div>
    </>
  )
}

function Names({ names }: { names: string[] }): JSX.Element {
  const [input, setInput] = useState('')
  const save = (next: string[]): void => {
    window.notula.userContext.setNames({ firstNames: next }).catch((err: unknown) => showToast({ title: "Couldn't save", description: parseError(err).message, kind: 'error' }))
  }
  const add = (): void => {
    const parts = input
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
    if (!parts.length) return
    setInput('')
    save([...names, ...parts])
  }
  const full = names.length >= USER_CONTEXT_LIMITS.namesMax
  return (
    <>
      <Header title="Name dictionary" />
      <p className="uc-lead">First names of people you meet. Transcription listens for them, so they are spelled right. Up to {USER_CONTEXT_LIMITS.namesMax}.</p>
      <div className="uc-names__add">
        <input
          className="n-input"
          value={input}
          disabled={full}
          placeholder={full ? 'The dictionary is full' : 'Add names, separated by commas'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button type="button" className="n-btn n-btn--sm" disabled={!input.trim() || full} onClick={add}>
          Add
        </button>
      </div>
      {names.length === 0 ? (
        <p className="uc-muted">No names yet.</p>
      ) : (
        <ul className="uc-chips">
          {names.map((n) => (
            <li key={n} className="uc-chip">
              {n}
              <button type="button" className="uc-chip__remove" aria-label={`Remove ${n}`} onClick={() => save(names.filter((x) => x !== n))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function People({ state }: { state: UserContextState }): JSX.Element {
  const [q, setQ] = useState('')
  const people = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? state.people.filter((p) => p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle)) : state.people
  }, [q, state.people])
  return (
    <>
      <Header title="People" />
      <p className="uc-lead">The people from your meetings, most relevant first.</p>
      <input className="n-input uc-search" placeholder="Search people, companies, or relationships" value={q} onChange={(e) => setQ(e.target.value)} />
      {people.length === 0 ? (
        <p className="uc-muted">{state.people.length ? 'No one matches.' : 'People appear here once your meetings have attendees.'}</p>
      ) : (
        <ul className="uc-people">
          {people.map((p) => (
            <li key={p.email}>
              <button type="button" className="uc-person" onClick={() => navigate(`/person/${encodeURIComponent(p.email)}`)}>
                <span className="uc-person__name">{p.name}</span>
                <span className="uc-person__email">{p.email}</span>
                <span className="uc-person__meta">
                  {p.count} {p.count === 1 ? 'meeting' : 'meetings'} · last {dateLabel(p.lastSeenAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
