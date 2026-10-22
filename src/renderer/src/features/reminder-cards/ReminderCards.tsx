// SPDX-License-Identifier: Apache-2.0
// `#/reminder-cards`: one card at a time, bottom right.
//
// The window ignores the mouse except over the card. The card reports its height so main can
// size the window (`reminder-cards:resize`, capped by the work area). Actions go to main on
// `reminder-cards:action`; main runs
// drafts with the user's provider and never sends anything.

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { Reminder, ReminderAction, ReminderCardsState } from '@shared/types/reminder-cards'
import { debugLog } from '../../app/platform'
import { useSecondaryWindow } from '../bubble/secondary'
import '../live-context/live-context.css'
import './reminder-cards.css'

const KIND_LABEL: Record<Reminder['kind'], string> = {
  missing_invite: 'Invite waiting for you',
  no_meeting_link: 'Missing meeting details',
  attendees_absent: 'Still waiting',
  late_for_meeting: 'Running late',
  followup_drafts: 'Follow-up emails'
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d)
}

function ActionButton({ r, a, primary }: { r: Reminder; a: ReminderAction; primary: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const busy = a.kind === 'draft_block' && a.state === 'preparing'
  const label =
    a.kind === 'draft_block'
      ? busy
        ? 'Drafting…'
        : a.state === 'failed'
          ? 'Retry draft'
          : a.label
      : a.kind === 'copy' && copied
        ? 'Copied'
        : a.label
  return (
    <button
      type="button"
      className={`lc-btn${primary ? ' lc-btn--primary' : ''}`}
      disabled={busy || !!a.disabledReason}
      title={a.disabledReason ?? undefined}
      onClick={() => {
        window.notula.reminderCards.action({ reminderId: r.id, actionId: a.id })
        if (a.kind === 'copy') {
          setCopied(true)
          setTimeout(() => setCopied(false), 1_500)
        }
      }}
    >
      {label}
    </button>
  )
}

function Card({ r }: { r: Reminder }): JSX.Element {
  const draftAction = r.actions.find((a) => a.kind === 'draft_block')
  const draft = draftAction?.state === 'ready' ? draftAction.draft : null
  const main = r.actions.filter((a) => a.kind !== 'copy' && a.kind !== 'open_email' && !(a.kind === 'draft_block' && draft))
  const after = r.actions.filter((a) => a.kind === 'copy' || a.kind === 'open_email')
  const note = r.actions.find((a) => a.disabledReason && a.kind === 'draft_block')?.disabledReason ?? null
  return (
    <>
      <div className="lc-card__head">
        <span className={`lc-card__badge rc-badge rc-badge--${r.kind}`} aria-hidden="true" />
        <span className="lc-card__label">{KIND_LABEL[r.kind]}</span>
        <button
          type="button"
          className="lc-card__close"
          aria-label="Dismiss reminder"
          onClick={() => window.notula.reminderCards.action({ reminderId: r.id, actionId: 'dismiss' })}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      <p className="rc-title">{r.presentation.title}</p>
      {r.presentation.summary ? <p className="lc-card__muted">{r.presentation.summary}</p> : null}
      {r.context.clash ? (
        <p className="rc-clash">
          Clashes with {r.context.clash.title}
          {r.context.clash.start ? ` at ${timeLabel(r.context.clash.start)}` : ''}
        </p>
      ) : null}
      {r.kind === 'followup_drafts' ? <p className="lc-card__muted">Drafting takes a minute or two</p> : null}
      {draft ? (
        <div className="rc-draft">
          {draft.to.length ? <p className="rc-draft__to">To {draft.to.join(', ')}</p> : null}
          <p className="rc-draft__subject">{draft.subject}</p>
          <p className="rc-draft__body">{draft.body}</p>
        </div>
      ) : null}
      {draftAction?.state === 'failed' ? <p className="rc-error">Couldn’t write a draft. Try again.</p> : null}
      {note ? <p className="rc-error">{note}</p> : null}
      <div className="lc-actions rc-actions">
        {(draft ? after : main).map((a, i) => (
          <ActionButton key={a.id} r={r} a={a} primary={i === 0} />
        ))}
      </div>
    </>
  )
}

export function ReminderCardsRootView(): JSX.Element {
  useSecondaryWindow('notification')
  const [st, setSt] = useState<ReminderCardsState>({ card: null, sending: false })
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.title = 'Meeting reminders'
    void window.notula.reminderCards
      .getState()
      .then(setSt)
      .catch((err: unknown) => debugLog('reminder-cards:state-failed', { err: String(err) }))
    return window.notula.reminderCards.onCards(setSt)
  }, [])

  // The window follows the card's height.
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!el) return
    const report = (): void => window.notula.reminderCards.resize({ height: Math.ceil(el.offsetHeight) + 24 })
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [st.card?.id])

  useEffect(() => {
    if (!st.card) window.notula.reminderCards.setIgnoreMouse({ ignore: true })
  }, [st.card])

  return (
    <div className="rc-root">
      {st.card ? (
        <div
          ref={cardRef}
          className="lc-card rc-card"
          role="alertdialog"
          aria-label={st.card.presentation.title}
          onPointerEnter={() => window.notula.reminderCards.setIgnoreMouse({ ignore: false })}
          onPointerLeave={() => window.notula.reminderCards.setIgnoreMouse({ ignore: true })}
        >
          <Card key={st.card.id} r={st.card} />
        </div>
      ) : null}
    </div>
  )
}
