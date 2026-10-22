// SPDX-License-Identifier: Apache-2.0
// `/action-items`: every open action item across
// meetings, with Keep / Dismiss / Archive, and "Regenerate all" with a side-by-side
// compare before anything is replaced.

import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { parseError } from '@shared/errors'
import type { ActionItem, ActionItemReview, ActionItemsRegenerateEvent, RegeneratedActionItem } from '@shared/types/action-items'
import type { NoteListItem } from '@shared/types/notes'
import { IconCheck, IconClose, IconRestart } from '../../app/icons'
import { navigate } from '../../app/navigation'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { useActionItems } from './store'
import './action-items.css'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function IconArchive({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" />
      <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
    </svg>
  )
}

function meetingDate(n: NoteListItem | undefined): string {
  if (!n) return ''
  const d = new Date(n.sort_epoch * 1000)
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
    : ''
}

/** Titles and dates of the source meetings, one `notes:list` call per change of the set. */
function useMeetings(ids: string[]): Map<string, NoteListItem> {
  const [map, setMap] = useState<Map<string, NoteListItem>>(new Map())
  const key = [...new Set(ids)].sort().join(',')
  useEffect(() => {
    if (!key) return
    let alive = true
    window.notula.notes
      .list({ scope: 'own', ids: key.split(',') })
      .then((page) => {
        if (alive) setMap(new Map(page.items.map((n) => [n.id, n])))
      })
      .catch((err: unknown) => debugLog('action-items-meetings-failed', { err: parseError(err) }))
    return () => {
      alive = false
    }
  }, [key])
  return map
}

type Regen =
  | { phase: 'idle' }
  | { phase: 'running'; runId: string | null; completed: number; total: number }
  | { phase: 'compare'; runId: string; items: RegeneratedActionItem[]; sourceIds: string[] }

export function ActionItemsPage(): JSX.Element {
  const { state, reload, patch } = useActionItems({})
  const items = state.status === 'ready' ? state.items : []
  const open = items.filter((i) => i.archivedAt === null)
  const [regen, setRegen] = useState<Regen>({ phase: 'idle' })
  const [applying, setApplying] = useState(false)
  const meetings = useMeetings([
    ...items.map((i) => i.sourceNoteId ?? '').filter(Boolean),
    ...(regen.phase === 'compare' ? regen.sourceIds : [])
  ])

  // Events can arrive before the invoke's reply: keep them per run until the id is known.
  const buffered = useRef(new Map<string, ActionItemsRegenerateEvent[]>())
  const runRef = useRef<string | null>(null)
  const handle = useCallback((e: ActionItemsRegenerateEvent): void => {
    if (e.type === 'ready') setRegen({ phase: 'running', runId: e.runId, completed: 0, total: e.total })
    else if (e.type === 'progress') setRegen({ phase: 'running', runId: e.runId, completed: e.completed, total: e.total })
    else if (e.type === 'complete') {
      runRef.current = null
      setRegen({ phase: 'compare', runId: e.runId, items: e.items, sourceIds: e.sourceNoteIds })
      showToast({
        id: 'ai-regenerated',
        kind: 'success',
        title: `Regenerated ${e.items.length} action items from ${e.sourceNoteIds.length} meetings`
      })
    } else if (e.type === 'error') {
      runRef.current = null
      setRegen({ phase: 'idle' })
      showToast({ id: 'ai-regenerate-failed', kind: 'error', title: 'Couldn’t regenerate action items. Try again.' })
    }
  }, [])
  useEffect(
    () =>
      window.notula.actionItems.onRegenerateProgress((e) => {
        if (runRef.current === e.runId) return handle(e)
        const list = buffered.current.get(e.runId) ?? []
        list.push(e)
        buffered.current.set(e.runId, list)
      }),
    [handle]
  )

  const canRegenerate = open.some((i) => i.sourceNoteId !== null)
  const startRegenerate = async (): Promise<void> => {
    if (regen.phase !== 'idle' || !canRegenerate) return
    const total = new Set(open.map((i) => i.sourceNoteId).filter(Boolean)).size
    setRegen({ phase: 'running', runId: null, completed: 0, total })
    try {
      const { runId } = await window.notula.actionItems.regeneratePreview()
      runRef.current = runId
      for (const e of buffered.current.get(runId) ?? []) handle(e)
      buffered.current.clear()
    } catch (err) {
      debugLog('action-items-regenerate-failed', { err: parseError(err) })
      setRegen({ phase: 'idle' })
      showToast({ id: 'ai-regenerate-failed', kind: 'error', title: 'Couldn’t regenerate action items. Try again.' })
    }
  }

  const keepRegenerated = async (): Promise<void> => {
    if (regen.phase !== 'compare' || applying) return
    setApplying(true)
    try {
      const { insertedCount } = await window.notula.actionItems.applyRegenerated({ runId: regen.runId })
      showToast({ id: 'ai-kept', kind: 'success', title: `Kept ${insertedCount} regenerated action items` })
      setRegen({ phase: 'idle' })
      void reload()
    } catch (err) {
      debugLog('action-items-apply-failed', { err: parseError(err) })
      showToast({ id: 'ai-kept-failed', kind: 'error', title: 'Couldn’t keep the new action items. Try again.' })
    } finally {
      setApplying(false)
    }
  }

  // ---------- review and archive, optimistic with rollback ----------

  const review = (item: ActionItem, reviewStatus: ActionItemReview): void => {
    const before = item
    patch((list) => list.map((i) => (i.id === item.id ? { ...i, reviewStatus, reviewedAt: new Date().toISOString() } : i)))
    window.notula.actionItems.review({ id: item.id, reviewStatus }).catch((err: unknown) => {
      debugLog('action-items-review-failed', { err: parseError(err) })
      patch((list) => list.map((i) => (i.id === before.id ? before : i)))
      showToast({ id: 'ai-review-failed', kind: 'error', title: 'Couldn’t save that change. Try again.' })
    })
  }

  const archive = (item: ActionItem): void => {
    const before = item
    patch((list) => list.map((i) => (i.id === item.id ? { ...i, archivedAt: new Date().toISOString() } : i)))
    window.notula.actionItems.archive({ id: item.id }).catch((err: unknown) => {
      debugLog('action-items-archive-failed', { err: parseError(err) })
      patch((list) => list.map((i) => (i.id === before.id ? before : i)))
      showToast({ id: 'ai-archive-failed', kind: 'error', title: 'Couldn’t archive the action item. Try again.' })
    })
  }

  const comparing = regen.phase === 'compare'
  // The router frames the page (back bar and scroll, FramedPage): only the column is drawn here.
  return (
    <div className={`ai-page__column${comparing ? ' ai-page__column--wide' : ''}`}>
      <header className="ai-page__header">
        <div>
          <h1 className="ai-page__title">Action Items</h1>
          <p className="ai-page__count">{comparing ? 'Compare old and new' : state.status === 'ready' ? plural(open.length, 'item', 'items') : ' '}</p>
        </div>
        <div className="ai-page__actions">
          {comparing ? (
            <>
              <button type="button" className="n-btn n-btn--sm" disabled={applying} onClick={() => setRegen({ phase: 'idle' })}>
                Keep current
              </button>
              <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={applying} onClick={() => void keepRegenerated()}>
                Keep new versions
              </button>
            </>
          ) : (
            <button type="button" className="n-btn n-btn--sm" disabled={!canRegenerate || regen.phase === 'running'} onClick={() => void startRegenerate()}>
              {regen.phase === 'running' ? (
                <>
                  <span className="n-spinner ai-page__spinner" aria-hidden="true" />
                  Regenerating {regen.completed}/{regen.total}
                </>
              ) : (
                <>
                  <IconRestart size={14} />
                  Regenerate all
                </>
              )}
            </button>
          )}
        </div>
      </header>

      {state.status === 'loading' ? (
        <ListSkeleton />
      ) : state.status === 'error' ? (
        <div className="ai-empty" role="alert">
          <p>Couldn’t load action items.</p>
          <button type="button" className="n-btn n-btn--sm" onClick={() => void reload()}>
            Try again
          </button>
        </div>
      ) : comparing ? (
        <div className="ai-compare">
          <CompareColumn title="Current" empty="No current action items.">
            {open.map((i) => (
              <PreviewRow key={i.id} intent={i.intent} detail={i.detail} meeting={meetings.get(i.sourceNoteId ?? '')} />
            ))}
          </CompareColumn>
          <CompareColumn title="Regenerated" empty="No regenerated action items.">
            {regen.items.map((i, n) => (
              <PreviewRow key={`preview-${i.sourceNoteId}-${n}`} intent={i.intent} detail={i.detail} meeting={meetings.get(i.sourceNoteId)} />
            ))}
          </CompareColumn>
        </div>
      ) : open.length === 0 ? (
        <div className="ai-empty">
          <p>No action items found.</p>
          <p className="ai-empty__hint">Action items appear here after a meeting’s notes are generated.</p>
        </div>
      ) : (
        <ul className="ai-list">
          {open.map((item) => (
            <ItemRow key={item.id} item={item} meeting={meetings.get(item.sourceNoteId ?? '')} onReview={review} onArchive={archive} />
          ))}
        </ul>
      )}
    </div>
  )
}

function ListSkeleton(): JSX.Element {
  return (
    <div className="ai-list ai-list--skeleton" aria-busy="true" aria-label="Loading action items">
      {[78, 64, 86, 52].map((w) => (
        <div key={w} className="ai-row ai-row--skeleton">
          <div className="n-skeleton" style={{ width: `${w}%`, height: 14 }} />
          <div className="n-skeleton" style={{ width: '30%', height: 11, marginTop: 8 }} />
        </div>
      ))}
    </div>
  )
}

function Meta({ meeting, item }: { meeting: NoteListItem | undefined; item?: ActionItem }): JSX.Element | null {
  const names = item?.attribution.map((a) => a.name).filter(Boolean) ?? []
  if (!meeting && names.length === 0) return null
  return (
    <div className="ai-row__meta">
      {names.length ? <span className="ai-row__owners">{names.join(', ')}</span> : null}
      {names.length && meeting ? <span aria-hidden="true">·</span> : null}
      {meeting ? (
        <span className="ai-row__meeting">
          {meeting.title?.trim() || 'Untitled meeting'}
          {meetingDate(meeting) ? ` · ${meetingDate(meeting)}` : ''}
        </span>
      ) : null}
    </div>
  )
}

function ItemRow({
  item,
  meeting,
  onReview,
  onArchive
}: {
  item: ActionItem
  meeting: NoteListItem | undefined
  onReview(item: ActionItem, r: ActionItemReview): void
  onArchive(item: ActionItem): void
}): JSX.Element {
  const openSource = (): void => {
    if (item.sourceNoteId) navigate(`/meeting/${encodeURIComponent(item.sourceNoteId)}`)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    openSource()
  }
  const reviewed = item.reviewStatus !== null
  return (
    <li className={`ai-row${item.reviewStatus === 'dismissed' ? ' is-dismissed' : ''}${reviewed ? ' is-reviewed' : ''}`}>
      <div className="ai-row__main" role={item.sourceNoteId ? 'link' : undefined} tabIndex={item.sourceNoteId ? 0 : -1} onClick={openSource} onKeyDown={onKeyDown}>
        <span className="ai-row__bullet" aria-hidden="true" />
        <div className="ai-row__text">
          <div className="ai-row__intent">{item.intent}</div>
          {item.detail ? <div className="ai-row__detail">{item.detail}</div> : null}
          <Meta meeting={meeting} item={item} />
        </div>
      </div>
      <div className="ai-row__actions">
        <span className="n-tooltip n-tooltip--end" data-tooltip="Keep as useful">
          <button
            type="button"
            className={`n-icon-btn n-icon-btn--sm ai-row__btn${item.reviewStatus === 'kept' ? ' is-kept' : ''}`}
            aria-label="Keep action item"
            aria-pressed={item.reviewStatus === 'kept'}
            onClick={() => onReview(item, 'kept')}
          >
            <IconCheck size={15} />
          </button>
        </span>
        <span className="n-tooltip n-tooltip--end" data-tooltip="Dismiss as not useful">
          <button
            type="button"
            className={`n-icon-btn n-icon-btn--sm ai-row__btn${item.reviewStatus === 'dismissed' ? ' is-dismissed' : ''}`}
            aria-label="Dismiss action item"
            aria-pressed={item.reviewStatus === 'dismissed'}
            onClick={() => onReview(item, 'dismissed')}
          >
            <IconClose size={15} />
          </button>
        </span>
        {reviewed ? (
          <span className="n-tooltip n-tooltip--end" data-tooltip="Archive this action item">
            <button type="button" className="n-icon-btn n-icon-btn--sm ai-row__btn" aria-label="Archive action item" onClick={() => onArchive(item)}>
              <IconArchive />
            </button>
          </span>
        ) : null}
      </div>
    </li>
  )
}

function CompareColumn({ title, empty, children }: { title: string; empty: string; children: JSX.Element[] }): JSX.Element {
  return (
    <section className="ai-compare__column" aria-label={title}>
      <header className="ai-compare__head">
        <span className="ai-compare__title">{title}</span>
        <span className="ai-compare__count">{plural(children.length, 'item', 'items')}</span>
      </header>
      {children.length ? <ul className="ai-list ai-list--preview">{children}</ul> : <p className="ai-compare__empty">{empty}</p>}
    </section>
  )
}

function PreviewRow({ intent, detail, meeting }: { intent: string; detail: string | null; meeting: NoteListItem | undefined }): JSX.Element {
  return (
    <li className="ai-row ai-row--preview">
      <div className="ai-row__main">
        <span className="ai-row__bullet" aria-hidden="true" />
        <div className="ai-row__text">
          <div className="ai-row__intent">{intent}</div>
          {detail ? <div className="ai-row__detail">{detail}</div> : null}
          <Meta meeting={meeting} />
        </div>
      </div>
    </li>
  )
}
