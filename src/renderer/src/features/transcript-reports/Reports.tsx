// SPDX-License-Identifier: Apache-2.0
// Local transcript reports: the header icon,
// the transcript menu items, the selection thumbs, the report popover, and "Reported problems (n)"
// with Delete and Export reports… . The thumbs and the report entry points need the Labs switch;
// the selection's Delete (retention) is always there.

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { TRANSCRIPT_REPORT_CATEGORIES, TRANSCRIPT_REPORT_LIMITS, type TranscriptReport, type TranscriptReportCategory } from '@shared/types/transcript-reports'
import { isMac } from '../../app/platform'
import { showToast } from '../../app/toast'
import { Modal } from '../folders/Modal'
import { SectionDeleteButton } from '../retention'
import { usePrefs } from '../settings/prefs-store'
import './reports.css'

const CATEGORY_LABEL = new Map(TRANSCRIPT_REPORT_CATEGORIES.map((c) => [c.value, c.label]))

// ---------- the per-note count ----------

const counts = new Map<string, number>()
const countListeners = new Set<() => void>()

function refreshCount(noteId: string): void {
  void window.notula.transcriptReport
    .list({ noteId })
    .then((r) => {
      counts.set(noteId, r.length)
      for (const l of countListeners) l()
    })
    .catch(() => undefined)
}

function useCount(noteId: string, enabled: boolean): number {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const l = (): void => tick((n) => n + 1)
    countListeners.add(l)
    refreshCount(noteId)
    return () => {
      countListeners.delete(l)
    }
  }, [noteId, enabled])
  return counts.get(noteId) ?? 0
}

function useEnabled(): boolean {
  return usePrefs()?.['transcriptReport.enabled'] === true
}

// ---------- the popover ----------

function ReportPopover({
  noteId,
  chunkIds,
  anchor,
  onClose
}: {
  noteId: string
  chunkIds?: string[]
  anchor: HTMLElement | null
  onClose(sent: boolean): void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [category, setCategory] = useState<TranscriptReportCategory | ''>('')
  const [comments, setComments] = useState('')
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const ranged = !!chunkIds?.length

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = anchor?.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const left = r ? Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8) : (window.innerWidth - w) / 2
    const below = r ? r.bottom + 6 : (window.innerHeight - h) / 2
    const top = r && below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below
    setPos({ top, left })
  }, [anchor])

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose(false)
    }
    const esc = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose(false)
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', esc)
    }
  }, [anchor, onClose])

  const submit = (): void => {
    if (busy) return
    if (!category) {
      setMissing(true)
      return
    }
    setBusy(true)
    setError(null)
    window.notula.transcriptReport
      .create({ noteId, category, comments: comments.trim(), ...(ranged ? { chunkIds } : {}) })
      .then(() => {
        showToast({ title: 'Problem saved.', kind: 'success' })
        refreshCount(noteId)
        onClose(true)
      })
      .catch(() => setError("Couldn’t save the report. Try again."))
      .finally(() => setBusy(false))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      ref={ref}
      className="tr-report"
      role="dialog"
      aria-label="Report a transcript problem"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      <h3 className="tr-report__title">{ranged ? "What’s wrong with this part of the transcript?" : "What's wrong with this transcript?"}</h3>
      <label className="tr-report__label" htmlFor="tr-report-type">
        Issue type
      </label>
      <select
        id="tr-report-type"
        className={`n-input tr-report__select${missing && !category ? ' is-invalid' : ''}`}
        value={category}
        autoFocus
        onChange={(e) => {
          setCategory(e.target.value as TranscriptReportCategory)
          setMissing(false)
        }}
      >
        <option value="" disabled>
          Choose an issue type
        </option>
        {TRANSCRIPT_REPORT_CATEGORIES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
      {missing && !category ? <p className="tr-report__error">Choose an issue type</p> : null}
      <label className="tr-report__label" htmlFor="tr-report-text">
        Problem description
      </label>
      <textarea
        id="tr-report-text"
        className="n-input tr-report__text"
        rows={3}
        maxLength={TRANSCRIPT_REPORT_LIMITS.commentsMax}
        placeholder="Optional: add details, like what was actually said"
        value={comments}
        onChange={(e) => setComments(e.target.value)}
      />
      {error ? (
        <p className="tr-report__error" role="alert">
          {error}
        </p>
      ) : null}
      <footer className="tr-report__actions">
        <span className="tr-report__kbd">{isMac ? '⌘⏎' : 'Ctrl+Enter'}</span>
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => onClose(false)}>
          Cancel
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={busy} onClick={submit}>
          {busy ? 'Sending...' : 'Report a transcript problem'}
        </button>
      </footer>
    </div>
  )
}

// ---------- the list ----------

function when(r: TranscriptReport): string {
  if (!r.start_timestamp || !r.end_timestamp) return 'Whole transcript'
  const f = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  return `${f(r.start_timestamp)} – ${f(r.end_timestamp)}`
}

function ReportsList({ noteId, onClose }: { noteId: string; onClose(): void }): JSX.Element {
  const [reports, setReports] = useState<TranscriptReport[] | null>(null)
  const [confirming, setConfirming] = useState(false)
  const load = (): void => {
    void window.notula.transcriptReport
      .list({ noteId })
      .then(setReports)
      .catch(() => setReports([]))
  }
  useEffect(load, [noteId])
  const remove = (id: string): void => {
    void window.notula.transcriptReport
      .delete({ id })
      .then(() => {
        load()
        refreshCount(noteId)
      })
      .catch(() => showToast({ title: "Couldn't delete the report.", kind: 'error' }))
  }
  const exportAll = (): void => {
    setConfirming(false)
    window.notula.transcriptReport
      .export({ noteId, confirmedPlaintext: true })
      .then((r) => {
        if ('path' in r) showToast({ title: 'Reports exported', description: r.path, kind: 'success' })
      })
      .catch(() => showToast({ title: "Couldn't export the reports.", kind: 'error' }))
  }
  return (
    <Modal label="Reported problems" onClose={onClose}>
      <div className="h-modal__body tr-list">
        <h2 className="h-modal__title">Reported problems</h2>
        <p className="h-modal__subtitle">Kept on this computer. Nothing is sent anywhere.</p>
        {reports === null ? (
          <div className="n-skeleton" style={{ height: 64 }} />
        ) : reports.length === 0 ? (
          <p className="tr-list__empty">No reports for this transcript.</p>
        ) : (
          <ul className="tr-list__items">
            {reports.map((r) => (
              <li key={r.id} className="tr-list__item">
                <div className="tr-list__head">
                  <strong>{CATEGORY_LABEL.get(r.category) ?? r.category}</strong>
                  <span className="tr-list__when">{when(r)}</span>
                  <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => remove(r.id)}>
                    Delete
                  </button>
                </div>
                {r.comments ? <p className="tr-list__comment">{r.comments}</p> : null}
              </li>
            ))}
          </ul>
        )}
        {confirming ? (
          <div className="tr-list__confirm" role="alert">
            <p>The export is a plain JSON file with the reported transcript text. Anyone who can open the file can read it.</p>
            <div className="tr-list__confirm-actions">
              <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="n-btn n-btn--sm n-btn--primary" onClick={exportAll}>
                Export as plain text
              </button>
            </div>
          </div>
        ) : null}
        <footer className="tr-list__actions">
          <button type="button" className="n-btn n-btn--ghost" disabled={!reports?.length} onClick={() => setConfirming(true)}>
            Export reports…
          </button>
          <button type="button" className="n-btn n-btn--primary" data-autofocus onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </Modal>
  )
}

// ---------- the mounts ----------

export function TranscriptReportButton({ noteId }: { noteId: string }): JSX.Element | null {
  const enabled = useEnabled()
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (!enabled) return null
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="nt-tr-icon"
        title="Report a transcript problem"
        aria-label="Report a transcript problem"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <FlagIcon />
      </button>
      {open ? <ReportPopover noteId={noteId} anchor={ref.current} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

export function TranscriptReportMenuItems({ noteId }: { noteId: string }): JSX.Element | null {
  const enabled = useEnabled()
  const n = useCount(noteId, enabled)
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState<'form' | 'list' | null>(null)
  if (!enabled) return null
  return (
    <span className="tr-menu">
      <span className="tr-menu__sep" aria-hidden="true" />
      <button ref={ref} type="button" className="tr-menu__item" onClick={() => setOpen(open === 'form' ? null : 'form')}>
        Report transcript issue
      </button>
      {n > 0 ? (
        <button type="button" className="tr-menu__item" onClick={() => setOpen('list')}>
          Reported problems ({n})
        </button>
      ) : null}
      {open === 'form' ? <ReportPopover noteId={noteId} anchor={ref.current} onClose={() => setOpen(null)} /> : null}
      {open === 'list' ? <ReportsList noteId={noteId} onClose={() => setOpen(null)} /> : null}
    </span>
  )
}

export function TranscriptSelectionActions({ noteId, chunkIds, onClear }: { noteId: string; chunkIds: string[]; onClear(): void }): JSX.Element | null {
  const enabled = useEnabled()
  const down = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <span className="tr-select">
      {enabled ? (
        <>
          <button
            type="button"
            className="tr-select__thumb"
            title="Good transcript"
            aria-label="Good transcript"
            onClick={() => {
              showToast({ title: 'Thanks for the feedback!' })
              onClear()
            }}
          >
            <ThumbIcon />
          </button>
          <button
            ref={down}
            type="button"
            className="tr-select__thumb tr-select__thumb--down"
            title="Report a transcript problem"
            aria-label="Report a transcript problem"
            onClick={() => setOpen(true)}
          >
            <ThumbIcon />
          </button>
        </>
      ) : null}
      <SectionDeleteButton noteId={noteId} chunkIds={chunkIds} onClear={onClear} />
      {open ? (
        <ReportPopover
          noteId={noteId}
          chunkIds={chunkIds}
          anchor={down.current}
          onClose={(sent) => {
            setOpen(false)
            if (sent) onClear()
          }}
        />
      ) : null}
    </span>
  )
}

function FlagIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 14V2.5M3.5 3h7.2l-1.4 2.6 1.4 2.6H3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function ThumbIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5 7v6.5H2.8V7H5Zm0 0 2.6-4.6c.9 0 1.6.7 1.5 1.6L8.8 6.5h3.6c.9 0 1.5.8 1.3 1.6l-1 4.3c-.2.6-.7 1.1-1.4 1.1H5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}
