// SPDX-License-Identifier: Apache-2.0
// Action items: the `/action-items` page, its sidebar
// link (null while `actionItems.enabled` is off), and the summary-line thumbs and draft hosts.

import { createElement, type JSX } from 'react'
import { navigate, useRoute } from '../../app/navigation'
import { closeSidebarOverlay } from '../../app/sidebar-state'
import { usePrefs } from '../settings/prefs-store'

export { ActionItemsPage } from './ActionItemsPage'
export { ActionItemDrafts } from './Drafts'
export { ActionItemThumbs } from './Thumbs'

function IconChecklist({ size = 16 }: { size?: number }): JSX.Element {
  return createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    createElement('path', { d: 'M4 6.5l1.6 1.6L8.5 5.2M4 12.5l1.6 1.6 2.9-2.9M4 18.5l1.6 1.6 2.9-2.9M11.5 7h8.5M11.5 13h8.5M11.5 19h8.5' })
  )
}

/** The sidebar item after Recipes; hidden while the feature is off. */
export function SidebarActionItemsLink(): JSX.Element | null {
  const prefs = usePrefs()
  const { path } = useRoute()
  if (prefs?.['actionItems.enabled'] !== true) return null
  const active = path === '/action-items' || path.startsWith('/action-items/')
  return createElement(
    'button',
    {
      type: 'button',
      className: 'app-sidebar__item',
      'aria-current': active ? 'page' : undefined,
      onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
      onClick: () => {
        navigate('/action-items')
        closeSidebarOverlay()
      }
    },
    createElement(IconChecklist, { size: 16 }),
    createElement('span', { className: 'app-sidebar__label' }, 'Action Items')
  )
}
