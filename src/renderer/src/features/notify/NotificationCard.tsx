// SPDX-License-Identifier: Apache-2.0
// The v1 notification card. It slides in
// from the right, swipes right past 100 px to dismiss, shows a close button on hover,
// and runs a 20 s countdown that pauses on hover (detected and auto-starting cards).
// Every action dismisses it; main animates it out and destroys the window.

import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent } from 'react'
import type { NotificationAction, NotificationPayload } from '@shared/types/notify'
import meetIcon from '../../../../../resources/join-google-meet@2x.png'
import teamsIcon from '../../../../../resources/join-teams@2x.png'
import zoomIcon from '../../../../../resources/join-zoom@2x.png'
import { useSecondaryWindow } from '../bubble/secondary'
import { LastTimeRecap } from '../recurring-recap'
import { SourceDetectedCard } from '../sources'
import './notify.css'

const SWIPE_DISMISS_PX = 100
const TICK_MS = 100

/**
 * The meeting's provider: `conferenceProvider` is the normalized provider name. Google
 * Meet shows as "Meet"; Zoom, Google Meet and Microsoft Teams have their own icon, and
 * any other provider gets the app's.
 */
function providerOf(p: NotificationPayload['conferenceProvider']): { label: string; icon: string | null } | null {
  const name = p?.trim()
  if (!name) return null
  switch (name.toLowerCase()) {
    case 'google meet':
      return { label: 'Meet', icon: meetIcon }
    case 'zoom':
      return { label: 'Zoom', icon: zoomIcon }
    case 'microsoft teams':
      return { label: 'Microsoft Teams', icon: teamsIcon }
    default:
      return { label: name, icon: null }
  }
}

interface MenuItem {
  label: string
  action: NotificationAction
  separatorBefore?: boolean
}

/** The meeting actions, a separator, then the notification settings. */
function menuItems(p: NotificationPayload, autoStarting: boolean): MenuItem[] {
  const items: MenuItem[] = []
  if (p.variant === 'scheduled-meeting' && p.joinUrl) items.push({ label: 'Join Meeting', action: 'join_meeting' })
  if (autoStarting) items.push({ label: 'Cancel', action: 'hide' })
  items.push({ label: 'Open Notula', action: 'start_note' })
  const settings: MenuItem[] = []
  if (p.variant === 'detected-meeting' && p.micAppId) {
    settings.push({ label: `Turn off notifications for ${p.micAppName ?? 'this app'}`, action: 'mute_app_notifications' })
  }
  settings.push({ label: 'Change notification settings', action: 'open_settings' })
  settings[0] = { ...(settings[0] as MenuItem), separatorBefore: true }
  return [...items, ...settings]
}

export function NotificationCard(): JSX.Element | null {
  useSecondaryWindow('notification')
  const [p, setP] = useState<NotificationPayload | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [dx, setDx] = useState(0)
  const [settled, setSettled] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const swipe = useRef<{ x: number; id: number } | null>(null)
  const acted = useRef(false)

  // A recap that arrives after the card showed (`notify:last-time`, this card's window only).
  useEffect(
    () =>
      window.notula.notify.onLastTime(({ notificationId, lastTime }) =>
        setP((prev) => (prev && prev.id === notificationId ? { ...prev, lastTime } : prev))
      ),
    []
  )

  useEffect(() => {
    let alive = true
    void window.notula.notify
      .getPayload()
      .then((payload) => alive && setP(payload))
      .catch(() => undefined)
    const off = window.notula.notify.onAnimateOut(() => setLeaving(true))
    const t = window.setTimeout(() => setSettled(true), 260)
    return () => {
      alive = false
      off()
      clearTimeout(t)
    }
  }, [])

  const act = useCallback(
    (action: NotificationAction) => {
      if (!p || acted.current) return
      acted.current = true
      setLeaving(true)
      setMenuOpen(false)
      window.notula.notify.action({ id: p.id, action })
    },
    [p]
  )

  // The window follows the card's height.
  useEffect(() => {
    const el = cardRef.current
    if (!el || !p) return
    const report = (): void => window.notula.notify.reportHeight({ id: p.id, height: Math.ceil(el.offsetHeight) })
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [p])

  useEffect(() => {
    if (p) window.notula.notify.setMenuOpen({ id: p.id, open: menuOpen })
  }, [p, menuOpen])

  // The 20 s countdown, paused while hovered or while the menu is open. Elapsed
  // time is read from the clock, not counted in ticks: a throttled or late timer in this
  // always-on-top window stretched the countdown (a 20 s card hid after 36 s).
  const total = p?.countdownMs ?? null
  const paused = hovered || menuOpen || leaving
  const elapsedBefore = useRef(0)
  useEffect(() => {
    if (total === null || paused) return
    const base = elapsedBefore.current
    const from = Date.now()
    const t = window.setInterval(() => setElapsed(base + (Date.now() - from)), TICK_MS)
    return () => {
      clearInterval(t)
      elapsedBefore.current = base + (Date.now() - from)
    }
  }, [total, paused])
  useEffect(() => {
    if (total === null || elapsed < total) return
    // Auto-start clicks itself; any other mic-app card just goes away.
    act(p?.autoStart ? 'click' : 'hide')
  }, [elapsed, total, p, act])

  if (!p) return null
  const autoStarting = p.autoStart && total !== null && elapsed < total
  const joinable = p.variant === 'scheduled-meeting' && p.joinUrl !== null
  const provider = joinable ? providerOf(p.conferenceProvider) : null
  const line1 = joinable ? `Join ${provider?.label ?? 'Meeting'}` : 'Take notes'
  const line2 = joinable ? '& open Notula' : autoStarting ? 'Auto-starting...' : null
  const progress = total !== null ? Math.max(0, 1 - elapsed / total) : null

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (!settled || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    swipe.current = { x: e.clientX, id: e.pointerId }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (swipe.current?.id === e.pointerId) setDx(Math.max(0, e.clientX - swipe.current.x))
  }
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (swipe.current?.id !== e.pointerId) return
    swipe.current = null
    if (dx > SWIPE_DISMISS_PX) act('hide')
    else setDx(0)
  }

  return (
    <div className="nt-note-stage">
      <div
        ref={cardRef}
        className={`nt-note${leaving ? ' is-leaving' : ''}${dx ? ' is-swiping' : ''}`}
        style={dx && !leaving ? { transform: `translateX(${dx}px)`, opacity: Math.max(0.35, 1 - dx / 260) } : undefined}
        role="alertdialog"
        aria-label={p.title}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <button type="button" className="nt-note__close" aria-label="Dismiss notification" onClick={() => act('hide')}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
        <div className="nt-note__text">
          <div className="nt-note__title">
            {p.calendarColor ? <span className="nt-note__color" style={{ background: p.calendarColor }} aria-hidden="true" /> : null}
            <span className="nt-note__title-text">{p.title}</span>
          </div>
          <div className="nt-note__body">{p.body}</div>
          {/* A meaningful prep brief's headline. */}
          {p.detail ? (
            <div className="nt-note__detail" title={p.detail}>
              {p.detail}
            </div>
          ) : null}
          {/* The recap of last time in scheduled-meeting cards. */}
          {p.variant === 'scheduled-meeting' ? <LastTimeRecap notificationId={p.id} lastTime={p.lastTime} /> : null}
        </div>
        {/* An info card has its own buttons, and no join, start or settings menu. A source card
            draws its own buttons and menu. */}
        {p.variant === 'source-detected' ? (
          <SourceDetectedCard payload={p} act={act} />
        ) : p.variant === 'info' ? (
          <div className="nt-note__actions">
            {p.infoActions.map((a) => (
              <button key={a.id} type="button" className="nt-note__primary" onClick={() => act(`info:${a.id}`)}>
                <span className="nt-note__primary-label">
                  <span>{a.label}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="nt-note__actions">
            <button type="button" className="nt-note__primary" onClick={() => act('click')}>
              <span className="nt-note__primary-icon" aria-hidden="true">
                {provider?.icon ? <img className="nt-note__provider-icon" src={provider.icon} alt="" /> : <GlyphIcon />}
              </span>
              <span className="nt-note__primary-label">
                <span>{line1}</span>
                {line2 ? <span className="nt-note__primary-sub">{line2}</span> : null}
              </span>
            </button>
            <button
              type="button"
              className={`nt-note__more${menuOpen ? ' is-open' : ''}`}
              aria-label="More notification actions"
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
          </div>
        )}
        {progress !== null ? (
          <div className="nt-note__progress" aria-hidden="true">
            <span style={{ transform: `scaleX(${progress})` }} />
          </div>
        ) : null}
        {menuOpen && p.variant !== 'info' && p.variant !== 'source-detected' ? (
          <div className="nt-note__menu" role="menu">
            {menuItems(p, autoStarting).map((item) => (
              <div key={item.label}>
                {item.separatorBefore ? <div className="nt-note__sep" role="separator" /> : null}
                <button type="button" role="menuitem" className="nt-note__item" onClick={() => act(item.action)}>
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function GlyphIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 18V6l12 12V6" />
    </svg>
  )
}
