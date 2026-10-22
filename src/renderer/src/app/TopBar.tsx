// SPDX-License-Identifier: Apache-2.0
import type { JSX, ReactNode } from 'react'
import { IconChevronLeft, IconSettings, NotulaMark } from './icons'
import { navigate, navigateToSettings } from './navigation'
import { useSidebar } from './sidebar-state'
import { SidebarToggle } from './Sidebar'
import './layout.css'

/**
 * The window's top bar: a left slot (brand or back) and a right slot (actions). While
 * the sidebar is hidden, the left slot starts with its toggle; the brand shows only
 * then, since the docked sidebar carries it.
 */
export function TopBar({ left, children }: { left?: ReactNode; children?: ReactNode }): JSX.Element {
  const sidebar = useSidebar()
  const hidden = !sidebar.docked && !sidebar.overlay
  return (
    <header className="topbar">
      <div className="topbar__left">
        {hidden ? <SidebarToggle label="Show sidebar" align="start" /> : null}
        {left ?? (hidden ? <Brand /> : null)}
      </div>
      <div className="topbar__right">{children}</div>
    </header>
  )
}

export function Brand(): JSX.Element {
  return (
    <span className="brand">
      <NotulaMark size={22} />
      <span className="brand__name">Notula</span>
    </span>
  )
}

export function BackButton({ label = 'Notes', to = '/' }: { label?: string; to?: string }): JSX.Element {
  return (
    <button type="button" className="n-btn n-btn--ghost topbar__back" onClick={() => navigate(to)}>
      <IconChevronLeft size={16} />
      {label}
    </button>
  )
}

export function SettingsButton(): JSX.Element {
  return (
    <span className="n-tooltip n-tooltip--end" data-tooltip="Settings">
      <button type="button" className="n-icon-btn" aria-label="Settings" onClick={() => navigateToSettings('preferences')}>
        <IconSettings size={18} />
      </button>
    </span>
  )
}

/** A routed page owned by another feature, framed with a back button. */
export function FramedPage({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="page">
      <TopBar left={<BackButton />} />
      <div className="page__scroll">{children}</div>
    </div>
  )
}
