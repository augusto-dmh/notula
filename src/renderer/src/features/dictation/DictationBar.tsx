// SPDX-License-Identifier: Apache-2.0
// The dictation bar: the bar mode of the dictation
// pill window. Compact: the mic bubble, which rests as a 40 × 8 capsule and morphs into the bar
// on hover, with record (readiness dot, chevron sliding out on hover) and notes hanging off its
// right. Wide: the dictation pill's own content while dictating, or the recording bar (stop,
// elapsed time, open note) while a capture runs.
//
// - Click-through: every interactive part carries `data-hit`; their rectangles go to main
//   (`dictation-bar:hit-rects`) after each render and after each transition, and the hover
//   report (`dictation:pill-action` `hover`) is computed from the forwarded mouse moves against
//   the same rectangles, through a 100 ms hover lock.
// - Drag: horizontal, after a 3 px threshold (`dictation-bar:drag`); a drag never counts as a click.
//   Double-click on the bar (not a button) resets the position; right-click opens the menu.
// - Tooltips: label plus the bold keytip main sends (the user's current shortcut). 50 ms on a
//   button, 150 ms for the mic when the bar expands, at once when one is already showing; hidden
//   when the pointer leaves the bar.

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { DICTATION_BAR_LIMITS as BAR, type DictationBarAction, type DictationBarRect, type DictationBarState } from '@shared/types/dictation-bar'
import './dictation-bar.css'

/** `anchorX`: the opener's centre x, for the menu. */
function act(action: DictationBarAction, anchorX?: number): void {
  void window.notula.dictationBar.action(anchorX === undefined ? { action } : { action, anchorX }).catch(() => undefined)
}

/** The chevron: the menu opens centred on it. */
function openMenu(el: HTMLElement): void {
  const r = el.getBoundingClientRect()
  act('menu', r.left + r.width / 2)
}

const Icon = {
  mic: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="7" y="2.5" width="6" height="10" rx="3" fill="currentColor" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  ),
  record: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="6.25" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <circle cx="10" cy="10" r="3.25" fill="currentColor" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="5.5" y="5.5" width="9" height="9" rx="2" fill="currentColor" />
    </svg>
  ),
  notes: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="4" y="3" width="12" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M7 7.5h6M7 10.5h6M7 13.5h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6 12.5l4-4 4 4" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Tooltip offsets: above the button, inside the window. */
const TIP_GAP_PX = 4
const TIP_EDGE_PX = 12

/** The tooltip slides between buttons on macOS only; on Windows it jumps. */
const TIP_SLIDES = navigator.userAgent.includes('Mac')

interface Tip {
  id: string
  text: string
  keytip: string
  /** Centre x of the button, window-relative. */
  x: number
  /** Distance from the window's bottom edge. */
  bottom: number
}

function elapsed(since: string | null, now: number): string {
  if (!since) return '0:00'
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function DictationBarView({ bar, dictation }: { bar: DictationBarState; dictation: ReactNode | null }): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const tipEl = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settleAt = useRef(0)
  const anchors = useRef(new Map<string, { el: HTMLElement; text: string; keytip: string }>())
  const hovered = useRef(false)
  const hoverLock = useRef<{ until: number; timer: ReturnType<typeof setTimeout> | null }>({ until: 0, timer: null })
  const sentRects = useRef('')
  const drag = useRef<{ id: number; x: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const [now, setNow] = useState(() => Date.now())

  const hidden = bar.mode === 'hidden' && !dictation
  const recording = bar.mode === 'recording' && !dictation
  const compact = !dictation && !recording && !hidden && !(bar.mode === 'error' && bar.error)
  const ready = compact && bar.mode === 'ready'

  // The elapsed timer.
  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [recording])

  // Row 488: the rectangles go to main when they change. The bar morphs, so it is measured
  // again whenever a transition ends.
  const reportRects = (): void => {
    const el = root.current
    const rects: DictationBarRect[] = el
      ? [...el.querySelectorAll<HTMLElement>('[data-hit]')].map((n) => {
          const r = n.getBoundingClientRect()
          return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
        })
      : []
    const key = JSON.stringify(rects)
    if (key !== sentRects.current) {
      sentRects.current = key
      window.notula.dictationBar.reportHitRects({ rects })
    }
  }
  useLayoutEffect(reportRects)

  // Hover from the forwarded mouse moves. A change applies at once, then further changes wait
  // until the lock ends, so a cursor grazing the edge doesn't flicker the bar.
  useEffect(() => {
    let want = false
    const apply = (): void => {
      const lock = hoverLock.current
      if (want === hovered.current) return
      const t = performance.now()
      if (t < lock.until) {
        lock.timer ??= setTimeout(() => {
          lock.timer = null
          apply()
        }, lock.until - t)
        return
      }
      hovered.current = want
      lock.until = t + BAR.hoverLockMs
      window.notula.dictation.pillAction({ action: 'hover', hovered: want })
    }
    const report = (on: boolean): void => {
      want = on
      apply()
    }
    const inside = (x: number, y: number): boolean =>
      [...(root.current?.querySelectorAll<HTMLElement>('[data-hit]') ?? [])].some((n) => {
        const r = n.getBoundingClientRect()
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
      })
    const onMove = (e: MouseEvent): void => {
      if (drag.current) return
      report(inside(e.clientX, e.clientY))
    }
    const onLeave = (): void => {
      if (!drag.current) report(false)
    }
    document.addEventListener('mousemove', onMove)
    document.documentElement.addEventListener('mouseleave', onLeave)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      if (hoverLock.current.timer) clearTimeout(hoverLock.current.timer)
    }
  }, [])

  // ---------- tooltip ----------

  const hideTip = (): void => {
    if (tipTimer.current) clearTimeout(tipTimer.current)
    tipTimer.current = null
    setTip(null)
  }
  const measureTip = (id: string): Tip | null => {
    const a = anchors.current.get(id)
    if (!a || !a.el.isConnected) return null
    const r = a.el.getBoundingClientRect()
    return { id, text: a.text, keytip: a.keytip, x: r.left + r.width / 2, bottom: window.innerHeight - r.top + TIP_GAP_PX }
  }
  const openTip = (id: string, delay: number): void => {
    if (tipTimer.current) clearTimeout(tipTimer.current)
    tipTimer.current = null
    const fire = (): void => {
      // The picker buttons scale and open for one spring after the expand; measure them settled.
      const wait = id === 'dictate' ? 0 : settleAt.current - performance.now()
      if (wait > 0) {
        tipTimer.current = setTimeout(fire, wait)
        return
      }
      tipTimer.current = null
      setTip(measureTip(id))
    }
    if (tip) fire()
    else tipTimer.current = setTimeout(fire, delay)
  }
  const anchor = (id: string, text: string, keytip: string) => ({
    ref: (el: HTMLElement | null) => {
      if (el) anchors.current.set(id, { el, text, keytip })
      else anchors.current.delete(id)
    },
    onMouseEnter: () => {
      // The resting capsule shows no tooltip; the expand schedules the mic's own.
      if (!compact || ready) openTip(id, BAR.tooltipDelayMs)
    }
  })
  // A transition moved the buttons (the record button's chevron spring): follow the anchor.
  const onTransitionEnd = (): void => {
    reportRects()
    if (!tip) return
    const m = measureTip(tip.id)
    if (m && (Math.abs(m.x - tip.x) > 0.5 || Math.abs(m.bottom - tip.bottom) > 0.5)) setTip(m)
  }

  // The mic tooltip follows the expand; collapsing or leaving the compact bar clears it.
  useEffect(() => {
    if (ready) {
      settleAt.current = performance.now() + BAR.expandSettleMs
      openTip('dictate', BAR.bubbleTooltipDelayMs)
    } else hideTip()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])
  useEffect(() => {
    if (hidden) hideTip()
  }, [hidden])
  useEffect(() => () => {
    if (tipTimer.current) clearTimeout(tipTimer.current)
  }, [])

  // Centred on the button, kept 12 px inside the window.
  useLayoutEffect(() => {
    const el = tipEl.current
    if (!el || !tip) return
    const w = el.offsetWidth
    const left = Math.max(TIP_EDGE_PX, Math.min(window.innerWidth - TIP_EDGE_PX - w, tip.x - w / 2))
    el.style.left = `${Math.round(left)}px`
    el.style.bottom = `${Math.round(tip.bottom)}px`
  }, [tip])

  // ---------- drag (`dictation-bar:drag`) ----------

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    drag.current = { id: e.pointerId, x: e.screenX, moved: false }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = drag.current
    if (!g || g.id !== e.pointerId) return
    if (!g.moved) {
      if (Math.abs(e.screenX - g.x) < BAR.dragThresholdPx) return
      g.moved = true
      e.currentTarget.setPointerCapture(e.pointerId)
      hideTip()
      window.notula.dictationBar.drag({ phase: 'start', screenX: g.x })
    }
    window.notula.dictationBar.drag({ phase: 'move', screenX: e.screenX })
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = drag.current
    drag.current = null
    if (!g || !g.moved) return
    suppressClick.current = true
    window.notula.dictationBar.drag({ phase: 'end', screenX: e.screenX })
  }
  const onClickCapture = (e: { stopPropagation(): void; preventDefault(): void }): void => {
    if (!suppressClick.current) return
    suppressClick.current = false
    e.stopPropagation()
    e.preventDefault()
  }

  const button = (id: string, label: string, keytip: string, icon: JSX.Element, onClick: (el: HTMLElement) => void, extra?: ReactNode, cls = 'dbar-btn'): JSX.Element => (
    <button
      type="button"
      className={cls}
      aria-label={keytip ? `${label} (${keytip})` : label}
      {...anchor(id, label, keytip)}
      onClick={(e) => {
        e.stopPropagation()
        hideTip()
        onClick(e.currentTarget)
      }}
    >
      {icon}
      {extra}
    </button>
  )

  let content: ReactNode = null
  if (dictation) {
    content = dictation
  } else if (bar.mode === 'error' && bar.error) {
    content = (
      <div className="dict-pill dict-pill--error" data-hit="">
        <span className="dict-pill__text dict-pill__text--error" role="alert">
          {bar.error}
        </span>
      </div>
    )
  } else if (recording) {
    content = (
      <div className="dbar-pill dbar-pill--wide" data-hit="" {...barHandlers()}>
        {button('record', 'Stop recording', bar.shortcuts.record, Icon.stop, () => act('record'), null, 'dbar-btn dbar-btn--stop')}
        <span className="dbar-time" role="timer" aria-label="Recording time">
          <span className="dbar-live" aria-hidden="true" />
          {elapsed(bar.recordingSince, now)}
        </span>
        {button('notes', 'Open note', '', Icon.notes, () => act('notes'))}
        {button('menu', 'More', '', Icon.chevron, openMenu, null, 'dbar-btn dbar-btn--chevron')}
      </div>
    )
  } else if (compact) {
    content = (
      <div className={`dbar${ready ? ' is-ready' : ''}`} data-hit="" {...barHandlers()}>
        {ready ? <span className="dbar-slack" data-hit="" aria-hidden="true" /> : null}
        {button('dictate', 'Dictate', bar.shortcuts.dictate, ready ? Icon.mic : <></>, () => act('dictate'), null, 'dbar-bubble')}
        <div className="dbar-picks">
          <div className="dbar-rec">
            <span className="dbar-rec__pill">{button('menu', 'More', '', Icon.chevron, openMenu, null, 'dbar-chev')}</span>
            {button(
              'record',
              bar.captureReady === 'permission' ? 'Start recording (microphone access needed)' : 'Start recording',
              bar.shortcuts.record,
              Icon.record,
              () => act('record'),
              bar.captureReady === 'unavailable' ? null : <span className={`dbar-dot dbar-dot--${bar.captureReady}`} aria-hidden="true" />,
              'dbar-circle dbar-circle--rec'
            )}
          </div>
          {bar.notes ? button('notes', 'Scratchpad', '', Icon.notes, () => act('notes'), null, 'dbar-circle dbar-note') : null}
        </div>
      </div>
    )
  }

  function barHandlers(): Record<string, unknown> {
    return {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: () => (drag.current = null),
      onClickCapture,
      onMouseLeave: hideTip,
      onDoubleClick: (e: { target: EventTarget }) => {
        if (!(e.target as HTMLElement).closest('button')) act('reset-position')
      },
      // Right-click opens the menu, centred on the bar, only while the bar is expanded.
      onContextMenu: (e: { preventDefault(): void }) => {
        e.preventDefault()
        if (!ready) return
        hideTip()
        act('menu')
      }
    }
  }

  return (
    <div className="dict-pill-root dict-pill-root--bar" ref={root} onTransitionEnd={onTransitionEnd}>
      {tip ? (
        <div className={`dbar-tip${TIP_SLIDES ? ' dbar-tip--slide' : ''}`} role="tooltip" ref={tipEl}>
          <span>{tip.text}</span>
          {tip.keytip ? <strong className="dbar-tip__key">{tip.keytip}</strong> : null}
        </div>
      ) : null}
      {content}
    </div>
  )
}
