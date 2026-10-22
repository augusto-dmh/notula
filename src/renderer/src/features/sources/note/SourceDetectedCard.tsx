// SPDX-License-Identifier: Apache-2.0
// The `source-detected` card's body, buttons and menu, drawn under the
// card's title in place of the generic actions row:
// - offer: the source line, "Not sure which video" for a guess, Take notes / Skip;
// - continue: the newest matching note and its last position, Continue / New note;
// - next: Switch note / Keep this note;
// - the first-use line (History and lookups) with Allow / Don't allow. The answer goes through
//   `sources:grant` and keeps the card open; until that handler exists it falls back to the
//   card actions `source:allow` / `source:not-now`;
// - the menu: Don't offer for <channel>, Don't offer for <site>, Source settings.
// Every other click goes through `act('source:<action>')`, which dismisses the card.

import { useEffect, useRef, useState, type JSX } from 'react'
import { formatPosition } from '@shared/lib/position'
import type { NotificationAction, NotificationPayload } from '@shared/types/notify'
import type { SourceCardAction, SourceCardPayload } from '@shared/types/sources'
import { isMissingHandler } from './source-store'
import './source-card.css'

interface Button {
  action: SourceCardAction
  label: string
  primary?: boolean
}

function buttonsFor(s: SourceCardPayload): Button[] {
  switch (s.mode) {
    case 'continue':
      return [
        { action: 'continue', label: 'Continue', primary: true },
        { action: 'new-note', label: 'New note' }
      ]
    case 'next':
      return [
        { action: 'switch-note', label: 'Switch note', primary: true },
        { action: 'keep-note', label: 'Keep this note' }
      ]
    case 'offer':
      return [
        { action: 'take-notes', label: 'Take notes', primary: true },
        { action: 'skip', label: 'Skip' }
      ]
  }
}

function menuFor(s: SourceCardPayload): { action: SourceCardAction; label: string; separatorBefore?: boolean }[] {
  const items: { action: SourceCardAction; label: string; separatorBefore?: boolean }[] = []
  if (s.channel) items.push({ action: 'mute-channel', label: `Don’t offer for ${s.channel}` })
  if (s.site) items.push({ action: 'mute-site', label: `Don’t offer for ${s.site}` })
  items.push({ action: 'settings', label: 'Source settings', separatorBefore: items.length > 0 })
  return items
}

function sourceLine(s: SourceCardPayload): string {
  return [s.channel, s.site].filter((x): x is string => !!x).join(' · ')
}

/** The first-use question; answered in place through `sources:grant`. */
function FirstUse({ onFallback }: { onFallback(action: 'allow' | 'not-now'): void }): JSX.Element | null {
  const [answer, setAnswer] = useState<'allowed' | 'declined' | null>(null)
  const [busy, setBusy] = useState(false)
  async function grant(allow: boolean): Promise<void> {
    setBusy(true)
    try {
      await window.notula.sources.grant({ readHistory: allow, onlineLookups: allow })
      setAnswer(allow ? 'allowed' : 'declined')
    } catch (err) {
      // Main's grant handler isn't there yet: the card action carries the answer.
      if (isMissingHandler(err)) onFallback(allow ? 'allow' : 'not-now')
      else setBusy(false)
    }
  }
  if (answer) {
    return (
      <p className="src-card__first src-card__first--done" role="status">
        {answer === 'allowed' ? 'Notula will find the exact link and details.' : 'You can turn this on in Source settings.'}
      </p>
    )
  }
  return (
    <div className="src-card__first" role="group" aria-label="Find the exact link and details">
      <p className="src-card__first-text">
        <strong>Find the exact link and details?</strong> Notula reads YouTube and course-site entries from this browser’s history on
        this computer, and asks YouTube about the videos you take notes on.
      </p>
      <div className="src-card__first-actions">
        <button type="button" className="src-card__btn src-card__btn--small" disabled={busy} onClick={() => void grant(true)}>
          Allow
        </button>
        <button type="button" className="src-card__btn src-card__btn--small src-card__btn--quiet" disabled={busy} onClick={() => void grant(false)}>
          Don’t allow
        </button>
      </div>
    </div>
  )
}

export function SourceDetectedCard({
  payload,
  act
}: {
  payload: NotificationPayload
  act: (action: NotificationAction) => void
}): JSX.Element | null {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const s = payload.source

  // Main keeps the card while its menu is open.
  useEffect(() => {
    window.notula.notify.setMenuOpen({ id: payload.id, open: menuOpen })
  }, [payload.id, menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  if (!s) return null
  const line = sourceLine(s)
  const run = (action: SourceCardAction): void => {
    setMenuOpen(false)
    act(`source:${action}`)
  }

  return (
    <div className="src-card" ref={rootRef}>
      <div className="src-card__source">
        <div className="src-card__title" title={s.title}>
          {s.mode === 'next' ? `Next: ${s.title}` : s.title}
        </div>
        {line ? <div className="src-card__meta">{line}</div> : null}
        {s.guess ? <div className="src-card__guess">Not sure which video</div> : null}
        {s.mode === 'continue' && s.noteTitle ? (
          <div className="src-card__meta" title={s.noteTitle}>
            {s.lastPositionMs !== null ? `“${s.noteTitle}”, last at ${formatPosition(s.lastPositionMs)}` : `“${s.noteTitle}”`}
          </div>
        ) : null}
      </div>
      {s.firstUse ? <FirstUse onFallback={(a) => run(a)} /> : null}
      <div className="src-card__actions">
        {buttonsFor(s).map((b) => (
          <button
            key={b.action}
            type="button"
            className={`src-card__btn${b.primary ? ' src-card__btn--primary' : ''}`}
            onClick={() => run(b.action)}
          >
            {b.label}
          </button>
        ))}
        <span className="src-card__more-wrap">
          <button
            type="button"
            className={`nt-note__more${menuOpen ? ' is-open' : ''}`}
            aria-label="More source actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="nt-note__menu" role="menu">
              {menuFor(s).map((item) => (
                <div key={item.action}>
                  {item.separatorBefore ? <div className="nt-note__sep" role="separator" /> : null}
                  <button type="button" role="menuitem" className="nt-note__item" onClick={() => run(item.action)}>
                    {item.label}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </span>
      </div>
    </div>
  )
}
