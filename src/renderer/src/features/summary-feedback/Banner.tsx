// SPDX-License-Identifier: Apache-2.0
// The rating banner and its comment box.
//
// - The banner is for the note's latest summary panel with content. Main decides eligibility
//   (once per note-page view and panel); when it says yes, the banner records "shown" and floats
//   above the dock while the note chat is closed.
// - A thumb sends the rating at once and opens the comment box; Submit sends the comment and
//   thanks for 1.5 s; Cancel keeps the rating; the close button dismisses the panel for good.
// - "Rate these notes" (panel menu) opens the same box without sampling.

import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { SUMMARY_FEEDBACK_LIMITS, type SummaryFeedbackDirection } from '@shared/types/summary-feedback'
import type { Panel } from '@shared/types/panels'
import { IconClose } from '../../app/icons'
import { debugLog, isMac } from '../../app/platform'
import { usePrefs } from '../settings/prefs-store'

/** "Rate these notes" asks the banner of that panel to open. */
const manualListeners = new Set<(panelId: string) => void>()

export function openRating(panelId: string): void {
  for (const l of manualListeners) l(panelId)
}

function latestWithContent(panels: Panel[]): Panel | null {
  let best: Panel | null = null
  for (const p of panels) {
    if (p.deleted_at || !(p.content_markdown ?? p.generated_content ?? '').trim()) continue
    if (!best || p.created_at > best.created_at) best = p
  }
  return best
}

function Thumb({ up, size = 15 }: { up: boolean; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g transform={up ? undefined : 'rotate(180 12 12)'}>
        <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0 4-7a2.5 2.5 0 0 1 2.5 2.7L13 10h5.6a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 17.3 21H7" />
      </g>
    </svg>
  )
}

type Phase = 'asking' | 'commenting' | 'thanked'

export function SummaryFeedbackBannerView({ noteId, chatIdle }: { noteId: string; chatIdle: boolean }): JSX.Element | null {
  const prefs = usePrefs()
  const enabled = prefs?.['summaryFeedback.enabled'] === true
  const [panelId, setPanelId] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [manual, setManual] = useState(false)
  const [phase, setPhase] = useState<Phase>('asking')
  const [direction, setDirection] = useState<SummaryFeedbackDirection | null>(null)
  const [leaving, setLeaving] = useState(false)
  const drawn = useRef(new Set<string>())

  // The latest panel with content; follows generations.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = (): void => {
      window.notula.panels
        .list({ noteId })
        .then((panels) => {
          if (!cancelled) setPanelId(latestWithContent(panels)?.id ?? null)
        })
        .catch(() => undefined)
    }
    load()
    const off = window.notula.notes.onChanged((c) => {
      if (c.tables.includes('note_panels')) load()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [noteId, enabled])

  // One draw per note-page view and panel.
  useEffect(() => {
    if (!enabled || !panelId || drawn.current.has(panelId)) return
    drawn.current.add(panelId)
    let cancelled = false
    window.notula.summaryFeedback
      .eligibility({ panelId })
      .then(({ show }) => {
        if (cancelled || !show) return
        setVisible(true)
        setPhase('asking')
        setDirection(null)
        void window.notula.summaryFeedback.shown({ panelId }).catch(() => undefined)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [panelId, enabled])

  useEffect(() => {
    const l = (id: string): void => {
      if (id !== panelId) {
        setPanelId(id)
        drawn.current.add(id)
      }
      setManual(true)
      setVisible(true)
      setLeaving(false)
      setPhase('commenting')
    }
    manualListeners.add(l)
    return () => {
      manualListeners.delete(l)
    }
  }, [panelId])

  const hide = useCallback(() => {
    setLeaving(true)
    setTimeout(() => {
      setVisible(false)
      setLeaving(false)
      setManual(false)
      setPhase('asking')
      setDirection(null)
    }, 180)
  }, [])

  if (!enabled || !visible || !panelId || (!chatIdle && !manual)) return null

  const rate = (d: SummaryFeedbackDirection): void => {
    setDirection(d)
    setPhase('commenting')
    window.notula.summaryFeedback.rate({ panelId, direction: d }).catch((err: unknown) => debugLog('summary-feedback:rate-failed', { err: String(err) }))
  }

  const dismiss = (): void => {
    if (!manual) window.notula.summaryFeedback.dismiss({ panelId }).catch((err: unknown) => debugLog('summary-feedback:dismiss-failed', { err: String(err) }))
    hide()
  }

  return (
    <div className={`sf-zone${leaving ? ' is-leaving' : ''}`}>
      {phase === 'commenting' ? (
        <CommentBox
          direction={direction}
          onPick={rate}
          onCancel={() => (manual && !direction ? hide() : setPhase('asking'))}
          onSubmit={async (comment) => {
            const d = direction
            if (!d) return
            try {
              await window.notula.summaryFeedback.rate({ panelId, direction: d, comment })
            } catch (err) {
              debugLog('summary-feedback:submit-failed', { err: String(err) })
            }
            setPhase('thanked')
            setTimeout(hide, SUMMARY_FEEDBACK_LIMITS.thanksMs)
          }}
        />
      ) : null}
      <div className="sf-banner" role="region" aria-label="Rate these notes">
        {phase === 'thanked' ? (
          <span className="sf-banner__text">Thanks for the feedback</span>
        ) : (
          <>
            <span className="sf-banner__text">How are these notes?</span>
            <button type="button" className={`sf-thumb${direction === 'positive' ? ' is-on' : ''}`} onClick={() => rate('positive')}>
              <Thumb up />
              Good
            </button>
            <button type="button" className={`sf-thumb${direction === 'negative' ? ' is-on' : ''}`} onClick={() => rate('negative')}>
              <Thumb up={false} />
              Not good
            </button>
            <button type="button" className="n-icon-btn n-icon-btn--sm" aria-label="Dismiss feedback prompt" onClick={dismiss}>
              <IconClose size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function CommentBox(p: {
  direction: SummaryFeedbackDirection | null
  onPick(d: SummaryFeedbackDirection): void
  onCancel(): void
  onSubmit(comment: string): Promise<void>
}): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [p.direction])
  const submit = (): void => {
    if (!text.trim() || busy || !p.direction) return
    setBusy(true)
    void p.onSubmit(text.trim()).finally(() => setBusy(false))
  }
  return (
    <div className="sf-box" role="dialog" aria-label="Feedback">
      {p.direction ? (
        <p className="sf-box__prompt">{p.direction === 'positive' ? 'What made these notes good?' : 'What should be better?'}</p>
      ) : (
        <div className="sf-box__pick">
          <span className="sf-box__prompt">How are these notes?</span>
          <button type="button" className="sf-thumb" onClick={() => p.onPick('positive')}>
            <Thumb up />
            Good
          </button>
          <button type="button" className="sf-thumb" onClick={() => p.onPick('negative')}>
            <Thumb up={false} />
            Not good
          </button>
        </div>
      )}
      <textarea
        ref={ref}
        className="n-input sf-box__input"
        rows={3}
        aria-label="Feedback"
        placeholder="What stood out?"
        value={text}
        disabled={!p.direction}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            p.onCancel()
          }
        }}
      />
      <p className="sf-box__note">Your feedback stays on this computer.</p>
      <div className="sf-box__actions">
        <button type="button" className="n-btn n-btn--sm n-btn--ghost" onClick={p.onCancel}>
          Cancel
        </button>
        <button type="button" className="n-btn n-btn--sm n-btn--primary" disabled={!text.trim() || busy || !p.direction} onClick={submit}>
          {busy ? 'Submitting...' : 'Submit'}
          {busy ? null : <span className="n-kbd sf-box__kbd">{isMac ? '⌘⏎' : 'Ctrl+Enter'}</span>}
        </button>
      </div>
    </div>
  )
}
