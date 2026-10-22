// SPDX-License-Identifier: Apache-2.0
// The summary-line thumbs' data and their feedback form.
// Mounted by the enhanced view while a summary is shown and `actionItems.enabled` is on:
// it feeds the editor's thumbs with the note's items and opens the form at the click.
// Feedback is stored locally (`action_item_feedback`); the highlighted direction of
// an unlinked line is remembered in memory for the session.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { debugLog } from '../../app/platform'
import { showToast } from '../../app/toast'
import { setActionItemThumbs, type ThumbClick, type ThumbDirection } from '../../editor'
import { usePrefs } from '../settings/prefs-store'
import { useActionItems } from './store'
import './action-items.css'

const EDGE = 8

/**
 * The direction given on unlinked lines this session. It lives in memory only, keyed by
 * the line's text, so no note text is written to disk outside the encrypted database
 * (the feedback row itself is stored).
 */
const lineDirections = new Map<string, ThumbDirection>()

function lineKey(panelId: string, heading: string, item: string): string {
  return JSON.stringify([panelId, heading, item])
}

function readLine(panelId: string, heading: string, item: string): ThumbDirection | null {
  return lineDirections.get(lineKey(panelId, heading, item)) ?? null
}

function writeLine(panelId: string, heading: string, item: string, d: ThumbDirection): void {
  lineDirections.set(lineKey(panelId, heading, item), d)
}

export function ActionItemThumbs({ noteId }: { noteId: string }): JSX.Element | null {
  const prefs = usePrefs()
  const enabled = prefs?.['actionItems.enabled'] === true
  const { state, patch } = useActionItems(enabled ? { noteIds: [noteId], includeArchived: true } : null)
  const [form, setForm] = useState<ThumbClick | null>(null)
  const [, bump] = useState(0)
  const items = state.status === 'ready' ? state.items : null

  const directions = useMemo(() => {
    const m = new Map<string, ThumbDirection | null>()
    for (const i of items ?? []) m.set(i.id, i.feedback[0]?.direction ?? null)
    return m
  }, [items])

  useEffect(() => {
    if (!enabled || !items) {
      setActionItemThumbs(null)
      return
    }
    setActionItemThumbs({
      items: directions,
      unlinkedDirection: readLine,
      onThumb: (click) => setForm(click)
    })
    return () => setActionItemThumbs(null)
  }, [enabled, items, directions])

  if (!form) return null
  return (
    <FeedbackForm
      click={form}
      onClose={() => setForm(null)}
      onSaved={(saved) => {
        if (form.actionItemId) {
          patch((list) => list.map((i) => (i.id === form.actionItemId ? { ...i, feedback: [saved, ...i.feedback] } : i)))
        } else if (form.headingText) {
          writeLine(form.panelId, form.headingText, form.itemText, form.direction)
          bump((n) => n + 1)
          setActionItemThumbs({ items: directions, unlinkedDirection: readLine, onThumb: (click) => setForm(click) })
        }
        setForm(null)
      }}
    />
  )
}

function FeedbackForm({
  click,
  onClose,
  onSaved
}: {
  click: ThumbClick
  onClose(): void
  onSaved(f: Awaited<ReturnType<typeof window.notula.actionItems.feedback>>): void
}): JSX.Element {
  const ref = useRef<HTMLFormElement>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = click.x - w / 2
    let top = click.y + 12
    if (top + h > window.innerHeight - EDGE) top = click.y - h - 12
    left = Math.max(EDGE, Math.min(left, window.innerWidth - w - EDGE))
    top = Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE))
    setPos({ left, top })
    el.querySelector('textarea')?.focus()
  }, [click])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [onClose])

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const feedback = text.trim() || null
    try {
      const saved = click.actionItemId
        ? await window.notula.actionItems.feedback({ actionItemId: click.actionItemId, direction: click.direction, feedback })
        : await window.notula.actionItems.feedback({
            panelId: click.panelId,
            headingText: click.headingText ?? '',
            itemText: click.itemText,
            direction: click.direction,
            feedback
          })
      onSaved(saved)
      showToast({ id: 'ai-feedback', kind: 'success', title: 'Thanks for the feedback' })
    } catch (err) {
      debugLog('action-items-feedback-failed', { err: parseError(err) })
      showToast({ id: 'ai-feedback-failed', kind: 'error', title: 'Couldn’t save your feedback' })
      setBusy(false)
    }
  }

  return (
    <form
      ref={ref}
      className="ai-feedback"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      aria-label="Action item feedback"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void submit()
        }
      }}
    >
      <label className="ai-feedback__prompt" htmlFor="ai-feedback-text">
        Was this action item useful?
      </label>
      <textarea
        id="ai-feedback-text"
        className="n-input ai-feedback__text"
        rows={3}
        maxLength={4_000}
        placeholder="Optional: what was wrong or missing."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="ai-feedback__actions">
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="n-btn n-btn--sm n-btn--primary" disabled={busy}>
          Submit
        </button>
      </div>
    </form>
  )
}
