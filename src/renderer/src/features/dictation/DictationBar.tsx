// SPDX-License-Identifier: Apache-2.0
// The dictation bar: the bar mode of the dictation pill
// window. Compact: mic, record (with the readiness dot) and notes, plus the menu chevron. Wide:
// the dictation pill's own content while dictating, or the recording bar (stop, elapsed time,
// open note) while a capture runs.
//
// - Click-through: every interactive part carries `data-hit`; their rectangles go to main
//   (`dictation-bar:hit-rects`) after each render, and the hover report
//   (`dictation:pill-action` `hover`) is computed from the
//   forwarded mouse moves against the same rectangles.
// - Drag: horizontal, after a 3 px threshold (`dictation-bar:drag`); a drag never counts as a click.
//   Double-click on the bar (not a button) resets the position; right-click opens the menu.
// - Tooltips: label plus the bold keytip main sends (the user's current shortcut), after 400 ms.

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { DICTATION_BAR_LIMITS as BAR, type DictationBarAction, type DictationBarRect, type DictationBarState } from '@shared/types/dictation-bar'
import './dictation-bar.css'

function act(action: DictationBarAction): void {
  void window.notula.dictationBar.action({ action }).catch(() => undefined)
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

interface Tip {
  id: string
  text: string
  keytip: string
  /** Centre x of the button, window-relative. */
  x: number
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
  const [tip, setTip] = useState<Tip | null>(null)
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hovered = useRef(false)
  const sentRects = useRef('')
  const drag = useRef<{ id: number; x: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const [now, setNow] = useState(() => Date.now())

  const hidden = bar.mode === 'hidden' && !dictation
  const recording = bar.mode === 'recording' && !dictation

  // The elapsed timer.
  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [recording])

  // Row 488 after every render whose rectangles changed.
  useLayoutEffect(() => {
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
  })

  // Hover from the forwarded mouse moves.
  useEffect(() => {
    const report = (on: boolean): void => {
      if (on === hovered.current) return
      hovered.current = on
      window.notula.dictation.pillAction({ action: 'hover', hovered: on })
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
    }
  }, [])

  useEffect(() => {
    if (hidden) setTip(null)
  }, [hidden])

  const showTip = (id: string, text: string, keytip: string) => (e: { currentTarget: HTMLElement }) => {
    if (tipTimer.current) clearTimeout(tipTimer.current)
    const r = e.currentTarget.getBoundingClientRect()
    const x = r.left + r.width / 2
    tipTimer.current = setTimeout(() => setTip({ id, text, keytip, x }), BAR.tooltipDelayMs)
  }
  const hideTip = (): void => {
    if (tipTimer.current) clearTimeout(tipTimer.current)
    tipTimer.current = null
    setTip(null)
  }

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

  const button = (id: string, label: string, keytip: string, icon: JSX.Element, onClick: () => void, extra?: ReactNode, cls = ''): JSX.Element => (
    <button
      type="button"
      className={`dbar-btn ${cls}`}
      aria-label={keytip ? `${label} (${keytip})` : label}
      onMouseEnter={showTip(id, label, keytip)}
      onMouseLeave={hideTip}
      onClick={(e) => {
        e.stopPropagation()
        hideTip()
        onClick()
      }}
    >
      {icon}
      {extra}
    </button>
  )

  const chevron = button('menu', 'More', '', Icon.chevron, () => act('menu'), null, 'dbar-btn--chevron')

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
        {button('record', 'Stop recording', bar.shortcuts.record, Icon.stop, () => act('record'), null, 'dbar-btn--stop')}
        <span className="dbar-time" role="timer" aria-label="Recording time">
          <span className="dbar-live" aria-hidden="true" />
          {elapsed(bar.recordingSince, now)}
        </span>
        {button('notes', 'Open note', '', Icon.notes, () => act('notes'))}
        {chevron}
      </div>
    )
  } else if (!hidden) {
    content = (
      <div className={`dbar-pill dbar-pill--${bar.mode === 'ready' ? 'ready' : 'resting'}`} data-hit="" {...barHandlers()}>
        {button('dictate', 'Dictate', bar.shortcuts.dictate, Icon.mic, () => act('dictate'))}
        {button(
          'record',
          bar.captureReady === 'permission' ? 'Start recording (microphone access needed)' : 'Start recording',
          bar.shortcuts.record,
          Icon.record,
          () => act('record'),
          bar.captureReady === 'unavailable' ? null : <span className={`dbar-dot dbar-dot--${bar.captureReady}`} aria-hidden="true" />
        )}
        {bar.notes ? button('notes', 'Scratchpad', '', Icon.notes, () => act('notes')) : null}
        {chevron}
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
      onDoubleClick: (e: { target: EventTarget }) => {
        if (!(e.target as HTMLElement).closest('button')) act('reset-position')
      },
      onContextMenu: (e: { preventDefault(): void }) => {
        e.preventDefault()
        hideTip()
        act('menu')
      }
    }
  }

  return (
    <div className="dict-pill-root dict-pill-root--bar" ref={root}>
      {tip ? (
        <div className="dbar-tip" role="tooltip" style={{ left: tip.x }}>
          <span>{tip.text}</span>
          {tip.keytip ? <strong className="dbar-tip__key">{tip.keytip}</strong> : null}
        </div>
      ) : null}
      {content}
    </div>
  )
}
