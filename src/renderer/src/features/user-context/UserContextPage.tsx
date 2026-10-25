// SPDX-License-Identifier: Apache-2.0
// `/wiki` and `/wiki/:section`: Overview, the sections, the name dictionary and People. Every
// section is an editable text box with its provenance; "Draft from my meetings" fills it from
// recent notes through the user's own AI provider, never replacing what the user wrote without
// asking. Drafting turns on after 10 recorded meetings, and a section that is never drafted is
// listed only while it holds text. The Overview also exports the profile as Markdown and shares
// it with apps connected to Notula's MCP server.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { McpLocalServerStatus } from '@shared/types/mcp'
import {
  USER_CONTEXT_LIMITS,
  USER_CONTEXT_SECTIONS,
  type UserContextAgent,
  type UserContextDraftEvent,
  type UserContextDraftStage,
  type UserContextSection,
  type UserContextSectionId,
  type UserContextState
} from '@shared/types/user-context'
import { IconSparkle } from '../../app/icons'
import { navigate, navigateToSettings, useRoute } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import { confirmDialog } from '../templates/confirm'
import './user-context.css'

type Page = 'overview' | UserContextSectionId | 'names' | 'people'

const DRAFTED = new Set<UserContextSectionId>(USER_CONTEXT_SECTIONS.filter((s) => s.drafted).map((s) => s.id))

/**
 * The pages in the navigation. A section that is never drafted is listed while it holds text,
 * and while it is open, so clearing it doesn't move the page away.
 */
function pagesFor(state: UserContextState | null, open: string | undefined): { id: Page; title: string }[] {
  const has = (id: UserContextSectionId): boolean => !!state?.sections.find((x) => x.section_id === id)?.content.trim()
  return [
    { id: 'overview', title: 'Overview' },
    ...USER_CONTEXT_SECTIONS.filter((s) => s.drafted || s.id === open || has(s.id)).map((s) => ({ id: s.id as Page, title: s.title })),
    { id: 'names', title: 'Name dictionary' },
    { id: 'people', title: 'People' }
  ]
}

const STAGES: Record<UserContextDraftStage, string> = {
  notes: 'Gathering your notes…',
  people: 'Looking at who you meet with…',
  writing: 'Writing your profile…'
}

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
  stage: UserContextDraftStage | null
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "5 minutes ago", "yesterday", in the user's locale. */
function relativeLabel(iso: string): string {
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12]
  ]
  let value = (Date.parse(iso) - Date.now()) / 1_000
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return relative.format(Math.round(value), unit)
    value /= size
  }
  return relative.format(Math.round(value), 'year')
}

export function UserContextPageView(): JSX.Element {
  const { params } = useRoute()
  const { state, error, reload } = useUserContext()
  const pages = pagesFor(state, params['section'])
  const page = (pages.some((p) => p.id === params['section']) ? params['section'] : 'overview') as Page
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
        if (e.type === 'stage') {
          setDraft({ ...d, stage: e.stage })
          return
        }
        setDraft(null)
        if (e.type === 'error') showToast({ title: e.message, kind: 'error' })
        else if (e.updated.length === 0 && e.skippedUser.length === 0) showToast({ title: 'Nothing to add from your recent notes', kind: 'info' })
        else if (e.updated.length === 0) showToast({ title: 'Kept your own text. Nothing else to add.', kind: 'info' })
        else showToast({ title: 'Your profile is ready — change anything you like.', kind: 'success' })
        reload()
      }),
    [reload]
  )

  const startDraft = async (ids: UserContextSectionId[], overwriteUser: boolean): Promise<void> => {
    setConfirm(null)
    setDraft({ runId: null, sectionIds: ids, stage: null })
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

  const emptyIds = USER_CONTEXT_SECTIONS.filter((s) => s.drafted)
    .map((s) => s.id)
    .filter((id) => !state?.sections.find((x) => x.section_id === id)?.content.trim())

  return (
    <div className="uc-page">
      <nav className="uc-nav" aria-label="Wiki">
        <h1 className="uc-nav__title">Wiki</h1>
        {pages.map((p) => (
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
            {draft?.stage ? (
              <p className="uc-stage" role="status">
                <span className="n-spinner" aria-hidden="true" />
                {STAGES[draft.stage]}
              </p>
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
                draftable={DRAFTED.has(page)}
                unlock={state.unlock}
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

async function exportProfile(action: 'copy' | 'save'): Promise<void> {
  try {
    const r = await window.notula.userContext.export({ action })
    if ('markdown' in r) {
      await window.notula.clipboard.writeText({ text: r.markdown })
      showToast({ id: 'uc-export', title: 'Copied', kind: 'success' })
    } else if (r.saved) {
      showToast({ id: 'uc-export', title: 'Saved as Markdown', kind: 'success' })
    }
  } catch (err) {
    showToast({
      id: 'uc-export',
      title: action === 'copy' ? 'Couldn’t copy your profile' : 'Couldn’t save your profile',
      description: parseError(err).message,
      kind: 'error'
    })
  }
}

/** Before drafting turns on: how many recorded meetings so far, as a ring. */
function UnlockNote({ unlock }: { unlock: UserContextState['unlock'] }): JSX.Element {
  const r = 9
  const length = 2 * Math.PI * r
  const done = Math.min(1, unlock.recorded / unlock.needed)
  return (
    <div className="uc-unlock">
      <svg className="uc-unlock__ring" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r={r} className="uc-unlock__track" />
        <circle cx="12" cy="12" r={r} className="uc-unlock__done" strokeDasharray={`${done * length} ${length}`} transform="rotate(-90 12 12)" />
      </svg>
      <div>
        <p className="uc-unlock__count">
          {unlock.recorded} of {unlock.needed} meetings recorded
        </p>
        <p className="uc-unlock__text">Notula can draft your profile after {unlock.needed} recorded meetings. You can write it yourself now.</p>
      </div>
    </div>
  )
}

function Overview(p: { state: UserContextState; drafting: boolean; emptyIds: UserContextSectionId[]; onDraftAll(): void }): JSX.Element {
  const prefs = usePrefs()
  const locked = p.state.unlock.recorded < p.state.unlock.needed
  const filled = USER_CONTEXT_SECTIONS.map((def) => ({ def, s: p.state.sections.find((x) => x.section_id === def.id) })).filter((x) => x.s?.content.trim())
  return (
    <>
      <Header title="Overview">
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void exportProfile('copy')}>
          Copy as Markdown
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void exportProfile('save')}>
          Save as Markdown…
        </button>
        <button type="button" className="n-btn n-btn--sm" disabled={locked || p.drafting || p.emptyIds.length === 0} onClick={p.onDraftAll}>
          {p.drafting ? <span className="n-spinner" aria-hidden="true" /> : <IconSparkle size={14} />}
          {p.drafting ? 'Drafting…' : 'Draft all empty sections'}
        </button>
      </Header>
      {locked ? <UnlockNote unlock={p.state.unlock} /> : null}
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
      <Sharing />
    </>
  )
}

/** "Use with other AI apps": the switch for `readAboutMe`, the server address and the apps that read the profile. */
function Sharing(): JSX.Element {
  const prefs = usePrefs()
  const [server, setServer] = useState<McpLocalServerStatus | null>(null)
  const [agents, setAgents] = useState<UserContextAgent[]>([])

  const readAgents = useCallback(() => {
    window.notula.userContext
      .agents()
      .then(setAgents)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void window.notula.mcpServer
      .getStatus()
      .then(setServer)
      .catch(() => undefined)
    readAgents()
    const offServer = window.notula.mcpServer.onChanged(setServer)
    const offChanged = window.notula.userContext.onChanged(readAgents)
    return () => {
      offServer()
      offChanged()
    }
  }, [readAgents])

  const serverOn = !!server?.enabled && server.listening
  const copyAddress = (): void => {
    if (!server?.url) {
      navigateToSettings('connectors')
      return
    }
    window.notula.clipboard
      .writeText({ text: server.url })
      .then(() => showToast({ id: 'uc-address', title: 'Copied', kind: 'success' }))
      .catch(() => showToast({ id: 'uc-address', title: 'Couldn’t copy the address', kind: 'error' }))
  }

  const setPaused = (a: UserContextAgent, paused: boolean): void => {
    setAgents((list) => list.map((x) => (x.tokenId === a.tokenId ? { ...x, paused } : x)))
    window.notula.userContext.setAgentPaused({ tokenId: a.tokenId, paused }).catch((err: unknown) => {
      showToast({ title: 'Couldn’t change access', description: parseError(err).message, kind: 'error' })
      readAgents()
    })
  }

  const remove = async (a: UserContextAgent): Promise<void> => {
    const ok = await confirmDialog({
      title: `Remove ${a.name}?`,
      body: 'It loses its connection to Notula, including your notes. To use it again, connect it in Settings ▸ Connectors.',
      confirmLabel: 'Remove app',
      danger: true
    })
    if (!ok) return
    try {
      await window.notula.mcpServer.revokeToken({ id: a.tokenId })
      readAgents()
    } catch (err) {
      showToast({ title: 'Couldn’t remove the app', description: parseError(err).message, kind: 'error' })
    }
  }

  return (
    <section className="uc-share" aria-labelledby="uc-share-title">
      <h3 id="uc-share-title" className="uc-share__title">
        Use with other AI apps
      </h3>
      <label className="uc-switch">
        <input
          type="checkbox"
          checked={prefs?.['userContext.shareWithAgents'] === true}
          onChange={(e) => setPrefs({ 'userContext.shareWithAgents': e.target.checked })}
        />
        Let apps connected to Notula read this profile
      </label>
      {serverOn ? (
        <div className="uc-share__server">
          <button type="button" className="n-btn n-btn--sm" onClick={copyAddress}>
            Copy server address
          </button>
        </div>
      ) : (
        <div className="uc-share__server">
          <p className="uc-muted">Turn on Notula’s MCP server to connect an app.</p>
          <button type="button" className="n-btn n-btn--sm" onClick={() => navigateToSettings('connectors')}>
            Open Connectors
          </button>
        </div>
      )}
      {agents.length === 0 ? (
        <p className="uc-muted">Apps appear here once they’ve read your profile.</p>
      ) : (
        <>
          <p className="uc-muted">Pausing keeps an app connected but stops it from reading your profile until you switch it back.</p>
          <ul className="uc-agents">
            {agents.map((a) => (
              <li key={a.tokenId} className="uc-agent">
                <span className="uc-agent__name">{a.name}</span>
                <span className="uc-agent__meta">Read {relativeLabel(a.lastReadAt)}</span>
                <select
                  className="n-input uc-agent__access"
                  aria-label={`Access for ${a.name}`}
                  value={a.paused ? 'paused' : 'read'}
                  onChange={(e) => setPaused(a, e.target.value === 'paused')}
                >
                  <option value="read">Can read</option>
                  <option value="paused">Paused</option>
                </select>
                <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void remove(a)}>
                  Remove app…
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function Provenance({ section }: { section: UserContextSection }): JSX.Element {
  return (
    <p className="uc-prov">
      {section.origin === 'drafted' && section.drafted_at ? `Drafted from your meetings · Saved ${dateLabel(section.updated_at)}` : 'Written by you'}
    </p>
  )
}

function SectionEditor(p: {
  id: UserContextSectionId
  section: UserContextSection | null
  drafting: boolean
  busy: boolean
  /** False for a section only the user writes: no draft button. */
  draftable: boolean
  unlock: UserContextState['unlock']
  onDraft(): void
}): JSX.Element {
  const title = USER_CONTEXT_SECTIONS.find((s) => s.id === p.id)!.title
  const locked = p.unlock.recorded < p.unlock.needed
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
        {p.draftable ? (
          <button type="button" className="n-btn n-btn--sm" disabled={p.busy || locked} onClick={p.onDraft}>
            {p.drafting ? <span className="n-spinner" aria-hidden="true" /> : <IconSparkle size={14} />}
            {p.drafting ? 'Drafting…' : 'Draft from my meetings'}
          </button>
        ) : null}
      </Header>
      {p.draftable && locked ? <UnlockNote unlock={p.unlock} /> : null}
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
