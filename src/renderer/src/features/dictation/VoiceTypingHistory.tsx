// SPDX-License-Identifier: Apache-2.0
// Settings ▸ Voice typing ▸ History (`voice-typing-history`, a hidden sub-page): dictations
// grouped by day (Today, Yesterday, then the date), each header with its count; columns Time
// and Dictation; a row menu with Copy and Delete; Retry on a failed row that kept its audio;
// Clear all behind a confirmation. It reads `dictation:history-list` and refreshes on
// `dictation:history-changed`. Clear all and Delete remove a dictation's text and audio.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { DictationAttempt } from '@shared/types/dictation'
import { parseError } from '@shared/errors'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { Modal } from '../folders/Modal'
import './voice-typing.css'

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

const countLabel = (n: number): string => `${n} ${n === 1 ? 'dictation' : 'dictations'}`

/** The rows' live list, or null while the first read is in flight. */
export function useDictationHistory(): DictationAttempt[] | null {
  const [rows, setRows] = useState<DictationAttempt[] | null>(null)
  useEffect(() => {
    let live = true
    const read = (): void => {
      void window.notula.dictation.history
        .list()
        .then((r) => live && setRows(r))
        .catch(() => live && setRows([]))
    }
    read()
    const off = window.notula.dictation.history.onChanged(read)
    return () => {
      live = false
      off()
    }
  }, [])
  return rows
}

function RowMenu({ a }: { a: DictationAttempt }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const copy = (): void => {
    setOpen(false)
    void navigator.clipboard.writeText(a.text ?? '').then(
      () => showToast({ id: 'dictation-copied', title: 'Copied to clipboard' }),
      () => showToast({ id: 'dictation-copied', kind: 'error', title: 'Couldn’t copy. Try again.' })
    )
  }
  const remove = (): void => {
    setOpen(false)
    void window.notula.dictation.history.delete({ id: a.id }).catch((err: unknown) => {
      showToast({ kind: 'error', title: parseError(err).message || 'Couldn’t delete this dictation.' })
    })
  }
  return (
    <div className="vt-menu" ref={ref}>
      <button type="button" className="vt-icon-btn" aria-label="Dictation options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open ? (
        <div className="vt-menu__list" role="menu">
          {a.text ? (
            <button type="button" role="menuitem" onClick={copy}>
              Copy
            </button>
          ) : null}
          <button type="button" role="menuitem" className="is-danger" onClick={remove}>
            Delete
          </button>
        </div>
      ) : null}
    </div>
  )
}

function HistoryRow({ a, interrupted }: { a: DictationAttempt; interrupted: boolean }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [retry, setRetry] = useState<'idle' | 'busy' | 'failed'>('idle')
  const time = new Date(a.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (!a.text) {
    const label = retry === 'failed' ? 'Retry failed' : interrupted ? 'Dictation interrupted' : 'Dictation failed'
    return (
      <li className="vt-hist__row">
        <span className="vt-hist__time">{time}</span>
        <span className="vt-hist__text vt-hist__text--muted">{label}</span>
        <span className="vt-hist__actions vt-hist__actions--shown">
          {a.has_audio ? (
            <button
              type="button"
              className="n-btn n-btn--sm"
              disabled={retry === 'busy'}
              onClick={() => {
                setRetry('busy')
                void window.notula.dictation.history.retry({ id: a.id }).then(
                  () => setRetry('idle'),
                  () => setRetry('failed')
                )
              }}
            >
              {retry === 'busy' ? 'Retrying…' : 'Retry'}
            </button>
          ) : null}
          <RowMenu a={a} />
        </span>
      </li>
    )
  }
  return (
    <li className="vt-hist__row">
      <span className="vt-hist__time">{time}</span>
      <button type="button" className={`vt-hist__text${expanded ? ' is-expanded' : ''}`} onClick={() => setExpanded(!expanded)}>
        {a.text}
      </button>
      <span className="vt-hist__actions">
        <RowMenu a={a} />
      </span>
    </li>
  )
}

export function VoiceTypingHistoryView(): JSX.Element {
  const rows = useDictationHistory()
  const [confirm, setConfirm] = useState(false)
  const opened = useRef(new Date().toISOString())
  useEffect(() => debugLog('voice-typing:history-opened'), [])
  const groups = useMemo(() => {
    const out: { label: string; items: DictationAttempt[] }[] = []
    for (const a of rows ?? []) {
      const label = dayLabel(a.created_at)
      const g = out[out.length - 1]
      if (g && g.label === label) g.items.push(a)
      else out.push({ label, items: [a] })
    }
    return out
  }, [rows])
  return (
    <section className="settings-group">
      <div className="vt-hist__head">
        <h2 className="settings-group__title">Dictations</h2>
        {rows && rows.length ? (
          <button type="button" className="n-btn n-btn--ghost n-btn--sm" onClick={() => setConfirm(true)}>
            Clear all
          </button>
        ) : null}
      </div>
      <div className="settings-card vt-hist">
        {rows === null ? null : rows.length === 0 ? (
          <p className="vt-hist__empty">No dictations yet. They appear here after you use voice typing.</p>
        ) : (
          <>
            <div className="vt-hist__cols" aria-hidden="true">
              <span className="vt-hist__time">Time</span>
              <span>Dictation</span>
            </div>
            {groups.map((g) => (
              <div key={g.label} className="vt-hist__group">
                <div className="vt-hist__day">
                  {g.label}
                  <span className="vt-hist__count">{countLabel(g.items.length)}</span>
                </div>
                <ul aria-label={`${g.label}, ${countLabel(g.items.length)}`}>
                  {g.items.map((a) => (
                    <HistoryRow key={a.id} a={a} interrupted={a.status === 'recording' && a.created_at < opened.current} />
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
      </div>
      {confirm ? (
        <Modal label="Clear history?" onClose={() => setConfirm(false)}>
          <div className="h-modal__body">
            <h2 className="h-modal__title">Clear history?</h2>
            <p className="h-modal__text">This removes the text and saved audio of every dictation in your history. You can’t undo this.</p>
            <div className="h-modal__footer">
              <button type="button" className="n-btn" data-autofocus onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="n-btn n-btn--danger"
                onClick={() => {
                  setConfirm(false)
                  void window.notula.dictation.history.clear({ confirmed: true }).catch((err: unknown) => {
                    showToast({ kind: 'error', title: parseError(err).message || 'Couldn’t clear the history.' })
                  })
                }}
              >
                Clear all
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </section>
  )
}
