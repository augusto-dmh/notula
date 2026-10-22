// SPDX-License-Identifier: Apache-2.0
// `#/live-context` and its Labs row.
//
// The card window is click-through except while the pointer is over the card. A loading answer
// shows the question and `Searching...`; a loading calendar card `Looking for a time slot...`; a
// ready calendar card the title, the start and `Open Calendar`; an answer its text, the retrieved
// context and the rating pair (a local debug line only).

import { useEffect, useState, type JSX } from 'react'
import type { LiveContextCard, LiveContextMode } from '@shared/types/live-context'
import { LOCAL_ONLY_COPY } from '@shared/types/local-only'
import { debugLog } from '../../app/platform'
import { useSecondaryWindow } from '../bubble/secondary'
import { SettingsRow } from '../settings/primitives'
import { Select } from '../settings/controls'
import { setPrefs, usePrefs } from '../settings/prefs-store'
import './live-context.css'

function Card({ card }: { card: LiveContextCard }): JSX.Element {
  const [showContext, setShowContext] = useState(true)
  const [rating, setRating] = useState<'good' | 'bad' | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  const rate = (r: 'good' | 'bad'): void => {
    setRating(r)
    window.notula.liveContext.rate({ cardId: card.id, rating: r })
  }
  const open = async (): Promise<void> => {
    try {
      const res = await window.notula.liveContext.openDraft({ cardId: card.id })
      if (!res.opened) setOpenError(res.reason === 'local-only' ? LOCAL_ONLY_COPY.blocked : res.reason === 'no-calendar' ? 'Connect a calendar first.' : 'Couldn’t open the calendar.')
    } catch (err) {
      debugLog('live-context:open-failed', { err: String(err) })
      setOpenError('Couldn’t open the calendar.')
    }
  }

  return (
    <>
      <div className="lc-card__head">
        <span className="lc-card__badge" aria-hidden="true" />
        <span className="lc-card__label">Live context</span>
        <button
          type="button"
          className="lc-card__close"
          aria-label="Dismiss live context notification"
          onClick={() => window.notula.liveContext.dismiss({ cardId: card.id })}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>

      {card.kind === 'search' && card.question ? <p className="lc-card__question">{card.question}</p> : null}

      {card.status === 'loading' ? (
        <p className="lc-card__muted lc-card__loading">{card.kind === 'calendar' ? 'Finding a free slot…' : 'Searching...'}</p>
      ) : null}

      {card.status === 'error' ? <p className="lc-card__muted">{card.errorMessage}</p> : null}

      {card.status === 'ready' && card.slot ? (
        <div className="lc-slot">
          <p className="lc-slot__title">{card.slot.title}</p>
          <p className="lc-card__muted">{card.answer}</p>
          <div className="lc-actions">
            <button type="button" className="lc-btn lc-btn--primary" onClick={() => void open()}>
              Open Calendar
            </button>
          </div>
          {openError ? <p className="lc-card__muted">{openError}</p> : null}
        </div>
      ) : null}

      {card.status === 'answered' ? (
        <>
          <p className="lc-card__answer">{card.answer}</p>
          {card.sources.length ? (
            <div className="lc-context">
              <button type="button" className="lc-link" onClick={() => setShowContext((v) => !v)}>
                {showContext ? 'Hide retrieved context' : 'Show retrieved context'}
              </button>
              {showContext ? (
                <ul className="lc-sources">
                  {card.sources.map((s) => (
                    <li key={s.noteId}>
                      <span className="lc-sources__title">{s.title ?? 'Untitled'}</span>
                      <span className="lc-sources__snippet">{s.snippet}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <div className="lc-actions lc-actions--rating">
            <button type="button" className={`lc-rate${rating === 'good' ? ' is-on' : ''}`} aria-label="Good answer" aria-pressed={rating === 'good'} onClick={() => rate('good')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 10v11M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 7A2 2 0 0 1 18.4 21H7V10l4.3-7.2a1.5 1.5 0 0 1 2.7.9z" />
              </svg>
            </button>
            <button type="button" className={`lc-rate${rating === 'bad' ? ' is-on' : ''}`} aria-label="Bad answer" aria-pressed={rating === 'bad'} onClick={() => rate('bad')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17 14V3M9 18.1 10 14H4.2a2 2 0 0 1-2-2.3l1.4-7A2 2 0 0 1 5.6 3H17v11l-4.3 7.2a1.5 1.5 0 0 1-2.7-.9z" />
              </svg>
            </button>
          </div>
        </>
      ) : null}
    </>
  )
}

export function LiveContextRootView(): JSX.Element {
  useSecondaryWindow('notification')
  const [card, setCard] = useState<LiveContextCard | null>(null)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    document.title = 'Live context'
    void window.notula.liveContext.getCard().then((c) => setCard(c)).catch(() => {})
    return window.notula.liveContext.onCard((c) => {
      if (c) {
        setLeaving(false)
        setCard(c)
      } else {
        // Main hides the window 400 ms later; let the card fade first.
        setLeaving(true)
        window.notula.liveContext.setIgnoreMouse({ ignore: true })
      }
    })
  }, [])

  if (!card) return <div className="lc-root" />
  return (
    <div className="lc-root">
      <div
        className={`lc-card${leaving ? ' is-leaving' : ''}`}
        role="status"
        aria-live="polite"
        onPointerEnter={() => window.notula.liveContext.setIgnoreMouse({ ignore: false })}
        onPointerLeave={() => window.notula.liveContext.setIgnoreMouse({ ignore: true })}
      >
        <Card key={card.id} card={card} />
      </div>
    </div>
  )
}

// ---------- Settings ▸ Labs ----------

export function LiveContextLabsRowView(): JSX.Element {
  const prefs = usePrefs()
  const mode = prefs?.['liveContext.mode'] ?? 'off'
  const [hasCalendar, setHasCalendar] = useState(false)
  const [localOnly, setLocalOnly] = useState(false)

  useEffect(() => {
    let live = true
    void window.notula.calendar
      .sources()
      .then((s) => live && setHasCalendar(s.sources.length > 0))
      .catch(() => {})
    void window.notula.privacy
      .localOnlyStatus()
      .then((s) => live && setLocalOnly(s.enabled))
      .catch(() => {})
    const off = window.notula.privacy.onLocalOnlyChanged((s) => setLocalOnly(s.enabled))
    return () => {
      live = false
      off()
    }
  }, [])

  const blocked = localOnly && prefs?.['llm.provider'] !== 'local'
  return (
    <>
      <SettingsRow
        title="Live context"
        description="While you transcribe, Notula listens for questions and scheduling talk and shows a card. Every finished speaker turn is sent to your AI provider, which can add up. A fast model works best."
        control={
          <Select<LiveContextMode>
            value={mode}
            label="Live context"
            disabled={!prefs || blocked}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'search', label: 'Answer questions from my notes' },
              { value: 'calendar', label: 'Suggest follow-up times', disabled: !hasCalendar }
            ]}
            onChange={(v) => setPrefs({ 'liveContext.mode': v })}
          />
        }
      />
      {blocked ? <p className="lc-labs__note">{LOCAL_ONLY_COPY.blocked}</p> : null}
      {!hasCalendar ? <p className="lc-labs__note">Connect a calendar to suggest follow-up times.</p> : null}
    </>
  )
}
