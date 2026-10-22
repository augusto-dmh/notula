// SPDX-License-Identifier: Apache-2.0
// NuxHost: mounted once in the main window's App, inside the
// onboarding and device-lock gates. While it is mounted tips may show (store.ts). It also draws the
// two tips that have no single host element:
// - `live-transcript` during a capture: a pointer at the transcript toggle until the transcript
//   is opened once;
// - `calendar-error`: a one-time modal when a calendar source has failed for 24 h. Dismissing it
//   holds until that source syncs again and then fails anew.
// Opening Settings ▸ Labs, from anywhere, ends the `labs` tip.

import { useEffect, useLayoutEffect, useState, type JSX } from 'react'
import type { CalendarSource } from '@shared/types/calendar'
import { navigateToSettings, useRoute } from '../../app/navigation'
import { anotherModalOpen, Modal } from '../folders/Modal'
import { IconX } from '../settings/icons'
import { usePrefs } from '../settings/prefs-store'
import { eligible } from './NuxTip'
import { claim, dismissTip, mountHost, release, useNuxVersion, visibleTip } from './store'
import { TIPS } from './tips'
import './nux.css'

const TOGGLE = '.nt-cap-wave[aria-pressed="false"]'
const POLL_MS = 1_500
const FAILING_MS = 24 * 60 * 60 * 1000

/** The transcript toggle's box while a capture runs and the transcript is closed. */
function useToggleAnchor(active: boolean): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!active) {
      setRect(null)
      return
    }
    let live = true
    const check = (): void => {
      const el = document.querySelector<HTMLElement>(TOGGLE)
      if (!el) {
        setRect(null)
        return
      }
      void window.notula.capture.getStatus().then(
        (s) => {
          if (!live) return
          const r = el.isConnected && s.capturing ? el.getBoundingClientRect() : null
          setRect((prev) => (prev && r && prev.x === r.x && prev.y === r.y ? prev : r))
        },
        () => live && setRect(null)
      )
    }
    check()
    const timer = window.setInterval(check, POLL_MS)
    window.addEventListener('resize', check)
    return () => {
      live = false
      window.clearInterval(timer)
      window.removeEventListener('resize', check)
    }
  }, [active])
  return rect
}

function LiveTranscriptPointer({ anchor }: { anchor: DOMRect }): JSX.Element {
  const copy = TIPS['live-transcript']
  const width = 260
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchor.left + anchor.width / 2 - 28))
  const arrow = Math.max(14, Math.min(width - 14, anchor.left + anchor.width / 2 - left))
  return (
    <div
      className="nux-pointer"
      role="note"
      aria-label={copy.title}
      style={{ left, bottom: window.innerHeight - anchor.top + 10, width, ['--nux-arrow' as string]: `${arrow}px` }}
    >
      <p className="nux-tip__title">{copy.title}</p>
      <p className="nux-tip__body">{copy.body}</p>
      <button type="button" className="nux-tip__close n-icon-btn n-icon-btn--sm" aria-label="Dismiss tip" onClick={() => dismissTip('live-transcript')}>
        <IconX size={14} />
      </button>
    </div>
  )
}

/** The first source failing for 24 h whose failure is newer than the last dismissal. */
function failingSource(sources: CalendarSource[], dismissedAt: string | undefined): CalendarSource | null {
  const now = Date.now()
  for (const s of sources) {
    if (s.status !== 'error') continue
    const okAt = Date.parse(s.lastSyncedAt ?? s.createdAt)
    if (Number.isNaN(okAt) || now - okAt < FAILING_MS) continue
    if (dismissedAt && Date.parse(dismissedAt) >= okAt) continue
    return s
  }
  return null
}

function CalendarErrorModal({ source, onClose }: { source: CalendarSource; onClose(open: boolean): void }): JSX.Element {
  const copy = TIPS['calendar-error']
  return (
    <Modal label={copy.title} className="nux-modal" onClose={() => onClose(false)}>
      <div className="h-modal__body">
        <h2 className="h-modal__title">{copy.title}</h2>
        <p className="nux-modal__text">
          Notula hasn’t been able to read <strong>{source.label}</strong> for a day, so upcoming meetings may be missing. You can reconnect it or
          check its link in Settings.
        </p>
        <div className="h-modal__footer">
          <button type="button" className="n-btn" onClick={() => onClose(false)}>
            Not now
          </button>
          <button type="button" className="n-btn n-btn--primary" data-autofocus onClick={() => onClose(true)}>
            {copy.action}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function useCalendarError(enabled: boolean, dismissedAt: string | undefined): CalendarSource | null {
  const [sources, setSources] = useState<CalendarSource[]>([])
  useEffect(() => {
    if (!enabled) return
    let live = true
    const read = (): void => {
      void window.notula.calendar.sources().then(
        (s) => live && setSources(s.sources),
        () => undefined
      )
    }
    read()
    const off = window.notula.calendar.onChanged(read)
    const timer = window.setInterval(read, 30 * 60 * 1000)
    return () => {
      live = false
      off()
      window.clearInterval(timer)
    }
  }, [enabled])
  return enabled ? failingSource(sources, dismissedAt) : null
}

export function NuxHostView(): JSX.Element | null {
  useLayoutEffect(() => mountHost(), [])
  useNuxVersion()
  const prefs = usePrefs()
  const { path } = useRoute()

  useEffect(() => {
    if (path.startsWith('/settings/labs') && prefs && !prefs['nux.dismissed']['labs']) dismissTip('labs')
  }, [path, prefs])

  const pointerOk = eligible('live-transcript', prefs)
  const anchor = useToggleAnchor(pointerOk)
  useEffect(() => {
    if (!anchor) return
    claim('live-transcript')
    return () => release('live-transcript')
  }, [anchor])

  const calendarOk = !!prefs && prefs['nux.enabled']
  const failing = useCalendarError(calendarOk, prefs?.['nux.dismissed']['calendar-error'])
  const [modalBlocked, setModalBlocked] = useState(false)
  useEffect(() => {
    if (!failing) return
    setModalBlocked(anotherModalOpen())
    claim('calendar-error')
    return () => release('calendar-error')
  }, [failing])

  const visible = visibleTip()
  if (anchor && visible === 'live-transcript') return <LiveTranscriptPointer anchor={anchor} />
  if (failing && visible === 'calendar-error' && !modalBlocked) {
    return (
      <CalendarErrorModal
        source={failing}
        onClose={(open) => {
          // A new failure later shows it again, so main records the time, not a final "done".
          window.notula.nux.dismiss({ id: 'calendar-error' })
          release('calendar-error')
          setModalBlocked(true)
          if (open) navigateToSettings('calendar')
        }}
      />
    )
  }
  return null
}
