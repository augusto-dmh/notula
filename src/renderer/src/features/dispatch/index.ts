// SPDX-License-Identifier: Apache-2.0
// The dispatcher: `/dispatches`, its sidebar link (null while
// `dispatcher.enabled` is off) and "Run dispatcher" in the note's "…" menu.

import { createElement, type JSX } from 'react'
import { parseError } from '@shared/errors'
import { IconSparkle } from '../../app/icons'
import { navigate, useRoute } from '../../app/navigation'
import { closeSidebarOverlay } from '../../app/sidebar-state'
import { showToast } from '../../app/toast'
import { usePrefs } from '../settings/prefs-store'
import { DispatchesPageView } from './DispatchesPage'

export function DispatchesPage(): JSX.Element {
  return createElement(DispatchesPageView)
}

function IconSend({ size = 16 }: { size?: number }): JSX.Element {
  return createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    createElement('path', { d: 'M4 12l16-8-6 16-3-7-7-1z' })
  )
}

export function SidebarDispatchesLink(): JSX.Element | null {
  const prefs = usePrefs()
  const { path } = useRoute()
  if (prefs?.['dispatcher.enabled'] !== true) return null
  const active = path === '/dispatches' || path === '/dispatches/archived'
  return createElement(
    'button',
    {
      type: 'button',
      className: 'app-sidebar__item',
      'aria-current': active ? 'page' : undefined,
      onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
      onClick: () => {
        navigate('/dispatches')
        closeSidebarOverlay()
      }
    },
    createElement(IconSend, { size: 16 }),
    createElement('span', { className: 'app-sidebar__label' }, 'Dispatches')
  )
}

export function RunDispatcherMenuItem({ noteId }: { noteId: string }): JSX.Element | null {
  const prefs = usePrefs()
  if (prefs?.['dispatcher.enabled'] !== true || prefs['actionItems.enabled'] !== true) return null
  return createElement(
    'button',
    {
      type: 'button',
      role: 'menuitem',
      className: 'action-menu__item',
      onClick: (e: { currentTarget: HTMLElement }) => {
        // The host menu closes on Escape.
        e.currentTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        showToast({ id: `dispatch-${noteId}`, title: 'Running dispatcher...', kind: 'info' })
        window.notula.dispatch
          .runNote({ noteId })
          .then(() => showToast({ id: `dispatch-${noteId}`, title: 'Dispatcher finished', kind: 'success', action: { label: 'Open', onClick: () => navigate('/dispatches') } }))
          .catch((err: unknown) => showToast({ id: `dispatch-${noteId}`, title: 'Couldn’t run the dispatcher', description: parseError(err).message, kind: 'error' }))
      }
    },
    createElement('span', { className: 'action-menu__icon', 'aria-hidden': 'true' }, createElement(IconSparkle, { size: 15 })),
    createElement('span', { className: 'action-menu__label' }, 'Run dispatcher')
  )
}
