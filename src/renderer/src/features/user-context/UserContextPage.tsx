// SPDX-License-Identifier: Apache-2.0
// `/wiki` and `/wiki/:section`: Overview, the name dictionary and People. The Overview lists every
// profile section and the terms and projects tables as a compact row; a row opens its dialog
// (UserContextRowDialog), and `/wiki/<row>` opens the page with that dialog open. "Draft from my
// meetings" fills a section from recent notes through the user's own AI provider, never replacing
// what the user wrote without asking. Drafting turns on after 10 recorded meetings; once the
// profile has been drafted, the Overview's button refreshes the whole profile, keeping what the
// user wrote. The Overview also exports the profile as Markdown and shares it with apps
// connected to Notula's MCP server.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { McpLocalServerStatus } from '@shared/types/mcp'
import {
  USER_CONTEXT_LIMITS,
  USER_CONTEXT_SECTIONS,
  type UserContextAgent,
  type UserContextDraftEvent,
  type UserContextDraftStage,
  type UserContextEntry,
  type UserContextSectionId,
  type UserContextState
} from '@shared/types/user-context'
import { IconSparkle } from '../../app/icons'
import { navigate, navigateToSettings, useRoute } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import { confirmDialog } from '../templates/confirm'
import { dateLabel, FOLD_NOTE, isRowId, provenanceText, UnlockNote, UserContextRowDialog, type RowId } from './UserContextRowDialog'
import './user-context.css'

type Page = 'overview' | 'names' | 'people'

const PAGES: { id: Page; title: string }[] = [
  { id: 'overview', title: 'Overview' },
  { id: 'names', title: 'Name dictionary' },
  { id: 'people', title: 'People' }
]

const STAGES: Record<UserContextDraftStage, string> = {
  notes: 'Gathering your notes…',
  people: 'Looking at who you meet with…',
  writing: 'Writing your profile…'
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
  const param = params['section']
  // A row id opens the Overview with its dialog; an unknown id opens the plain Overview.
  const row: RowId | null = isRowId(param) ? param : null
  const page: Page = param === 'names' || param === 'people' ? param : 'overview'
  const [draft, setDraft] = useState<Draft | null>(null)
  const draftRef = useRef<Draft | null>(null)
  draftRef.current = draft

  // Closing a dialog lands back on its row.
  const lastRow = useRef<RowId | null>(null)
  useEffect(() => {
    if (row) {
      lastRow.current = row
      return
    }
    const back = lastRow.current
    lastRow.current = null
    if (back) document.querySelector<HTMLElement>(`[data-uc-row="${back}"]`)?.focus({ preventScroll: true })
  }, [row])

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
        else if (e.updated.length === 0 && e.rows === 0 && e.skippedUser.length === 0) showToast({ title: 'Nothing to add from your recent notes', kind: 'info' })
        else if (e.updated.length === 0 && e.rows === 0 && e.refreshedAt) showToast({ title: 'Kept your own text. Nothing else to add.', kind: 'info' })
        else if (e.updated.length === 0 && e.refreshedAt) showToast({ title: 'Your profile is ready — change anything you like.', kind: 'success' })
        else if (e.updated.length === 0) showToast({ title: 'Kept your own text. Nothing else to add.', kind: 'info' })
        else showToast({ title: 'Your profile is ready — change anything you like.', kind: 'success' })
        reload()
      }),
    [reload]
  )

  const startDraft = async (ids: UserContextSectionId[], overwriteUser: boolean): Promise<void> => {
    setDraft({ runId: null, sectionIds: ids, stage: null })
    try {
      const { runId } = await window.notula.userContext.draft({ sectionIds: ids, overwriteUser })
      setDraft((d) => (d ? { ...d, runId } : d))
    } catch (err) {
      setDraft(null)
      showToast({ title: "Couldn't draft your profile", description: parseError(err).message, kind: 'error' })
    }
  }

  /** The whole profile and both tables; what the user wrote stays as it is, so there's nothing to ask. */
  const startRefresh = async (): Promise<void> => {
    setDraft({ runId: null, sectionIds: emptyOrDrafted, stage: null })
    try {
      const { runId } = await window.notula.userContext.refresh()
      setDraft((d) => (d ? { ...d, runId } : d))
    } catch (err) {
      setDraft(null)
      showToast({ title: "Couldn't refresh your profile", description: parseError(err).message, kind: 'error' })
    }
  }

  /** The sections a refresh may write: every drafted one the user hasn't written. */
  const emptyOrDrafted = USER_CONTEXT_SECTIONS.filter((s) => s.drafted)
    .map((s) => s.id)
    .filter((id) => {
      const cur = state?.sections.find((x) => x.section_id === id)
      return !(cur && cur.origin === 'user' && cur.content.trim())
    })

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
            {draft?.stage ? (
              <p className="uc-stage" role="status">
                <span className="n-spinner" aria-hidden="true" />
                {STAGES[draft.stage]}
              </p>
            ) : null}
            {page === 'names' ? (
              <Names names={state.nameDictionary} />
            ) : page === 'people' ? (
              <People state={state} />
            ) : (
              <Overview state={state} drafting={!!draft} onRefresh={() => void startRefresh()} />
            )}
            {page === 'overview' && row ? (
              <UserContextRowDialog
                key={row}
                row={row}
                state={state}
                busy={!!draft}
                drafting={!!draft && row !== 'projects' && row !== 'terms' && draft.sectionIds.includes(row)}
                onDraft={(id, overwrite) => void startDraft([id], overwrite)}
                onClose={() => navigate('/wiki', { replace: true })}
              />
            ) : null}
          </div>
        )}
      </main>
    </div>
  )
}

function Header({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }): JSX.Element {
  return (
    <header className="uc-header">
      <div>
        <h2 className="uc-title">{title}</h2>
        {subtitle ? <p className="uc-subtitle">{subtitle}</p> : null}
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

function Overview(p: { state: UserContextState; drafting: boolean; onRefresh(): void }): JSX.Element {
  const prefs = usePrefs()
  const { drafted, lastAt } = p.state.refresh
  // Once drafted, a refresh no longer waits for the unlock.
  const locked = !drafted && p.state.unlock.recorded < p.state.unlock.needed
  const subtitle = lastAt ? `Last refreshed ${relativeLabel(lastAt)}` : 'Not drafted yet'
  return (
    <>
      <Header title="Overview" subtitle={subtitle}>
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void exportProfile('copy')}>
          Copy as Markdown
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => void exportProfile('save')}>
          Save as Markdown…
        </button>
        <button type="button" className="n-btn n-btn--sm" disabled={locked || p.drafting} onClick={p.onRefresh}>
          {p.drafting ? <span className="n-spinner" aria-hidden="true" /> : <IconSparkle size={14} />}
          {p.drafting ? (drafted ? 'Refreshing…' : 'Drafting…') : drafted ? 'Refresh profile' : 'Draft your profile'}
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
      <ul className="uc-rows" aria-label="Your profile">
        {USER_CONTEXT_SECTIONS.map((def) => {
          const sec = p.state.sections.find((x) => x.section_id === def.id)
          const text = sec?.content.trim() ?? ''
          return <ProfileRow key={def.id} id={def.id} title={def.title} preview={text || null} source={sec && text ? provenanceText(sec) : null} />
        })}
        <ProfileRow id="projects" title="Projects" {...tableSummary(p.state.projects, 'project', 'projects')} />
        <ProfileRow id="terms" title="Terms" {...tableSummary(p.state.terms, 'term', 'terms')} />
      </ul>
      <p className="uc-muted uc-fold">{FOLD_NOTE}</p>
      <Sharing />
    </>
  )
}

/** One row of the profile: its title, a one-line preview, and where the content came from. */
function ProfileRow(p: { id: RowId; title: string; preview: string | null; source: string | null }): JSX.Element {
  return (
    <li>
      <button type="button" className="uc-row" data-uc-row={p.id} onClick={() => navigate(`/wiki/${p.id}`, { replace: true })}>
        <span className="uc-row__title">{p.title}</span>
        <span className={`uc-row__preview${p.preview ? '' : ' is-empty'}`}>{p.preview ?? 'Empty'}</span>
        {p.source ? <span className="uc-row__source">{p.source}</span> : null}
      </button>
    </li>
  )
}

function tableSummary(rows: UserContextEntry[], one: string, many: string): { preview: string | null; source: string | null } {
  if (!rows.length) return { preview: null, source: null }
  const drafted = rows.filter((r) => r.origin === 'drafted').length
  return {
    preview: `${rows.length} ${rows.length === 1 ? one : many}: ${rows.map((r) => r.name).join(', ')}`,
    source: drafted === rows.length ? 'Drafted from your meetings' : drafted === 0 ? 'Written by you' : 'Drafted and written by you'
  }
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
