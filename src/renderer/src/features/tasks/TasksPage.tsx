// SPDX-License-Identifier: Apache-2.0
// `/tasks`: the list of checkbox items from the user's recent
// summaries plus manual tasks on the left, and the selected task's chat on the right.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { parseError } from '@shared/errors'
import type { ManualTask, TaskGroup, TaskItem, TasksList } from '@shared/types/tasks'
import { IconClose, IconSparkle } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { showToast } from '../../app/toast'
import { ChatMarkdown } from '../chat'
import { ChatSurfaceView } from '../chat/ChatSurface'
import { loadThread } from '../chat/store'
import { clearRun, runPrompt, sendFirst, taskKey, taskPlace, taskSubtitle, taskTitle, useRuns, type SelectedTask } from './run'
import './tasks.css'

const SURFACE_ID = 'tasks-pane'

function sameTask(a: SelectedTask | null, b: SelectedTask): boolean {
  return !!a && taskKey(a) === taskKey(b)
}

function useTasks(showCompleted: boolean, includeOlder: boolean): { list: TasksList | null; error: string | null; reload(): void } {
  const [list, setList] = useState<TasksList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const reload = useCallback(() => {
    const n = ++seq.current
    window.notula.tasks
      .list({ showCompleted, includeOlder })
      .then((l) => {
        if (n !== seq.current) return
        setList(l)
        setError(null)
      })
      .catch((err: unknown) => {
        if (n === seq.current) setError(parseError(err).message || 'Tasks could not be loaded.')
      })
  }, [showCompleted, includeOlder])
  useEffect(() => {
    reload()
    return window.notula.tasks.onChanged(() => reload())
  }, [reload])
  return { list, error, reload }
}

export function TasksPageView(): JSX.Element {
  const [showCompleted, setShowCompleted] = useState(false)
  const [includeOlder, setIncludeOlder] = useState(false)
  const { list, error, reload } = useTasks(showCompleted, includeOlder)
  const [selected, setSelected] = useState<SelectedTask | null>(null)
  const [draft, setDraft] = useState('')
  const runs = useRuns()

  const toggle = useCallback(
    (t: SelectedTask, checked: boolean) => {
      const req =
        t.kind === 'manual'
          ? { kind: 'manual' as const, id: t.task.id, checked }
          : { kind: 'meeting' as const, documentId: t.item.documentId, panelId: t.item.panelId, nodePath: t.item.nodePath, checked }
      window.notula.tasks
        .toggle(req)
        .catch((err: unknown) => showToast({ title: 'The task could not be updated', description: parseError(err).message, kind: 'error' }))
        .finally(reload)
    },
    [reload]
  )

  const add = (): void => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    window.notula.tasks.add({ text }).catch((err: unknown) => {
      setDraft(text)
      showToast({ title: 'The task could not be added', description: parseError(err).message, kind: 'error' })
    })
  }

  const remove = (task: ManualTask): void => {
    if (selected?.kind === 'manual' && selected.task.id === task.id) setSelected(null)
    window.notula.tasks.delete({ id: task.id }).catch((err: unknown) => showToast({ title: 'The task could not be deleted', description: parseError(err).message, kind: 'error' }))
  }

  const run = useCallback((t: SelectedTask) => {
    setSelected(t)
    sendFirst(t, runPrompt(t)).catch((err: unknown) => showToast({ title: 'The task could not run', description: (err as Error).message, kind: 'error' }))
  }, [])

  const empty = list && list.manual.length === 0 && list.groups.length === 0 && list.olderCount === 0

  return (
    <div className="tk-page">
      <section className="tk-list" aria-label="Tasks">
        <header className="tk-list__header">
          <h1 className="tk-title">Tasks</h1>
          <label className="tk-check-label">
            <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
            Show completed
          </label>
        </header>
        <input
          className="n-input tk-add"
          placeholder="Add a task…"
          value={draft}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        {error ? (
          <div className="tk-empty" role="alert">
            <p>{error}</p>
            <button type="button" className="n-btn n-btn--sm" onClick={reload}>
              Try again
            </button>
          </div>
        ) : !list ? (
          <div className="tk-skeleton" aria-busy="true" aria-label="Loading tasks">
            {[70, 55, 80, 40].map((w) => (
              <div key={w} className="n-skeleton" style={{ width: `${w}%`, height: 14 }} />
            ))}
          </div>
        ) : empty ? (
          <div className="tk-empty">
            <p className="tk-empty__title">No tasks yet</p>
            <p className="tk-empty__hint">Add a task above, then ask the AI to help you get it done.</p>
          </div>
        ) : (
          <div className="tk-scroll">
            {list.manual.length ? (
              <div className="tk-group">
                <div className="tk-group__header">
                  <span className="tk-group__title">My tasks</span>
                </div>
                {list.manual.map((task) => {
                  const t: SelectedTask = { kind: 'manual', task }
                  return (
                    <Row
                      key={task.id}
                      task={t}
                      checked={task.checked}
                      selected={sameTask(selected, t)}
                      streaming={runs.get(taskKey(t))?.status === 'streaming'}
                      onSelect={() => setSelected(t)}
                      onToggle={(c) => toggle(t, c)}
                      onRun={() => run(t)}
                      onDelete={() => remove(task)}
                    />
                  )
                })}
              </div>
            ) : null}
            {list.groups.map((g) => (
              <Group key={g.documentId} group={g} selected={selected} runs={runs} onSelect={setSelected} onToggle={toggle} onRun={run} />
            ))}
            {list.olderCount > 0 && !includeOlder ? (
              <button type="button" className="n-btn n-btn--ghost n-btn--sm tk-older" onClick={() => setIncludeOlder(true)}>
                Show {list.olderCount} more from older meetings
              </button>
            ) : null}
          </div>
        )}
      </section>
      <section className="tk-pane" aria-label="Task">
        {selected ? <TaskPane key={taskKey(selected)} task={selected} onRun={() => run(selected)} /> : <p className="tk-pane__none">Pick a task to open it here</p>}
      </section>
    </div>
  )
}

function Group(p: {
  group: TaskGroup
  selected: SelectedTask | null
  runs: ReturnType<typeof useRuns>
  onSelect(t: SelectedTask): void
  onToggle(t: SelectedTask, checked: boolean): void
  onRun(t: SelectedTask): void
}): JSX.Element {
  const { group } = p
  const date = new Date(group.meetingAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return (
    <div className="tk-group">
      <div className="tk-group__header">
        <button type="button" className="tk-group__title tk-group__link" onClick={() => navigate(`/meeting/${group.documentId}`)}>
          {group.title || 'New note'}
        </button>
        <span className="tk-group__date">{date}</span>
      </div>
      {group.items.map((item: TaskItem) => {
        const t: SelectedTask = { kind: 'meeting', item, group }
        return (
          <Row
            key={`${item.panelId}:${item.nodePath.join('.')}`}
            task={t}
            checked={item.checked}
            selected={sameTask(p.selected, t)}
            streaming={p.runs.get(taskKey(t))?.status === 'streaming'}
            onSelect={() => p.onSelect(t)}
            onToggle={(c) => p.onToggle(t, c)}
            onRun={() => p.onRun(t)}
          />
        )
      })}
    </div>
  )
}

function Row(p: {
  task: SelectedTask
  checked: boolean
  selected: boolean
  streaming: boolean
  onSelect(): void
  onToggle(checked: boolean): void
  onRun(): void
  onDelete?(): void
}): JSX.Element {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      p.onSelect()
    }
  }
  return (
    <div
      className={`tk-row${p.selected ? ' is-selected' : ''}${p.checked ? ' is-checked' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={p.selected}
      onClick={p.onSelect}
      onKeyDown={onKeyDown}
    >
      <input
        type="checkbox"
        className="tk-row__check"
        checked={p.checked}
        aria-label={p.checked ? 'Mark as not done' : 'Mark as done'}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => p.onToggle(e.target.checked)}
      />
      <span className="tk-row__text">{taskTitle(p.task)}</span>
      <span className="tk-row__actions">
        {p.streaming ? (
          <span className="n-spinner tk-row__spinner" aria-label="Running" />
        ) : (
          <button
            type="button"
            className="n-btn n-btn--sm tk-row__run"
            onClick={(e) => {
              e.stopPropagation()
              p.onRun()
            }}
          >
            Run
          </button>
        )}
        {p.onDelete ? (
          <button
            type="button"
            className="n-icon-btn n-icon-btn--sm tk-row__delete"
            aria-label="Delete task"
            onClick={(e) => {
              e.stopPropagation()
              p.onDelete?.()
            }}
          >
            <IconClose size={13} />
          </button>
        ) : null}
      </span>
    </div>
  )
}

function TaskPane({ task, onRun }: { task: SelectedTask; onRun(): void }): JSX.Element {
  const key = taskKey(task)
  const runs = useRuns()
  const live = runs.get(key) ?? null
  const [threadId, setThreadId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [text, setText] = useState('')
  const place = useMemo(() => taskPlace(task), [task])

  // The newest thread of the task's group.
  useEffect(() => {
    let cancelled = false
    window.notula.chat
      .listThreads({ groupingKey: key })
      .then((threads) => {
        if (cancelled) return
        const newest = [...threads].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
        if (newest) {
          setThreadId(newest.id)
          void loadThread(newest.id)
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
    return () => {
      cancelled = true
    }
  }, [key])

  // A run's first answer streams here; once stored, the chat surface takes over that thread.
  useEffect(() => {
    if (!live?.threadId) return
    if (live.threadId !== threadId) setThreadId(live.threadId)
    if (live.status === 'done') {
      void loadThread(live.threadId).then(() => clearRun(key))
    }
  }, [live?.threadId, live?.status, key, threadId])

  const streaming = live?.status === 'streaming'
  const hasRun = !!threadId || !!live
  const showLive = !!live && (live.status === 'streaming' || live.status === 'error')

  const ask = (): void => {
    const t = text.trim()
    if (!t) return
    setText('')
    sendFirst(task, t).catch((err: unknown) => showToast({ title: 'Couldn’t send the message. Try again.', description: (err as Error).message, kind: 'error' }))
  }

  return (
    <div className="tk-detail">
      <header className="tk-detail__header">
        <div className="tk-detail__titles">
          <h2 className="tk-detail__title">{taskTitle(task)}</h2>
          <p className="tk-detail__subtitle">{taskSubtitle(task)}</p>
        </div>
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={streaming} onClick={onRun}>
          <IconSparkle size={14} />
          {hasRun ? 'Run again' : 'Run'}
        </button>
      </header>
      <div className="tk-detail__chat">
        {showLive ? (
          <div className="tk-live">
            {live.text ? <ChatMarkdown markdown={live.text} /> : null}
            {live.status === 'streaming' ? (
              <p className="tk-live__working">
                <span className="n-spinner" aria-hidden="true" /> {live.working ? 'Working on it…' : 'Writing…'}
              </p>
            ) : null}
            {live.status === 'error' ? (
              <div className="tk-live__error" role="alert">
                <span>{live.error || 'Something went wrong.'}</span>
                <button type="button" className="n-btn n-btn--sm" onClick={onRun}>
                  Try again
                </button>
              </div>
            ) : null}
          </div>
        ) : threadId ? (
          <ChatSurfaceView
            surfaceId={SURFACE_ID}
            surface="sidebar"
            place={place}
            threadId={threadId}
            compact
            empty={<p className="tk-pane__hint">Ask for help with this task, like drafting a reply or planning next steps.</p>}
          />
        ) : loaded ? (
          <div className="tk-start">
            <p className="tk-pane__hint">Ask for help with this task, like drafting a reply or planning next steps.</p>
            <div className="tk-start__composer">
              <textarea
                className="n-input tk-start__input"
                rows={2}
                placeholder="Ask about this task…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    ask()
                  }
                }}
              />
              <button type="button" className="n-btn n-btn--sm" disabled={!text.trim()} onClick={ask}>
                Send
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
