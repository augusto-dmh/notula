// SPDX-License-Identifier: Apache-2.0
// `/dispatches` and `/dispatches/archived`: Today's dispatches, the
// open to-dos by meeting, and the archive. Start opens a chat thread titled with the task and
// sends Notula's own "prepare this" message to it once.

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import type { ChatPlace } from '@shared/types/chat'
import type { Dispatch, DispatchList, DispatchTodo, DispatchTodoType } from '@shared/types/dispatch'
import { IconSparkle } from '../../app/icons'
import { navigate, useRoute } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { sendChat } from '../chat/store'
import { usePrefs } from '../settings/prefs-store'
import './dispatch.css'

type Tab = 'today' | 'todos' | 'archived'

const TYPE_LABEL: Record<DispatchTodoType, string> = { email: 'Email', slack: 'Slack', calendar: 'Calendar', todo: 'To-do' }
const PAUSED_LOCAL_ONLY = 'Paused while Nothing leaves this machine is on, unless you use a local AI model.'

function prepPrompt(d: Dispatch): string {
  const kind = d.type === 'email' ? 'an email draft' : d.type === 'slack' ? 'a Slack message draft' : 'a calendar event (title, time options, attendees and description)'
  return [
    `Prepare this for me: ${d.title}`,
    `What I need: ${kind}.`,
    `Task: ${d.task}`,
    d.source ? `From the meeting: ${d.source}` : '',
    '',
    'Use the meeting notes for the facts. Make it ready for me to review. Do not send or create anything yourself; if a tool would do that, ask me first.'
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n')
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export function DispatchesPageView(): JSX.Element {
  const { path } = useRoute()
  const prefs = usePrefs()
  const [tab, setTab] = useState<Tab>(path === '/dispatches/archived' ? 'archived' : 'today')
  const [list, setList] = useState<DispatchList | null>(null)
  const [todos, setTodos] = useState<DispatchTodo[]>([])
  const [running, setRunning] = useState(false)

  useEffect(() => setTab(path === '/dispatches/archived' ? 'archived' : (t) => (t === 'archived' ? 'today' : t)), [path])

  const reload = useCallback(() => {
    Promise.all([window.notula.dispatch.list({ view: tab }), tab === 'todos' ? null : window.notula.dispatch.list({ view: 'todos' })])
      .then(([l, t]) => {
        setList(l)
        setTodos(t ? t.todos : l.todos)
      })
      .catch((err: unknown) => showToast({ title: 'Dispatches could not be loaded', description: parseError(err).message, kind: 'error' }))
  }, [tab])

  useEffect(() => {
    reload()
    return window.notula.dispatch.onChanged(reload)
  }, [reload])

  const todoById = useMemo(() => new Map(todos.map((t) => [t.id, t])), [todos])

  const pick = (t: Tab): void => {
    setTab(t)
    if (t === 'archived') navigate('/dispatches/archived', { replace: true })
    else if (path !== '/dispatches') navigate('/dispatches', { replace: true })
  }

  const runNow = async (): Promise<void> => {
    setRunning(true)
    try {
      const r = await window.notula.dispatch.runMorning()
      if (r.status === 'busy') showToast({ title: 'The dispatcher is already running', kind: 'info' })
      else if (r.status === 'paused') showToast({ title: 'The dispatcher is paused', kind: 'info' })
    } catch (err) {
      showToast({ title: 'Couldn’t run the dispatcher', description: parseError(err).message, kind: 'error' })
    } finally {
      setRunning(false)
    }
  }

  const setStatus = (id: string, kind: 'todo' | 'dispatch', status: 'open' | 'done' | 'dismissed'): void => {
    window.notula.dispatch.setStatus({ id, kind, status }).catch((err: unknown) => showToast({ title: "Couldn't update", description: parseError(err).message, kind: 'error' }))
  }

  const start = async (d: Dispatch): Promise<void> => {
    try {
      const fresh = !d.thread_id
      const { threadId } = await window.notula.dispatch.start({ id: d.id })
      if (fresh || d.thread_id !== threadId) {
        const noteId = d.todo_id ? todoById.get(d.todo_id)?.document_id : null
        const place: ChatPlace = noteId ? { kind: 'meeting', noteId } : { kind: 'global' }
        const r = await sendChat({ surfaceId: 'dispatches', surface: 'fullscreen', place, threadId, text: prepPrompt(d) })
        if (!r.ok) showToast({ title: `Started "${d.title}"`, description: r.error, kind: 'error' })
      }
      navigate(`/chat/${threadId}`)
    } catch (err) {
      showToast({ title: `Couldn’t start "${d.title}"`, description: parseError(err).message, kind: 'error' })
    }
  }

  const actionItemsOff = prefs?.['actionItems.enabled'] !== true
  const status = list?.status
  const openTodos = todos.filter((t) => t.status === 'open').length
  const statusWord = status ? { extracting: 'extracting…', ready: 'ready', waiting: 'waiting', unavailable: 'unavailable' }[status.todos] : ''
  const lastRun = status?.lastRun
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  return (
    <div className="ds-column">
      <header className="ds-header">
        <div>
          <h1 className="ds-title">Dispatches</h1>
          <p className="ds-status">
            Dispatcher to-dos · {statusWord} · {openTodos} {openTodos === 1 ? 'task' : 'tasks'}
          </p>
        </div>
        <button type="button" className="n-btn n-btn--sm" disabled={running || actionItemsOff || status?.todos === 'unavailable'} onClick={() => void runNow()}>
          {running ? <span className="n-spinner" aria-hidden="true" /> : <IconSparkle size={14} />}
          Run now
        </button>
      </header>
      {actionItemsOff ? <p className="ds-notice">Paused: the dispatcher works from action items. Turn on Action items in Settings ▸ Labs.</p> : null}
      {!actionItemsOff && status?.todos === 'unavailable' ? <p className="ds-notice">{PAUSED_LOCAL_ONLY}</p> : null}
      {status?.failedNotes.length ? (
        <p className="ds-notice ds-notice--warn">Dispatcher extraction failed: {status.failedNotes.map((n) => n.title || 'New note').join(', ')}</p>
      ) : null}
      {lastRun && lastRun.day === todayKey && lastRun.archived > 0 && tab === 'today' ? (
        <p className="ds-muted">
          Archived {lastRun.archived} {lastRun.archived === 1 ? 'dispatch' : 'dispatches'} from this morning's previous run
        </p>
      ) : null}
      {lastRun && lastRun.day === todayKey && (lastRun.status === 'discarded' || lastRun.status === 'error' || lastRun.status === 'interrupted') && tab === 'today' ? (
        <p className="ds-muted">This morning's run didn't finish: {lastRun.reason ?? lastRun.status}.</p>
      ) : null}
      <div className="ds-tabs" role="tablist">
        {(['today', 'todos', 'archived'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className="ds-tab" onClick={() => pick(t)}>
            {t === 'today' ? 'Today' : t === 'todos' ? 'To-dos' : 'Archived'}
          </button>
        ))}
      </div>
      {!list ? (
        <div className="ds-skeleton" aria-busy="true">
          {[60, 75, 45].map((w) => (
            <div key={w} className="n-skeleton" style={{ width: `${w}%`, height: 14 }} />
          ))}
        </div>
      ) : tab === 'todos' ? (
        <TodoList todos={todos} onStatus={(id, s) => setStatus(id, 'todo', s)} />
      ) : list.dispatches.length === 0 ? (
        <p className="ds-empty">{tab === 'today' ? 'Nothing to start yet. The dispatcher picks a few to-dos each morning, or when you run it.' : 'No archived dispatches.'}</p>
      ) : (
        <ul className="ds-list">
          {list.dispatches.map((d) => (
            <li key={d.id} className={`ds-row${d.status === 'done' ? ' is-done' : ''}`}>
              <div className="ds-row__main">
                <div className="ds-row__top">
                  {d.label ? <span className="ds-label">{d.label}</span> : null}
                  <span className={`ds-type ds-type--${d.type}`}>{TYPE_LABEL[d.type]}</span>
                  <span className="ds-row__title">{d.title}</span>
                </div>
                <p className="ds-row__task">{d.task}</p>
                <p className="ds-row__meta">
                  {d.source || 'Your meetings'}
                  {d.reason ? ` · ${d.reason}` : ''}
                  {tab === 'archived' ? ` · ${dayLabel(d.run_day)}` : ''}
                </p>
              </div>
              {tab === 'today' ? (
                <div className="ds-row__actions">
                  <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setStatus(d.id, 'dispatch', d.status === 'done' ? 'open' : 'done')}>
                    {d.status === 'done' ? 'Mark not done' : 'Mark done'}
                  </button>
                  <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={() => void start(d)}>
                    {d.thread_id ? 'Open' : 'Start'}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TodoList({ todos, onStatus }: { todos: DispatchTodo[]; onStatus(id: string, s: 'open' | 'done' | 'dismissed'): void }): JSX.Element {
  const groups = useMemo(() => {
    const out: { key: string; title: string; at: string | null; items: DispatchTodo[] }[] = []
    for (const t of todos) {
      const key = t.document_id ?? 'none'
      let g = out.find((x) => x.key === key)
      if (!g) {
        g = { key, title: t.meeting_title || 'New note', at: t.meeting_at, items: [] }
        out.push(g)
      }
      g.items.push(t)
    }
    return out
  }, [todos])
  if (todos.length === 0) return <p className="ds-empty">No to-dos yet. Your own open action items appear here once they are sorted.</p>
  return (
    <div>
      {groups.map((g) => (
        <section key={g.key} className="ds-group">
          <header className="ds-group__header">
            <span className="ds-group__title">{g.title}</span>
            {g.at ? <span className="ds-group__date">{new Date(g.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span> : null}
          </header>
          <ul className="ds-list">
            {g.items.map((t) => (
              <li key={t.id} className={`ds-row${t.status === 'done' ? ' is-done' : ''}`}>
                <div className="ds-row__main">
                  <div className="ds-row__top">
                    <span className={`ds-type ds-type--${t.type}`}>{TYPE_LABEL[t.type]}</span>
                    <span className="ds-row__title">{t.title}</span>
                  </div>
                  <p className="ds-row__task">{t.task}</p>
                </div>
                <div className="ds-row__actions">
                  {t.status === 'open' ? (
                    <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => onStatus(t.id, 'dismissed')}>
                      Dismiss
                    </button>
                  ) : null}
                  <button type="button" className="n-btn n-btn--sm" onClick={() => onStatus(t.id, t.status === 'done' ? 'open' : 'done')}>
                    {t.status === 'done' ? 'Mark not done' : 'Mark done'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
