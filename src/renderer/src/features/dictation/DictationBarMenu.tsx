// SPDX-License-Identifier: Apache-2.0
// The dictation bar's menu: `#/dictation-bar-menu`, a transparent, non-focusable overlay over the
// bar's display. Main pushes the rows and the anchor
// (`dictation-bar:menu`); a row or a click outside the panel goes back as `dictation-bar:menu-pick`.
//
// - The panel opens upward from the anchor, centred on the opener and kept 8 px inside the
//   overlay, with a 150 ms rise. It closes at once.
// - A row with a submenu opens a side flyout on hover (closing 100 ms after the pointer leaves
//   the row and the flyout) or on click. The flyout sits 5 px past the row and shares its bottom.
// - No keyboard: the overlay never takes focus.

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { DictationBarMenu, DictationBarMenuEntry, DictationBarMenuIcon } from '@shared/types/dictation-bar'
import './dictation-bar-menu.css'

const EDGE_PX = 8
const FLYOUT_GAP_PX = 5
const FLYOUT_CLOSE_MS = 100

const stroke = { stroke: 'currentColor', strokeWidth: 1.5, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const ICONS: Record<DictationBarMenuIcon, JSX.Element> = {
  record: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" {...stroke} />
      <circle cx="8" cy="8" r="2.5" fill="currentColor" />
    </svg>
  ),
  stop: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" />
    </svg>
  ),
  mic: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" {...stroke} />
      <path d="M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2" {...stroke} />
    </svg>
  ),
  notes: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="2" width="10" height="12" rx="2" {...stroke} />
      <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" {...stroke} />
    </svg>
  ),
  snooze: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8.75" r="5" {...stroke} />
      <path d="M6 8.75l1.5 1.5 2.5-2.75M2.5 3.5l2-1.5M13.5 3.5l-2-1.5" {...stroke} />
    </svg>
  ),
  hide: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 8s2.25-4.25 6-4.25c1 0 1.9.3 2.65.75M14 8s-2.25 4.25-6 4.25c-1 0-1.9-.3-2.65-.75" {...stroke} />
      <path d="M6.6 9.4a2 2 0 0 1 2.8-2.8M2.5 13.5l11-11" {...stroke} />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2" {...stroke} />
      <path
        d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1.06 1.06M4.66 11.34L3.6 12.4M12.4 12.4l-1.06-1.06M4.66 4.66L3.6 3.6"
        {...stroke}
      />
      <circle cx="8" cy="8" r="4.25" {...stroke} />
    </svg>
  )
}

const CHECK = (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    <path d="M3 7.25l2.75 2.75L11 4.5" {...stroke} />
  </svg>
)

const CHEVRON_RIGHT = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6.5 4l4 4-4 4" {...stroke} />
  </svg>
)

function pick(id: string | null): void {
  window.notula.dictationBar.pickMenu({ id })
}

/** Keeps a panel `EDGE_PX` inside the overlay horizontally. */
function clampLeft(left: number, width: number): number {
  return Math.max(EDGE_PX, Math.min(window.innerWidth - EDGE_PX - width, left))
}

interface Flyout {
  id: string
  entries: DictationBarMenuEntry[]
  /** The row's right edge and bottom, overlay-relative. */
  right: number
  bottom: number
}

function Rows({ entries, open, onSub }: { entries: DictationBarMenuEntry[]; open?: string | null; onSub?: (e: DictationBarMenuEntry & { kind: 'item' }, el: HTMLElement, how: 'enter' | 'leave' | 'click') => void }): JSX.Element {
  return (
    <>
      {entries.map((e, i) =>
        e.kind === 'separator' ? (
          <div key={`sep-${i}`} className="dbm-sep" role="separator">
            <span />
          </div>
        ) : (
          <button
            key={e.id}
            type="button"
            role="menuitem"
            className={`dbm-row${e.checked ? ' is-checked' : ''}${open === e.id ? ' is-open' : ''}`}
            disabled={e.disabled}
            aria-haspopup={e.submenu ? 'menu' : undefined}
            aria-checked={e.checked}
            onMouseEnter={e.submenu ? (ev) => onSub?.(e, ev.currentTarget, 'enter') : undefined}
            onMouseLeave={e.submenu ? (ev) => onSub?.(e, ev.currentTarget, 'leave') : undefined}
            onClick={(ev) => {
              if (ev.button !== 0 || e.disabled) return
              if (e.submenu) onSub?.(e, ev.currentTarget, 'click')
              else pick(e.id)
            }}
          >
            {e.checked ? <span className="dbm-check">{CHECK}</span> : e.icon ? <span className="dbm-icon">{ICONS[e.icon]}</span> : null}
            <span className="dbm-label">{e.label}</span>
            {e.submenu ? <span className="dbm-icon dbm-more">{CHEVRON_RIGHT}</span> : null}
          </button>
        )
      )}
    </>
  )
}

function Panel({ menu }: { menu: DictationBarMenu }): JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const fly = useRef<HTMLDivElement>(null)
  const [flyout, setFlyout] = useState<Flyout | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const keep = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const release = (): void => {
    keep()
    closeTimer.current = setTimeout(() => setFlyout(null), FLYOUT_CLOSE_MS)
  }
  useEffect(() => keep, [])

  const onSub = (e: DictationBarMenuEntry & { kind: 'item' }, el: HTMLElement, how: 'enter' | 'leave' | 'click'): void => {
    if (how === 'leave') return release()
    keep()
    if (how === 'click' && flyout?.id === e.id) return setFlyout(null)
    const r = el.getBoundingClientRect()
    setFlyout({ id: e.id, entries: e.submenu ?? [], right: r.right, bottom: window.innerHeight - r.bottom })
  }

  useLayoutEffect(() => {
    const el = panel.current
    if (!el) return
    el.style.left = `${Math.round(clampLeft(menu.anchor.x - el.offsetWidth / 2, el.offsetWidth))}px`
    el.style.bottom = `${Math.round(menu.anchor.bottom)}px`
  }, [menu])

  useLayoutEffect(() => {
    const el = fly.current
    if (!el || !flyout) return
    el.style.left = `${Math.round(clampLeft(flyout.right + FLYOUT_GAP_PX, el.offsetWidth))}px`
    el.style.bottom = `${Math.round(flyout.bottom)}px`
  }, [flyout])

  return (
    <>
      <div className="dbm-panel dbm-panel--main" role="menu" ref={panel}>
        <Rows entries={menu.items} open={flyout?.id ?? null} onSub={onSub} />
      </div>
      {flyout ? (
        <div className="dbm-panel" role="menu" ref={fly} onMouseEnter={keep} onMouseLeave={release}>
          <Rows entries={flyout.entries} />
        </div>
      ) : null}
    </>
  )
}

export function DictationBarMenuView(): JSX.Element {
  const [menu, setMenu] = useState<DictationBarMenu | null>(null)
  // Each open remounts the panel, so the rise plays every time.
  const [opens, setOpens] = useState(0)

  useEffect(() => {
    document.documentElement.classList.add('dbm-doc')
    return window.notula.dictationBar.onMenu((m) => {
      setMenu(m.open ? m : null)
      if (m.open) setOpens((n) => n + 1)
    })
  }, [])

  return (
    <div
      className="dbm-root"
      onPointerDown={(e) => {
        if (menu && e.target === e.currentTarget) pick(null)
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu ? <Panel key={opens} menu={menu} /> : null}
    </div>
  )
}
