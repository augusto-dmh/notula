// SPDX-License-Identifier: Apache-2.0
// About me: `/wiki` and its sidebar link (null while
// `userContext.enabled` is off).

import { createElement, type JSX } from 'react'
import { IconUser } from '../../app/icons'
import { navigate, useRoute } from '../../app/navigation'
import { closeSidebarOverlay } from '../../app/sidebar-state'
import { usePrefs } from '../settings/prefs-store'
import { UserContextPageView } from './UserContextPage'

export function UserContextPage(): JSX.Element {
  return createElement(UserContextPageView)
}

export function SidebarUserContextLink(): JSX.Element | null {
  const prefs = usePrefs()
  const { path } = useRoute()
  if (prefs?.['userContext.enabled'] !== true) return null
  const active = path === '/wiki' || path.startsWith('/wiki/')
  return createElement(
    'button',
    {
      type: 'button',
      className: 'app-sidebar__item',
      'aria-current': active ? 'page' : undefined,
      onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
      onClick: () => {
        navigate('/wiki')
        closeSidebarOverlay()
      }
    },
    createElement(IconUser, { size: 16 }),
    createElement('span', { className: 'app-sidebar__label' }, 'Wiki')
  )
}
